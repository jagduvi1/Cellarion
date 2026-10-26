import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// The admin wine form had no classification field at all (GitHub discussion
// #1696): a curator could set every identity field but the quality tier. The
// field sends what was typed; the server normalises it (a regulatory mark
// such as DOCG stores as no classification).

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
  adminGetCountries: async () => jsonRes({ countries: [{ _id: 'c1', name: 'Italy' }] }),
  adminGetGrapes: async () => jsonRes({ grapes: [] }),
  adminGetRegions: async () => jsonRes({ regions: [] }),
  adminGetAppellations: async () => jsonRes({ appellations: [] }),
  adminGetWineProposals: async () => jsonRes({ pendingCount: 0 }),
  adminGetOwnerInquiries: async () => jsonRes({ pendingCount: 0 }),
  adminSaveWine: (...a) => saveWine(...a),
}));

const AdminWines = (await import('./AdminWines')).default;

beforeEach(() => {
  vi.clearAllMocks();
  // After a create the drawer flips to edit mode and loads the wine's images.
  apiFetch.mockResolvedValue(jsonRes({ images: [] }));
  saveWine.mockResolvedValue(jsonRes({ wine: { _id: 'w1', name: 'Barolo', producer: 'Azelia', grapes: [] } }));
});

test('the add form carries a classification field and sends it with the wine', async () => {
  render(<AdminWines />);
  fireEvent.click(await screen.findByText('admin.wines.newWine'));

  const field = await screen.findByPlaceholderText('Riserva, Grand Cru Classé, Cru Bourgeois, Spätlese…');
  expect(screen.getByText(/A quality tier on top of the appellation/)).toBeInTheDocument();

  const inputs = document.querySelectorAll('#wine-form input[type="text"]');
  fireEvent.change(inputs[0], { target: { value: 'Barolo' } });
  fireEvent.change(inputs[1], { target: { value: 'Azelia' } });
  fireEvent.change(field, { target: { value: '  Riserva ' } });
  fireEvent.submit(document.getElementById('wine-form'));

  await waitFor(() => expect(saveWine).toHaveBeenCalledTimes(1));
  const payload = saveWine.mock.calls[0][1];
  expect(payload.classification).toBe('Riserva');
  expect(payload.name).toBe('Barolo');
  expect(saveWine.mock.calls[0][2]).toBeUndefined(); // a create, not an edit
});

test('an empty classification is sent as null, not an empty string', async () => {
  render(<AdminWines />);
  fireEvent.click(await screen.findByText('admin.wines.newWine'));
  await screen.findByPlaceholderText('Riserva, Grand Cru Classé, Cru Bourgeois, Spätlese…');
  fireEvent.submit(document.getElementById('wine-form'));

  await waitFor(() => expect(saveWine).toHaveBeenCalledTimes(1));
  expect(saveWine.mock.calls[0][1].classification).toBeNull();
});
