import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import AdminTaxonomy from './AdminTaxonomy';

// A tab whose list fails to load must show an empty list and the error — the
// previous tab's rows must not stay on screen under the new tab's label, where
// Edit / Delete / Merge / Approve would send their ids to the wrong collection.

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
vi.mock('../api/admin', () => ({
  adminGetTaxonomy: (...a) => getTaxonomy(...a),
  adminGetCountries: () => Promise.resolve(jsonRes({ countries: [] })),
  adminGetGrapes: () => Promise.resolve(jsonRes({ grapes: [] })),
  adminGetRegions: () => Promise.resolve(jsonRes({ regions: [] })),
  adminCreateTaxonomy: vi.fn(),
  adminUpdateTaxonomy: vi.fn(),
  adminDeleteTaxonomy: vi.fn(),
  adminMergeTaxonomy: vi.fn(),
  adminApproveRegion: vi.fn(),
  adminApproveGrape: vi.fn(),
}));

const jsonRes = (body, ok = true, status = ok ? 200 : 500) => ({ ok, status, json: () => Promise.resolve(body) });

const grape = { _id: 'g1', name: 'Tempranillo', synonyms: [], color: null, wineCount: 0, needsReview: true };

beforeEach(() => {
  vi.clearAllMocks();
  getTaxonomy.mockImplementation((_af, endpoint) => {
    if (endpoint.endsWith('/grapes')) return Promise.resolve(jsonRes({ grapes: [grape], needsReviewCount: 1 }));
    return Promise.resolve(jsonRes({ countries: [] }));
  });
});

const showGrapes = async () => {
  fireEvent.click(screen.getByRole('button', { name: 'admin.taxonomy.grapes' }));
  await screen.findByText('Tempranillo');
  expect(screen.getByText('admin.taxonomy.needsReview:1')).toBeInTheDocument();
};

test('a refused tab load clears the previous tab\'s rows and shows the server\'s error', async () => {
  render(<AdminTaxonomy />);
  await showGrapes();

  getTaxonomy.mockImplementation(() => Promise.resolve(jsonRes({ error: 'boom' }, false)));
  fireEvent.click(screen.getByRole('button', { name: 'admin.taxonomy.regions' }));

  await screen.findByText('boom');
  expect(screen.queryByText('Tempranillo')).toBeNull();
  expect(screen.queryByRole('button', { name: 'admin.taxonomy.approveRegion' })).toBeNull();
  expect(screen.getByText('admin.taxonomy.noItems')).toBeInTheDocument();
  // The review count belonged to the grapes list; nothing is known about regions.
  expect(screen.queryByText('admin.taxonomy.needsReview:1')).toBeNull();
});

test('a tab load that never reaches the server clears the previous tab\'s rows', async () => {
  render(<AdminTaxonomy />);
  await showGrapes();

  getTaxonomy.mockImplementation(() => Promise.reject(new TypeError('Failed to fetch')));
  fireEvent.click(screen.getByRole('button', { name: 'admin.taxonomy.regions' }));

  await screen.findByText('Failed to load data');
  expect(screen.queryByText('Tempranillo')).toBeNull();
  expect(screen.getByText('admin.taxonomy.noItems')).toBeInTheDocument();
  expect(screen.queryByText('admin.taxonomy.needsReview:1')).toBeNull();
});
