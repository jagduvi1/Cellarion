import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import CellarDetail from './CellarDetail';

// The cellar page opens in the sort the user picked last, on any cellar
// (support ticket 2026-09-26: the sort went back to newest first on every
// visit). The choice is saved on the account the moment it is picked; a
// link's own sort and this tab's per-cellar selection still come first.

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k) => k, i18n: { language: 'en' } }),
}));

let auth;
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => auth }));

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const CELLAR = { _id: 'c1', name: 'Home', userRole: 'owner', bottleCount: 0 };

const api = vi.fn(async (url) => {
  if (url.startsWith('/api/cellars/c1?')) {
    return ok({ cellar: CELLAR, bottles: { items: [], total: 0 }, facets: {}, baseFacets: {}, facetMeta: {} });
  }
  if (url === '/api/cellars') return ok({ cellars: [CELLAR] });
  if (url.startsWith('/api/racks')) return ok({ racks: [] });
  if (url.startsWith('/api/climate/')) return ok({ devices: [] });
  return ok({});
});

// Node ships storage globals that shadow jsdom's; use plain in-memory ones.
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
  auth = {
    apiFetch: api,
    user: { id: 'u1', preferences: { cellarSort: 'maturity' } },
    updatePreferences: vi.fn(async () => ({ success: true })),
  };
});

afterEach(() => vi.unstubAllGlobals());

const renderAt = (path) => render(
  <MemoryRouter initialEntries={[path]}>
    <Routes><Route path="/cellars/:id" element={<CellarDetail />} /></Routes>
  </MemoryRouter>,
);
const sortSelect = () => screen.getByLabelText('cellarDetail.sortBottlesAria');
const lastBottleQuery = () => {
  const urls = api.mock.calls.map(([u]) => u).filter((u) => u.startsWith('/api/cellars/c1?'));
  return new URLSearchParams(urls[urls.length - 1].split('?')[1]);
};

test('a fresh visit opens in the sort the user picked last', async () => {
  renderAt('/cellars/c1');
  expect(sortSelect()).toHaveValue('maturity');
  await waitFor(() => expect(lastBottleQuery().get('sort')).toBe('maturity'));
});

test('picking a sort shows it and remembers it on the account', async () => {
  renderAt('/cellars/c1');
  fireEvent.change(sortSelect(), { target: { value: 'name' } });

  expect(sortSelect()).toHaveValue('name');
  expect(auth.updatePreferences).toHaveBeenCalledWith({ cellarSort: 'name' });
  await waitFor(() => expect(lastBottleQuery().get('sort')).toBe('name'));
});

test('picking the sort already remembered does not save it again', async () => {
  renderAt('/cellars/c1');
  fireEvent.change(sortSelect(), { target: { value: 'vintage' } });
  fireEvent.change(sortSelect(), { target: { value: 'maturity' } });

  expect(auth.updatePreferences).toHaveBeenCalledTimes(1);
  expect(auth.updatePreferences).toHaveBeenCalledWith({ cellarSort: 'vintage' });
});

test("a link's own sort wins and is not saved as the user's choice", async () => {
  renderAt('/cellars/c1?sort=price');
  expect(sortSelect()).toHaveValue('price');
  await waitFor(() => expect(lastBottleQuery().get('sort')).toBe('price'));
  expect(auth.updatePreferences).not.toHaveBeenCalled();
});

test('a link with filters but no sort opens in the remembered sort', async () => {
  renderAt('/cellars/c1?type=red');
  expect(sortSelect()).toHaveValue('maturity');
});

test("coming back in the same tab keeps this cellar's own selection", async () => {
  sessionStorage.setItem('cellarFilters:c1', JSON.stringify({ sort: '-vintage' }));
  renderAt('/cellars/c1');
  expect(sortSelect()).toHaveValue('-vintage');
});

test('nothing remembered, or a value the page no longer offers, opens newest first', async () => {
  auth.user = { id: 'u1', preferences: { cellarSort: 'a-retired-order' } };
  const { unmount } = renderAt('/cellars/c1');
  expect(sortSelect()).toHaveValue('-createdAt');
  unmount();

  auth.user = { id: 'u1', preferences: {} };
  renderAt('/cellars/c1');
  expect(sortSelect()).toHaveValue('-createdAt');
});
