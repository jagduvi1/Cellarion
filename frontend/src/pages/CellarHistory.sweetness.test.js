import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import CellarHistory from './CellarHistory';

// The history takes the sweetness filter like the cellar page: a value chosen
// in the shared filter asks for the list again with it, shows a chip, and
// "Clear all" takes it off. A history view kept by a build that had no such
// filter still opens.

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k, opts) => (opts && opts.count !== undefined ? `${k}:${opts.count}` : k), i18n: { language: 'en' } }),
}));

let auth;
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => auth }));

// The modal, reduced to one sweetness choice: like the real one, a pick is
// applied at once through onApply.
vi.mock('../components/BottleFilterModal', () => ({
  default: ({ filters, onApply }) => (
    <div data-testid="filter-modal">
      <button type="button" onClick={() => onApply({ ...filters, sweetnessCategory: ['sweet'] })}>pick-sweet</button>
    </div>
  ),
}));

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const CELLAR = { _id: 'c1', name: 'Home', userRole: 'owner' };
const bottle = (id, day) => ({
  _id: id, status: 'drank', consumedReason: 'drank', consumedAt: `2026-01-${String(day).padStart(2, '0')}T00:00:00.000Z`,
  wineDefinition: { _id: `w-${id}`, name: `Wine ${id}`, producer: 'P' },
});
const page = (bottles) => ok({
  cellar: CELLAR, bottles, total: bottles.length,
  reasonCounts: { drank: bottles.length, gifted: 0, sold: 0, other: 0 },
  facets: {}, baseFacets: {}, facetMeta: {},
});

const api = vi.fn(async (url) => {
  if (url.startsWith('/api/cellars/c1/history?')) {
    const q = new URLSearchParams(url.split('?')[1]);
    return q.get('sweetnessCategory') === 'sweet' ? page([bottle('b2', 8)]) : page([bottle('b1', 9), bottle('b2', 8)]);
  }
  if (url === '/api/cellars') return ok({ cellars: [CELLAR] });
  return ok({});
});

const historyCalls = () => api.mock.calls.map(([u]) => u).filter((u) => u.startsWith('/api/cellars/c1/history?'))
  .map((u) => new URLSearchParams(u.split('?')[1]));
const lastHistoryCall = () => historyCalls()[historyCalls().length - 1];

let store;
beforeEach(() => {
  api.mockClear();
  auth = { apiFetch: api, user: { id: 'u1' } };
  store = new Map();
  vi.stubGlobal('sessionStorage', {
    getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k), clear: () => store.clear(),
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const renderPage = () => render(
  <MemoryRouter initialEntries={['/cellars/c1/history']}>
    <Routes><Route path="/cellars/:id/history" element={<CellarHistory />} /></Routes>
  </MemoryRouter>,
);

test('a value chosen in the filter asks for the history with it and shows its chip; "Clear all" takes it off', async () => {
  renderPage();
  await waitFor(() => expect(screen.getByText('Wine b1')).toBeInTheDocument());
  expect(lastHistoryCall().get('sweetnessCategory')).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'cellarDetail.toggleFilters' }));
  fireEvent.click(await screen.findByText('pick-sweet'));
  await waitFor(() => expect(lastHistoryCall().get('sweetnessCategory')).toBe('sweet'));
  await waitFor(() => expect(screen.queryByText('Wine b1')).toBeNull());
  expect(document.querySelector('.active-filter-chip')).toHaveTextContent('sweetness.band.sweet');

  fireEvent.click(screen.getByRole('button', { name: 'cellarDetail.clearAllFilters' }));
  await waitFor(() => expect(lastHistoryCall().get('sweetnessCategory')).toBeNull());
  expect(document.querySelector('.active-filter-chip')).toBeNull();
});

test('a history view kept before the filter existed opens without it', async () => {
  sessionStorage.setItem('cellarion.historyView.c1', JSON.stringify({ filters: { appellation: [], type: ['white'] }, scope: ['c1'] }));
  renderPage();
  await waitFor(() => expect(historyCalls().length).toBeGreaterThan(0));
  expect(historyCalls()[0].get('sweetnessCategory')).toBeNull();
  expect(historyCalls()[0].get('type')).toBe('white');
  await waitFor(() => expect(screen.getByText('Wine b1')).toBeInTheDocument());
});
