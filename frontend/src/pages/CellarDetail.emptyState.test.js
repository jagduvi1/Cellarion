import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import CellarDetail from './CellarDetail';

// An empty cellar offers import next to "Add your first bottle" (import is how
// big collections arrive, and it lived only in the ⋯ menu). A cellar that
// could not be LOADED says so and offers Retry — it used to read "No bottles in
// this cellar yet", which on a weak signal looks like the bottles are gone.

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k) => k, i18n: { language: 'en' } }),
}));

let auth;
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => auth }));

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const CELLAR = { _id: 'c1', name: 'Home', userRole: 'owner', bottleCount: 0 };

let cellarFails;
let cellarGone;
const api = vi.fn(async (url) => {
  if (url.startsWith('/api/cellars/c1?')) {
    if (cellarFails) throw new TypeError('Failed to fetch');
    if (cellarGone) return { ok: false, status: 404, json: async () => ({ error: 'Cellar not found' }) };
    return ok({ cellar: CELLAR, bottles: { items: [], total: 0 }, facets: {}, baseFacets: {}, facetMeta: {} });
  }
  if (url === '/api/cellars') return ok({ cellars: [CELLAR] });
  if (url.startsWith('/api/racks')) return ok({ racks: [] });
  if (url.startsWith('/api/climate/')) return ok({ devices: [] });
  return ok({});
});

const memoryStorage = () => {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    clear: () => m.clear(),
  };
};

beforeEach(() => {
  api.mockClear();
  cellarGone = false;
  cellarFails = false;
  vi.stubGlobal('sessionStorage', memoryStorage());
  vi.stubGlobal('localStorage', memoryStorage());
  auth = {
    apiFetch: api,
    user: { id: 'u1', preferences: {} },
    updatePreferences: vi.fn(async () => ({ success: true })),
  };
});
afterEach(() => vi.unstubAllGlobals());

const renderCellar = () => render(
  <MemoryRouter initialEntries={['/cellars/c1']}>
    <Routes><Route path="/cellars/:id" element={<CellarDetail />} /></Routes>
  </MemoryRouter>,
);

test('an empty cellar offers import beside "Add your first bottle"', async () => {
  renderCellar();
  expect(await screen.findByText('cellarDetail.noBottles')).toBeInTheDocument();
  expect(screen.getByText('cellarDetail.addFirstBottle')).toBeInTheDocument();
  expect(screen.getByText('cellarDetail.importInstead').closest('a')).toHaveAttribute('href', '/cellars/c1/import');
});

test('a cellar that could not be loaded says so and loads again on Retry', async () => {
  cellarFails = true;
  renderCellar();
  expect(await screen.findByText('common.couldNotLoad')).toBeInTheDocument();
  expect(screen.queryByText('cellarDetail.noBottles')).not.toBeInTheDocument();

  cellarFails = false;
  fireEvent.click(screen.getByText('common.retry'));
  await waitFor(() => expect(screen.getByText('cellarDetail.noBottles')).toBeInTheDocument());
});

test('one failure is said once, not in a banner and the list at the same time', async () => {
  cellarFails = true;
  renderCellar();
  await screen.findByText('common.couldNotLoad');
  expect(screen.getAllByRole('alert')).toHaveLength(1);
});

test('a cellar that is gone gets no Retry that could never work', async () => {
  cellarGone = true;
  renderCellar();
  expect(await screen.findByText('Cellar not found')).toBeInTheDocument();
  expect(screen.queryByText('common.retry')).not.toBeInTheDocument();
});

// A search that finds nothing in one cellar is the moment to offer every cellar.
const renderCellarAt = (url) => render(
  <MemoryRouter initialEntries={[url]}>
    <Routes><Route path="/cellars/:id" element={<CellarDetail />} /></Routes>
  </MemoryRouter>,
);

test('a search with no match offers to search every cellar for the same words', async () => {
  renderCellarAt('/cellars/c1?search=Two%20Wolves');
  expect(await screen.findByText('cellarDetail.noSearchResults')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'cellarDetail.searchAllCellars' }))
    .toHaveAttribute('href', '/bottles?status=all&search=Two+Wolves');
});

test('an empty cellar with no search offers no wider search', async () => {
  renderCellar();
  await screen.findByText('cellarDetail.noBottles');
  expect(screen.queryByRole('link', { name: 'cellarDetail.searchAllCellars' })).not.toBeInTheDocument();
});
