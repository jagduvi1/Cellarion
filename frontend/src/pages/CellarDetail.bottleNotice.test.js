import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import CellarDetail from './CellarDetail';

// The bottle page hands over what it just did (router state); the cellar page
// says it once, with Undo — and a later visit to the same entry does not.

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k) => k, i18n: { language: 'en' } }),
}));

let auth;
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => auth }));

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const CELLAR = { _id: 'c1', name: 'Home', userRole: 'owner', bottleCount: 0 };

// A delivery of two identical bottles, shown as one group card.
const BAROLO = (id) => ({ _id: id, status: 'active', vintage: '2019', cellar: 'c1', wineDefinition: { _id: 'w1', name: 'Barolo' } });
let items = [];
const api = vi.fn(async (url, init) => {
  if (url.startsWith('/api/cellars/c1?')) {
    return ok({ cellar: CELLAR, bottles: { items, total: items.length }, facets: {}, baseFacets: {}, facetMeta: {} });
  }
  if (url.endsWith('/consume') && init?.method === 'POST') return ok({ bottle: { _id: url.split('/')[3], status: 'drank' } });
  if (url.endsWith('/restore') && init?.method === 'POST') return ok({ bottle: { _id: url.split('/')[3], status: 'active' } });
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
  items = [];
  vi.stubGlobal('sessionStorage', memoryStorage());
  vi.stubGlobal('localStorage', memoryStorage());
  auth = { apiFetch: api, user: { id: 'u1', preferences: {} }, updatePreferences: vi.fn(async () => ({ success: true })) };
});
afterEach(() => vi.unstubAllGlobals());

test('a bottle drunk on its page is announced here with Undo', async () => {
  render(
    <MemoryRouter initialEntries={[{ pathname: '/cellars/c1', state: { bottleNotice: { kind: 'consumed', reason: 'drank', bottleId: 'b1', name: 'Barolo 2016' } } }]}>
      <Routes><Route path="/cellars/:id" element={<CellarDetail />} /></Routes>
    </MemoryRouter>,
  );
  expect(await screen.findByText('bottleNotice.drunk')).toBeInTheDocument();
  expect(screen.getByText('common.undo')).toBeInTheDocument();
});

test('without a handed-over notice there is none', async () => {
  render(
    <MemoryRouter initialEntries={['/cellars/c1']}>
      <Routes><Route path="/cellars/:id" element={<CellarDetail />} /></Routes>
    </MemoryRouter>,
  );
  expect(await screen.findByText('cellarDetail.noBottles')).toBeInTheDocument();
  expect(screen.queryByText('common.undo')).not.toBeInTheDocument();
});

it('drinking from a card says so at the top, with Undo — it used to change the count silently', async () => {
  items = [{ key: 'w1|2019', count: 2, bottles: [BAROLO('x1'), BAROLO('x2')] }];
  render(
    <MemoryRouter initialEntries={['/cellars/c1']}>
      <Routes><Route path="/cellars/:id" element={<CellarDetail />} /></Routes>
    </MemoryRouter>,
  );
  // The racks have answered (none): the bottles' places are known.
  await waitFor(() => expect(api.mock.calls.some(([u]) => u.startsWith('/api/racks'))).toBe(true));
  fireEvent.click(await screen.findByText('bottleCard.groupDrinkOne'));
  // Two identical bottles: no "Which bottle?" — straight to the form.
  fireEvent.click(await screen.findByText('common.confirm'));
  await waitFor(() => expect(api).toHaveBeenCalledWith('/api/bottles/x1/consume', expect.anything()));
  expect(await screen.findByText('bottleNotice.drunk')).toBeInTheDocument();

  // Undo, then the same bottle again: a fresh notice with its own Undo, not
  // the previous one's "back in the cellar".
  fireEvent.click(screen.getByText('common.undo'));
  expect(await screen.findByText('bottleNotice.restored')).toBeInTheDocument();
  const journal = screen.queryByText('journal.notNow');
  if (journal) fireEvent.click(journal);
  fireEvent.click(await screen.findByText('bottleCard.groupDrinkOne'));
  fireEvent.click(await screen.findByText('common.confirm'));
  expect(await screen.findByText('bottleNotice.drunk')).toBeInTheDocument();
  expect(screen.getByText('common.undo')).toBeInTheDocument();
});
