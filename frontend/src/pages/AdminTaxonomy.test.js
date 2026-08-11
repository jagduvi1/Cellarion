import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import AdminTaxonomy from './AdminTaxonomy';

// Grape regional-names audit LOWs (2026-08-11), admin taxonomy page:
//  1. the per-country region cache must start COLD on every tab entry — a
//     region created on the Regions tab has to appear when returning to
//     Grapes (previously the stale cache hid it until a full reload);
//  2. a row whose saved region is missing from the loaded list (fetch failed
//     or stale) must SHOW that saved region as an explicit option instead of
//     silently displaying "Whole country" while still submitting the region,
//     and the failed fetch must surface through the page error;
//  3. a successful save that returns regionalNameWarnings shows them as a
//     warning (never styled as a failure).

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, opts) => (opts && opts.count !== undefined ? `${key}:${opts.count}` : key),
  }),
}));

const apiFetch = vi.fn();
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ apiFetch }) }));

// Child components with their own data needs are stubbed — this suite tests
// the page's cache/select/warning behavior, not the pickers.
vi.mock('../components/GrapePicker', () => ({ default: () => null }));
vi.mock('../components/BottleSizesAdmin', () => ({ default: () => null }));
vi.mock('../components/AppellationUnmatchedModal', () => ({ default: () => null }));

const getTaxonomy = vi.fn();
const getCountries = vi.fn();
const getGrapes = vi.fn();
const getRegions = vi.fn();
const updateTaxonomy = vi.fn();
vi.mock('../api/admin', () => ({
  adminGetTaxonomy: (...a) => getTaxonomy(...a),
  adminGetCountries: (...a) => getCountries(...a),
  adminGetGrapes: (...a) => getGrapes(...a),
  adminGetRegions: (...a) => getRegions(...a),
  adminCreateTaxonomy: vi.fn(),
  adminUpdateTaxonomy: (...a) => updateTaxonomy(...a),
  adminDeleteTaxonomy: vi.fn(),
  adminMergeTaxonomy: vi.fn(),
  adminApproveRegion: vi.fn(),
}));

const jsonRes = (body, ok = true) => ({ ok, json: () => Promise.resolve(body) });

const PORTUGAL = 'a'.repeat(24);
const DOURO = 'b'.repeat(24);

const grapeItem = () => ({
  _id: 'g1',
  name: 'Tempranillo',
  synonyms: [],
  color: null,
  wineCount: 0,
  regionalNames: [{ country: PORTUGAL, region: DOURO, name: 'Tinta Roriz' }],
});

beforeEach(() => {
  vi.clearAllMocks();
  getTaxonomy.mockImplementation((_af, endpoint) => {
    if (endpoint.endsWith('/grapes')) return Promise.resolve(jsonRes({ grapes: [grapeItem()] }));
    if (endpoint.endsWith('/regions')) return Promise.resolve(jsonRes({ regions: [] }));
    if (endpoint.endsWith('/appellations')) return Promise.resolve(jsonRes({ appellations: [] }));
    return Promise.resolve(jsonRes({ countries: [] }));
  });
  getCountries.mockResolvedValue(jsonRes({ countries: [{ _id: PORTUGAL, name: 'Portugal' }] }));
  getGrapes.mockResolvedValue(jsonRes({ grapes: [] }));
  getRegions.mockResolvedValue(jsonRes({ regions: [{ _id: DOURO, name: 'Douro' }] }));
});

const openGrapeEditor = async () => {
  fireEvent.click(screen.getByRole('button', { name: 'admin.taxonomy.grapes' }));
  await waitFor(() => expect(screen.getByText('Tempranillo')).toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: 'common.edit' }));
};

test('the per-country region cache resets on tab switch — regions are refetched on the next edit', async () => {
  render(<AdminTaxonomy />);
  await openGrapeEditor();
  await waitFor(() => expect(getRegions).toHaveBeenCalledTimes(1));
  // The loaded list renders the real region option.
  await screen.findByRole('option', { name: 'Douro' });

  // Away (where a region could be created) and back — the cache must be cold.
  fireEvent.click(screen.getByRole('button', { name: 'admin.taxonomy.regions' }));
  await waitFor(() => expect(screen.queryByText('Tempranillo')).not.toBeInTheDocument());
  await openGrapeEditor();

  // Without the reset, loadRegionsForCountry short-circuits on the warm cache
  // and a region created meanwhile stays invisible until a full page reload.
  await waitFor(() => expect(getRegions).toHaveBeenCalledTimes(2));
});

test('a failed region fetch surfaces an error AND the saved region stays visible as its own option', async () => {
  getRegions.mockRejectedValue(new Error('network'));
  render(<AdminTaxonomy />);
  await openGrapeEditor();

  // The failure is said out loud through the page's error surface…
  await waitFor(() =>
    expect(screen.getByText('admin.taxonomy.regionsLoadFailed')).toBeInTheDocument()
  );

  // …and the select tells the truth: its value is the SAVED region, rendered
  // via the fallback option — not "Whole country" while submitting the region.
  const regionSelect = screen.getByLabelText('admin.taxonomy.appellationRegionLabel');
  expect(regionSelect.value).toBe(DOURO);
  expect(
    screen.getByRole('option', { name: 'admin.taxonomy.savedRegionUnavailable' })
  ).toBeInTheDocument();
});

test('the saved-region fallback option disappears once the loaded list contains the region', async () => {
  render(<AdminTaxonomy />);
  await openGrapeEditor();
  await screen.findByRole('option', { name: 'Douro' });

  const regionSelect = screen.getByLabelText('admin.taxonomy.appellationRegionLabel');
  expect(regionSelect.value).toBe(DOURO);
  expect(screen.queryByRole('option', { name: 'admin.taxonomy.savedRegionUnavailable' })).toBeNull();
});

test('regionalNameWarnings from a successful save render as a warning, not a failure', async () => {
  const warning =
    "'Tinta Roriz' is not a synonym of Tempranillo — curators cannot write it back via set_wine_profile; add it as a synonym too";
  updateTaxonomy.mockResolvedValue(jsonRes({ grape: grapeItem(), regionalNameWarnings: [warning] }));

  const { container } = render(<AdminTaxonomy />);
  await openGrapeEditor();
  await screen.findByRole('option', { name: 'Douro' });

  // Submit the edit form (fireEvent.submit — jsdom's click-to-submit varies
  // by version; the submit event itself is what handleUpdate listens to).
  fireEvent.submit(screen.getByRole('button', { name: 'common.save' }).closest('form'));

  await waitFor(() => expect(screen.getByText('admin.taxonomy.savedWithWarnings')).toBeInTheDocument());
  expect(screen.getByText(warning)).toBeInTheDocument();
  // Warning styling, not the error alert.
  expect(container.querySelector('.alert-warning')).not.toBeNull();
  expect(container.querySelector('.alert-error')).toBeNull();
});
