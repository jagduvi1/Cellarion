import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import CellarDetail from './CellarDetail';

// The sweetness filter on the cellar page: a value chosen in the filter is
// sent to the server (which does the filtering), shows as a chip, arrives by
// link, and comes off again by its chip or "Clear all". A view saved by a
// build that had no such filter still opens.

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k, o) => (o && o.count !== undefined ? `${k}:${o.count}` : k), i18n: { language: 'en' } }),
}));

let auth;
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => auth }));

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const CELLAR = { _id: 'c1', name: 'Home', userRole: 'owner', bottleCount: 2 };
const bottle = (n) => ({ _id: `b${n}`, status: 'active', vintage: '2019', cellar: 'c1', wineDefinition: { _id: 'w1', name: 'Wine' } });
const HELD = { dry: 4, sweet: 2, 'not-stated': 3 };

const api = vi.fn(async (url) => {
  if (url.startsWith('/api/cellars/c1?')) {
    return ok({
      cellar: CELLAR,
      bottles: { items: [{ key: 'w1::2019::750ml', count: 2, bottles: [bottle(1), bottle(2)] }], total: 1, bottleTotal: 2, grouped: true },
      facets: { sweetnessCategory: HELD }, baseFacets: { sweetnessCategory: HELD }, facetMeta: {},
    });
  }
  if (url === '/api/cellars/c1/maturity-counts') return ok({ maturity: {}, total: 2 });
  if (url === '/api/cellars') return ok({ cellars: [CELLAR] });
  if (url.startsWith('/api/racks')) return ok({ racks: [] });
  if (url.startsWith('/api/climate/')) return ok({ devices: [] });
  return ok({});
});

const cellarCalls = () => api.mock.calls.map(([u]) => u).filter((u) => u.startsWith('/api/cellars/c1?'))
  .map((u) => new URLSearchParams(u.split('?')[1]));
const lastCall = () => cellarCalls()[cellarCalls().length - 1];
const chips = () => Array.from(document.querySelectorAll('.active-filter-chip')).map((c) => c.textContent.replace('×', ''));

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
  vi.stubGlobal('sessionStorage', memoryStorage());
  vi.stubGlobal('localStorage', memoryStorage());
  auth = { apiFetch: api, user: { id: 'u1', preferences: {} }, updatePreferences: vi.fn(async () => ({ success: true })) };
});
afterEach(() => vi.unstubAllGlobals());

const renderAt = (url) => render(
  <MemoryRouter initialEntries={[url]}>
    <Routes><Route path="/cellars/:id" element={<CellarDetail />} /></Routes>
  </MemoryRouter>,
);

test('a link with two values asks the server for both and shows a chip for each', async () => {
  renderAt('/cellars/c1?sweetnessCategory=sweet,not-stated');
  await waitFor(() => expect(cellarCalls().length).toBeGreaterThan(0));
  expect(lastCall().get('sweetnessCategory')).toBe('sweet,not-stated');
  await waitFor(() => expect(chips()).toEqual(['sweetness.band.sweet', 'cellarDetail.sweetnessNotStatedChip']));
});

test('a chip takes its value off, and "Clear all" takes the rest', async () => {
  renderAt('/cellars/c1?sweetnessCategory=sweet,not-stated');
  await waitFor(() => expect(chips()).toHaveLength(2));
  fireEvent.click(document.querySelectorAll('.active-filter-chip-remove')[0]);
  await waitFor(() => expect(lastCall().get('sweetnessCategory')).toBe('not-stated'));
  expect(chips()).toEqual(['cellarDetail.sweetnessNotStatedChip']);

  fireEvent.click(document.querySelector('.active-filters-clear'));
  await waitFor(() => expect(lastCall().get('sweetnessCategory')).toBeNull());
  expect(chips()).toEqual([]);
});

test('a view saved before the filter existed opens, and a value chosen in the filter is asked for', async () => {
  // What an older build kept for this cellar: no sweetnessCategory key at all.
  sessionStorage.setItem('cellarFilters:c1', JSON.stringify({
    search: '', type: [], country: [], region: [], appellation: [], grapes: [], vintage: [],
    minRating: '', maxRating: '', maturity: [], unplaced: '', reserved: '', storage: '',
    producer: '', bottleSize: '', purchaseYear: '', ratingBand: '', sort: '-createdAt',
  }));
  renderAt('/cellars/c1');
  await waitFor(() => expect(cellarCalls().length).toBeGreaterThan(0));
  expect(lastCall().get('sweetnessCategory')).toBeNull();

  fireEvent.click(await screen.findByLabelText('cellarDetail.toggleFilters'));
  // Closed until a value is chosen.
  fireEvent.click(await screen.findByRole('button', { name: /cellarDetail\.sweetnessLabel/ }));
  fireEvent.click(screen.getByRole('button', { name: /^sweetness\.band\.dry/ }));
  await waitFor(() => expect(lastCall().get('sweetnessCategory')).toBe('dry'));
  fireEvent.click(screen.getByRole('button', { name: /^sweetness\.band\.sweet/ }));
  await waitFor(() => expect(lastCall().get('sweetnessCategory')).toBe('dry,sweet'));
});
