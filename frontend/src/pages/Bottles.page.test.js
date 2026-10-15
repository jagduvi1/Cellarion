import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import Bottles from './Bottles';

// The page of "all bottles" is in the address, so Back from a bottle (and the
// bottle page's back link) returns to the same page instead of the first.

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k) => k, i18n: { language: 'en' } }),
}));

let auth;
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => auth }));

const api = vi.fn(async (url) => {
  if (url.startsWith('/api/bottles')) {
    const offset = Number(new URLSearchParams(url.split('?')[1]).get('offset') || 0);
    const items = Array.from({ length: 30 }, (_, i) => ({
      _id: `b${offset + i}`, cellar: 'c1', status: 'active', vintage: '2019',
      wineDefinition: { _id: `w${offset + i}`, name: `Wine ${offset + i}` },
    }));
    return { ok: true, status: 200, json: async () => ({ bottles: { items, total: 95, count: 30 } }) };
  }
  return { ok: true, status: 200, json: async () => ({}) };
});

beforeEach(() => {
  api.mockClear();
  auth = { apiFetch: api, user: { id: 'u1', preferences: {} } };
});

let where;
function Where() { where = useLocation(); return null; }
const renderAt = (url) => render(
  <MemoryRouter initialEntries={[url]}>
    <Routes><Route path="/bottles" element={<><Bottles /><Where /></>} /></Routes>
  </MemoryRouter>,
);
const offsets = () => api.mock.calls.map(([u]) => u).filter((u) => u.startsWith('/api/bottles'))
  .map((u) => new URLSearchParams(u.split('?')[1]).get('offset'));

test('opening the list at ?page=2 loads the second page', async () => {
  renderAt('/bottles?type=red&page=2');
  await waitFor(() => expect(offsets().length).toBeGreaterThan(0));
  expect(offsets()[0]).toBe('30');
});

test('Next puts the page in the address', async () => {
  renderAt('/bottles?type=red');
  await waitFor(() => expect(offsets()).toEqual(['0']));
  fireEvent.click(await screen.findByText(/bottles\.next/));
  await waitFor(() => expect(where.search).toBe('?type=red&page=2'));
  await waitFor(() => expect(offsets()).toContain('30'));
});

test('a page that no longer exists (bottles drunk since) goes to the last one there is', async () => {
  renderAt('/bottles?type=red&page=9');
  // 95 bottles = 4 pages: page 9 is past the end.
  await waitFor(() => expect(where.search).toBe('?type=red&page=4'));
  await waitFor(() => expect(offsets()).toContain('90'));
});
