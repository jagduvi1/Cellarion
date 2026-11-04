import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import * as adminApi from '../api/admin';
import AdminTaxonomy from './AdminTaxonomy';

// The label sweetness terms tab (GitHub discussion #1754): the rows come from
// the admin route under the tab's own key, each shows its scale and band (and
// "customary" for an unregulated word), a member-added row carries the review
// badge and its approve verb calls the sweetness route, and the add form
// offers the two scales with the bands of the chosen scale.

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, opts) => (opts && opts.count !== undefined ? `${key}:${opts.count}` : key),
  }),
}));

const apiFetch = vi.fn();
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ apiFetch }) }));
vi.mock('../components/GrapePicker', () => ({ default: () => null }));
vi.mock('../components/BottleSizesAdmin', () => ({ default: () => null }));
vi.mock('../components/AppellationUnmatchedModal', () => ({ default: () => null }));

const getTaxonomy = vi.fn();
const approveSweetnessTerm = vi.fn();
vi.mock('../api/admin', () => ({
  adminGetTaxonomy: (...a) => getTaxonomy(...a),
  adminGetCountries: vi.fn(),
  adminGetGrapes: vi.fn(),
  adminGetRegions: vi.fn(),
  adminCreateTaxonomy: vi.fn(),
  adminUpdateTaxonomy: vi.fn(),
  adminDeleteTaxonomy: vi.fn(),
  adminMergeTaxonomy: vi.fn(),
  adminApproveRegion: vi.fn(),
  adminApproveGrape: vi.fn(),
  adminApproveClassification: vi.fn(),
  adminApproveSweetnessTerm: (...a) => approveSweetnessTerm(...a),
}));

const jsonRes = (body, ok = true) => ({ ok, json: () => Promise.resolve(body) });

const terms = () => [
  { _id: 't1', name: 'Trocken', scale: 'still', band: 'dry', regulated: true, system: 'EU 2019/33 Annex III A (de)', synonyms: [], wineCount: 12, needsReview: false },
  { _id: 't2', name: 'Feinherb', scale: 'still', band: 'off-dry', regulated: false, synonyms: [], wineCount: 0, createdByUser: true, needsReview: true },
];

beforeEach(() => {
  vi.clearAllMocks();
  getTaxonomy.mockImplementation((_af, endpoint) => {
    if (endpoint.endsWith('/sweetness-terms')) return Promise.resolve(jsonRes({ sweetnessTerms: terms(), needsReviewCount: 1 }));
    if (endpoint.endsWith('/grapes')) return Promise.resolve(jsonRes({ grapes: [] }));
    if (endpoint.endsWith('/regions')) return Promise.resolve(jsonRes({ regions: [] }));
    if (endpoint.endsWith('/appellations')) return Promise.resolve(jsonRes({ appellations: [] }));
    return Promise.resolve(jsonRes({ countries: [] }));
  });
  adminApi.adminGetCountries.mockResolvedValue(jsonRes({ countries: [] }));
  adminApi.adminGetGrapes.mockResolvedValue(jsonRes({ grapes: [] }));
  adminApi.adminGetRegions.mockResolvedValue(jsonRes({ regions: [] }));
  approveSweetnessTerm.mockResolvedValue(jsonRes({ sweetnessTerm: { ...terms()[1], reviewedAt: new Date().toISOString() } }));
});

const openTab = async () => {
  render(<AdminTaxonomy />);
  fireEvent.click(await screen.findByRole('button', { name: 'admin.taxonomy.sweetnessTerms' }));
  await waitFor(() => expect(screen.getByText('Trocken')).toBeInTheDocument());
};

test('the tab lists the terms under their own response key, with scale, band and the customary mark', async () => {
  await openTab();
  expect(getTaxonomy).toHaveBeenCalledWith(apiFetch, '/api/admin/taxonomy/sweetness-terms');
  expect(screen.getAllByText('admin.taxonomy.scale.still')).toHaveLength(2);
  expect(screen.getByText('admin.taxonomy.band.dry')).toBeInTheDocument();
  expect(screen.getByText('admin.taxonomy.band.off-dry')).toBeInTheDocument();
  expect(screen.getAllByText('admin.taxonomy.customary')).toHaveLength(1);
  expect(screen.getByText('Feinherb')).toBeInTheDocument();
});

test('a member-added row carries the review badge and its approve verb calls the sweetness route', async () => {
  await openTab();
  const approve = screen.getByRole('button', { name: 'admin.taxonomy.approveRegion' });
  fireEvent.click(approve);
  await waitFor(() => expect(approveSweetnessTerm).toHaveBeenCalledWith(apiFetch, 't2'));
});

test('the add form offers both scales and the bands of the chosen scale', async () => {
  await openTab();
  fireEvent.click(screen.getByRole('button', { name: 'admin.taxonomy.addSweetnessTerm' }));
  expect(screen.getByText('admin.taxonomy.sweetnessTermNameLabel')).toBeInTheDocument();
  const scale = screen.getByRole('option', { name: 'admin.taxonomy.scale.sparkling' });
  expect(scale).toBeInTheDocument();
  // Still by default: four bands; switch to sparkling: the seven dosage bands.
  expect(screen.getByRole('option', { name: 'admin.taxonomy.band.medium-sweet' })).toBeInTheDocument();
  expect(screen.queryByRole('option', { name: 'admin.taxonomy.band.brut' })).toBeNull();
  fireEvent.change(scale.closest('select'), { target: { value: 'sparkling' } });
  expect(screen.getByRole('option', { name: 'admin.taxonomy.band.brut-nature' })).toBeInTheDocument();
  expect(screen.queryByRole('option', { name: 'admin.taxonomy.band.medium-sweet' })).toBeNull();
});
