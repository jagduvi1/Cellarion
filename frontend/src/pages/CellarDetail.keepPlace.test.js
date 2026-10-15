import { render, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import CellarDetail from './CellarDetail';

// Back from a bottle finds the cellar list as it was left: the "all my
// cellars" scope and every bottle that had been loaded with "Load more"
// (it used to come back to this cellar only and the first 30 bottles).

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k) => k, i18n: { language: 'en' } }),
}));

let auth;
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => auth }));

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const CELLAR = { _id: 'c1', name: 'Home', userRole: 'owner', bottleCount: 0 };
const OTHER = { _id: 'c2', name: 'Summer house', userRole: 'owner' };
const bottle = (n) => ({ _id: `b${n}`, status: 'active', vintage: '2019', cellar: 'c1', wineDefinition: { _id: `w${n}`, name: `Wine ${n}` } });
const group = (n) => ({ key: `w${n}|2019`, count: 1, bottles: [bottle(n)] });

let loaded = 30;
const api = vi.fn(async (url) => {
  if (url.startsWith('/api/cellars/c1?') || url.startsWith('/api/cellars/multi/bottles?')) {
    const q = new URLSearchParams(url.split('?')[1]);
    const limit = Number(q.get('limit'));
    const skip = Number(q.get('skip') || 0);
    const items = Array.from({ length: Math.min(limit, 100 - skip) }, (_, i) => group(skip + i + 1));
    return ok({ cellar: CELLAR, bottles: { items, total: 100 }, facets: {}, baseFacets: {}, facetMeta: {} });
  }
  if (url === '/api/cellars') return ok({ cellars: [CELLAR, OTHER] });
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
  loaded = 30;
  vi.stubGlobal('sessionStorage', memoryStorage());
  vi.stubGlobal('localStorage', memoryStorage());
  auth = { apiFetch: api, user: { id: 'u1', preferences: {} }, updatePreferences: vi.fn(async () => ({ success: true })) };
});
afterEach(() => vi.unstubAllGlobals());

const renderCellar = () => render(
  <MemoryRouter initialEntries={['/cellars/c1']}>
    <Routes><Route path="/cellars/:id" element={<CellarDetail />} /></Routes>
  </MemoryRouter>,
);
const listCalls = () => api.mock.calls.map(([u]) => u).filter((u) => u.startsWith('/api/cellars/c1?') || u.startsWith('/api/cellars/multi/bottles?'));

test('coming back loads as many bottles as were loaded when the list was left', async () => {
  const first = renderCellar();
  await waitFor(() => expect(listCalls().length).toBeGreaterThan(0));
  // "Load more" twice, the way a reader goes down the list.
  const { fireEvent, screen } = await import('@testing-library/react');
  fireEvent.click(await screen.findByText('cellarDetail.loadMore'));
  await waitFor(() => expect(listCalls().some((u) => u.includes('skip=30'))).toBe(true));
  fireEvent.click(await screen.findByText('cellarDetail.loadMore'));
  await waitFor(() => expect(listCalls().some((u) => u.includes('skip=60'))).toBe(true));
  await screen.findByText('Wine 90');
  first.unmount(); // opening a bottle

  api.mockClear();
  renderCellar(); // Back
  await waitFor(() => expect(listCalls().length).toBeGreaterThan(0));
  const q = new URLSearchParams(listCalls()[0].split('?')[1]);
  expect(q.get('skip')).toBe('0');
  expect(q.get('limit')).toBe('90');
});

test('the "all my cellars" scope is kept for this cellar, and dropped cellars are left out', async () => {
  sessionStorage.setItem('cellarion.cellarScope.c1', JSON.stringify(['c1', 'c2', 'gone']));
  renderCellar();
  await waitFor(() => expect(listCalls().some((u) => u.startsWith('/api/cellars/multi/bottles?'))).toBe(true));
  // Once the cellar list has answered, the unknown one is dropped.
  await waitFor(() => {
    const last = listCalls().filter((u) => u.startsWith('/api/cellars/multi/bottles?')).pop();
    expect(new URLSearchParams(last.split('?')[1]).get('cellars')).toBe('c1,c2');
  });
});
