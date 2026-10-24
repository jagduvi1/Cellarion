import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import CellarHistory from './CellarHistory';

// The shared filter modal offers an Appellation section. On the history page
// picking one asks for the list again, shows a chip like the other filters,
// and "Clear all" takes it off.

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k, opts) => (opts && opts.count !== undefined ? `${k}:${opts.count}` : k), i18n: { language: 'en' } }),
}));

let auth;
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => auth }));

// The modal, reduced to its Appellation choice: like the real one, a pick is
// applied at once through onApply.
vi.mock('../components/BottleFilterModal', () => ({
  default: ({ filters, onApply }) => (
    <div data-testid="filter-modal">
      <button type="button" onClick={() => onApply({ ...filters, appellation: ['Barolo'] })}>pick-barolo</button>
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
    return q.get('appellation') === 'Barolo' ? page([bottle('b2', 8)]) : page([bottle('b1', 9), bottle('b2', 8)]);
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

const openModalAndPickBarolo = async () => {
  fireEvent.click(screen.getByRole('button', { name: 'cellarDetail.toggleFilters' }));
  fireEvent.click(await screen.findByText('pick-barolo'));
};

test('picking an appellation asks for the list with it at once and shows its chip', async () => {
  renderPage();
  await waitFor(() => expect(screen.getByText('Wine b1')).toBeInTheDocument());
  const before = historyCalls().length;
  expect(lastHistoryCall().get('appellation')).toBeNull();

  await openModalAndPickBarolo();

  await waitFor(() => expect(historyCalls().length).toBe(before + 1));
  expect(lastHistoryCall().get('appellation')).toBe('Barolo');
  await waitFor(() => expect(screen.queryByText('Wine b1')).toBeNull());
  expect(document.querySelector('.active-filter-chip')).toHaveTextContent('Barolo');
  expect(screen.getByRole('button', { name: 'cellarDetail.removeFilterAria' })).toBeInTheDocument();
  expect(document.querySelector('.filter-badge')).toHaveTextContent('1');
});

test('"Clear all" takes the appellation off and asks for the list without it', async () => {
  renderPage();
  await waitFor(() => expect(screen.getByText('Wine b1')).toBeInTheDocument());
  await openModalAndPickBarolo();
  await waitFor(() => expect(lastHistoryCall().get('appellation')).toBe('Barolo'));
  const before = historyCalls().length;

  fireEvent.click(screen.getByRole('button', { name: 'cellarDetail.clearAllFilters' }));

  await waitFor(() => expect(historyCalls().length).toBe(before + 1));
  expect(lastHistoryCall().get('appellation')).toBeNull();
  await waitFor(() => expect(screen.getByText('Wine b1')).toBeInTheDocument());
  expect(document.querySelector('.active-filter-chip')).toBeNull();
});

test('removing the appellation chip asks for the list without it', async () => {
  renderPage();
  await waitFor(() => expect(screen.getByText('Wine b1')).toBeInTheDocument());
  await openModalAndPickBarolo();
  await waitFor(() => expect(lastHistoryCall().get('appellation')).toBe('Barolo'));
  const before = historyCalls().length;

  fireEvent.click(screen.getByRole('button', { name: 'cellarDetail.removeFilterAria' }));

  await waitFor(() => expect(historyCalls().length).toBe(before + 1));
  expect(lastHistoryCall().get('appellation')).toBeNull();
  expect(document.querySelector('.active-filter-chip')).toBeNull();
});

test('Back to a history kept with an appellation asks with it and shows its chip', async () => {
  sessionStorage.setItem('cellarion.historyView.c1', JSON.stringify({ filters: { appellation: ['Barolo'] }, scope: ['c1'] }));
  renderPage();
  await waitFor(() => expect(historyCalls().length).toBeGreaterThan(0));
  expect(historyCalls()[0].get('appellation')).toBe('Barolo');
  await waitFor(() => expect(screen.getByText('Wine b2')).toBeInTheDocument());
  expect(document.querySelector('.active-filter-chip')).toHaveTextContent('Barolo');
});
