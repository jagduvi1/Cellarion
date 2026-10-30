import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// The admin wine form's classification is a picker over the classification
// taxonomy (support ticket 2026-10-29): the tiers the registry knows, the
// selected country's own plus the country-less ones, sent as row ids. The
// server derives the string the registry shows from the rows.

vi.mock('react-i18next', () => {
  const t = (key, fallback) => (typeof fallback === 'string' ? fallback : key);
  return { useTranslation: () => ({ t }) };
});

const apiFetch = vi.fn();
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ apiFetch }) }));

const saveWine = vi.fn();
const jsonRes = (body) => ({ ok: true, status: 200, json: () => Promise.resolve(body) });
vi.mock('../api/admin', async (importOriginal) => ({
  ...(await importOriginal()),
  adminGetWines: async () => jsonRes({ wines: [], total: 0, pages: 1 }),
  adminGetCountries: async () => jsonRes({ countries: [{ _id: 'c1', name: 'Italy' }, { _id: 'c2', name: 'Germany' }] }),
  adminGetGrapes: async () => jsonRes({ grapes: [] }),
  adminGetRegions: async () => jsonRes({ regions: [] }),
  adminGetAppellations: async () => jsonRes({ appellations: [] }),
  adminGetWineProposals: async () => jsonRes({ pendingCount: 0 }),
  adminGetOwnerInquiries: async () => jsonRes({ pendingCount: 0 }),
  adminSaveWine: (...a) => saveWine(...a),
}));
vi.mock('../api/taxonomy', () => ({
  getClassifications: async () => jsonRes({ classifications: [
    { _id: 'k1', name: 'Riserva', kind: 'ageing', country: { _id: 'c1', name: 'Italy' }, synonyms: [] },
    { _id: 'k2', name: 'Spätlese', kind: 'ripeness', country: null, synonyms: [] },
    { _id: 'k3', name: 'VDP Grosse Lage', kind: 'vineyard_rank', country: { _id: 'c2', name: 'Germany' }, synonyms: [] },
  ] }),
}));

const AdminWines = (await import('./AdminWines')).default;

beforeEach(() => {
  vi.clearAllMocks();
  // After a create the drawer flips to edit mode and loads the wine's images.
  apiFetch.mockResolvedValue(jsonRes({ images: [] }));
  saveWine.mockResolvedValue(jsonRes({ wine: { _id: 'w1', name: 'Barolo', producer: 'Azelia', grapes: [] } }));
});

test('the add form offers the taxonomy tiers and sends the chosen rows as ids', async () => {
  render(<AdminWines />);
  fireEvent.click(await screen.findByText('admin.wines.newWine'));

  await screen.findByPlaceholderText('Search the classification tiers…');
  expect(screen.getByText(/A quality tier on top of the appellation/)).toBeInTheDocument();

  const inputs = document.querySelectorAll('#wine-form input[type="text"]');
  fireEvent.change(inputs[0], { target: { value: 'Barolo' } });
  fireEvent.change(inputs[1], { target: { value: 'Azelia' } });
  fireEvent.click(await screen.findByRole('button', { name: /Riserva/ }));
  fireEvent.submit(document.getElementById('wine-form'));

  await waitFor(() => expect(saveWine).toHaveBeenCalledTimes(1));
  const payload = saveWine.mock.calls[0][1];
  expect(payload.classifications).toEqual(['k1']);
  expect(payload.classification).toBeUndefined();
  expect(payload.name).toBe('Barolo');
  expect(saveWine.mock.calls[0][2]).toBeUndefined(); // a create, not an edit
});

test('nothing chosen is sent as an empty list', async () => {
  render(<AdminWines />);
  fireEvent.click(await screen.findByText('admin.wines.newWine'));
  await screen.findByPlaceholderText('Search the classification tiers…');
  fireEvent.submit(document.getElementById('wine-form'));

  await waitFor(() => expect(saveWine).toHaveBeenCalledTimes(1));
  expect(saveWine.mock.calls[0][1].classifications).toEqual([]);
});

test('a chosen country narrows the picker to its own tiers and the country-less ones', async () => {
  render(<AdminWines />);
  fireEvent.click(await screen.findByText('admin.wines.newWine'));
  await screen.findByPlaceholderText('Search the classification tiers…');
  expect(screen.getByRole('button', { name: /VDP Grosse Lage/ })).toBeInTheDocument();

  const country = document.querySelector('#wine-form select');
  fireEvent.change(country, { target: { value: 'c1' } });
  await waitFor(() => expect(screen.queryByRole('button', { name: /VDP Grosse Lage/ })).not.toBeInTheDocument());
  expect(screen.getByRole('button', { name: /Riserva/ })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Spätlese/ })).toBeInTheDocument();
});
