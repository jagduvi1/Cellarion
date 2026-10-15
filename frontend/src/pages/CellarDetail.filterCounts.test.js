import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import CellarDetail from './CellarDetail';

// The filter's numbers. Its button counted cards, not bottles: two identical
// bottles share one card, so a filter matching both read "Show 1 bottles"
// (support ticket 2026-10-14). And its maturity buttons never showed a count:
// the counts were read from statistics that never carried them (#1291).

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k, o) => (o && o.count !== undefined ? `${k}:${o.count}` : k), i18n: { language: 'en' } }),
}));

let auth;
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => auth }));

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const CELLAR = { _id: 'c1', name: 'Home', userRole: 'owner', bottleCount: 2 };
const bottle = (n) => ({ _id: `b${n}`, status: 'active', vintage: '2019', cellar: 'c1', wineDefinition: { _id: 'w1', name: 'Wine' } });

const api = vi.fn(async (url) => {
  if (url.startsWith('/api/cellars/c1?')) {
    // One card holding two identical bottles.
    return ok({
      cellar: CELLAR,
      bottles: { items: [{ key: 'w1::2019::750ml', count: 2, bottles: [bottle(1), bottle(2)] }], total: 1, bottleTotal: 2, grouped: true },
      facets: {}, baseFacets: {}, facetMeta: {},
    });
  }
  if (url === '/api/cellars/c1/maturity-counts') {
    return ok({ maturity: { declining: 0, late: 0, peak: 2, early: 0, notReady: 0, noProfile: 0 }, total: 2 });
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
  vi.stubGlobal('sessionStorage', memoryStorage());
  vi.stubGlobal('localStorage', memoryStorage());
  auth = { apiFetch: api, user: { id: 'u1', preferences: {} }, updatePreferences: vi.fn(async () => ({ success: true })) };
});
afterEach(() => vi.unstubAllGlobals());

test('the filter counts bottles, and its maturity buttons carry their counts', async () => {
  render(
    <MemoryRouter initialEntries={['/cellars/c1']}>
      <Routes><Route path="/cellars/:id" element={<CellarDetail />} /></Routes>
    </MemoryRouter>,
  );
  await waitFor(() => expect(api.mock.calls.some(([u]) => u.startsWith('/api/cellars/c1?'))).toBe(true));
  // Not asked for until the filter opens.
  expect(api.mock.calls.some(([u]) => u.includes('maturity-counts'))).toBe(false);

  fireEvent.click(await screen.findByLabelText('cellarDetail.toggleFilters'));
  expect(await screen.findByText('cellarDetail.showBottles:2')).toBeInTheDocument();
  await waitFor(() => expect(api.mock.calls.some(([u]) => u === '/api/cellars/c1/maturity-counts')).toBe(true));
  const peak = await screen.findByRole('button', { name: /maturity\.peak/ });
  await waitFor(() => expect(within(peak).getByText('2')).toBeInTheDocument());

  // Opened again: asked again (a drink window edited meanwhile moves bottles
  // between stages without changing how many there are).
  const asked = () => api.mock.calls.filter(([u]) => u === '/api/cellars/c1/maturity-counts').length;
  const before = asked();
  fireEvent.click(screen.getByText('cellarDetail.showBottles:2'));
  await waitFor(() => expect(screen.queryByText('cellarDetail.showBottles:2')).toBeNull());
  fireEvent.click(screen.getByLabelText('cellarDetail.toggleFilters'));
  await waitFor(() => expect(asked()).toBe(before + 1));
});
