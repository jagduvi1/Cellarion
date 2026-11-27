import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom';
import CellarDetail from './CellarDetail';

// A link that carries filters can arrive while a cellar page is already open:
// the bell sits above the list, and a notification such as "40 wines at peak
// maturity" links to /cellars/<id>?maturity=peak. The route does not remount
// for it, so the page has to apply the link's filters itself: reading them
// only on mount would leave the click doing nothing.

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k) => k, i18n: { language: 'en' } }),
}));

let auth;
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => auth }));

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const cellar = (id) => ({ _id: id, name: `Cellar ${id}`, userRole: 'owner', bottleCount: 0 });

const api = vi.fn(async (url) => {
  const m = url.match(/^\/api\/cellars\/(c\d)\?/);
  if (m) return ok({ cellar: cellar(m[1]), bottles: { items: [], total: 0 }, facets: {}, baseFacets: {}, facetMeta: {} });
  if (url === '/api/cellars') return ok({ cellars: [cellar('c1'), cellar('c2')] });
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
  auth = { apiFetch: api, user: { id: 'u1', preferences: {} }, updatePreferences: vi.fn(async () => ({ success: true })) };
});
afterEach(() => vi.unstubAllGlobals());

// Stands in for the notification bell: a link clicked from outside the page.
function Bell({ to }) {
  const navigate = useNavigate();
  return <button type="button" onClick={() => navigate(to)}>bell</button>;
}
const renderAt = (path, bellTo) => render(
  <MemoryRouter initialEntries={[path]}>
    <Bell to={bellTo} />
    <Routes><Route path="/cellars/:id" element={<CellarDetail />} /></Routes>
  </MemoryRouter>,
);
const lastQueryFor = (id) => {
  const urls = api.mock.calls.map(([u]) => u).filter((u) => u.startsWith(`/api/cellars/${id}?`));
  return urls.length ? new URLSearchParams(urls[urls.length - 1].split('?')[1]) : null;
};

test('a filter link clicked while this cellar is open filters the list', async () => {
  renderAt('/cellars/c1', '/cellars/c1?maturity=peak');
  await waitFor(() => expect(lastQueryFor('c1')).not.toBeNull());
  expect(lastQueryFor('c1').get('maturity')).toBeNull();

  fireEvent.click(screen.getByText('bell'));

  await waitFor(() => expect(lastQueryFor('c1').get('maturity')).toBe('peak'));
});

test('several buckets in one link are all applied', async () => {
  renderAt('/cellars/c1', '/cellars/c1?maturity=late,declining');
  await waitFor(() => expect(lastQueryFor('c1')).not.toBeNull());

  fireEvent.click(screen.getByText('bell'));

  await waitFor(() => expect(lastQueryFor('c1').get('maturity')).toBe('late,declining'));
});

test('a link to another cellar opens that cellar with the link\'s filters, not the ones left on this page', async () => {
  renderAt('/cellars/c1?type=red', '/cellars/c2?maturity=peak');
  await waitFor(() => expect(lastQueryFor('c1')?.get('type')).toBe('red'));

  fireEvent.click(screen.getByText('bell'));

  await waitFor(() => expect(lastQueryFor('c2')?.get('maturity')).toBe('peak'));
  expect(lastQueryFor('c2').get('type')).toBeNull();
});

test('arriving with filters still works as before', async () => {
  renderAt('/cellars/c1?maturity=peak', '/cellars/c1');
  await waitFor(() => expect(lastQueryFor('c1')?.get('maturity')).toBe('peak'));
});
