import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';

// A member tapped "Bought" on a wishlist item expecting the bottle to go into
// the cellar — it only ticks the wishlist. Every item now has "Add to cellar"
// too, bought or not: Add Bottle with the wine and the item's vintage chosen.
// "Bought" itself is unchanged.

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k) => k }),
  Trans: ({ i18nKey }) => <span>{i18nKey}</span>,
}));
vi.mock('../components/WineImage', () => ({ default: () => null }));

let auth;
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => auth }));

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const item = (id, over = {}) => ({
  _id: id, status: 'wanted', priority: 'medium',
  wineDefinition: { _id: `w-${id}`, name: `Wine ${id}`, producer: 'P', type: 'red' },
  ...over,
});
const api = vi.fn(async (url) => {
  if (url.startsWith('/api/wishlist?')) return ok({ items: [item('i1', { vintage: '2016' }), item('i2', { status: 'bought', boughtAt: '2026-10-16T10:00:00.000Z' })], total: 2 });
  if (url === '/api/cellars') return ok({ cellars: [{ _id: 'c1', name: 'Home', userRole: 'owner' }] });
  return ok({ item: {} });
});

const { default: Wishlist } = await import('./Wishlist');

function AddPage() {
  const location = useLocation();
  return <div data-testid="add-page">{location.pathname}{location.search}</div>;
}
const renderPage = () => render(
  <MemoryRouter initialEntries={['/wishlist']}>
    <Routes>
      <Route path="/wishlist" element={<Wishlist />} />
      <Route path="/cellars/:id/add-bottle" element={<AddPage />} />
    </Routes>
  </MemoryRouter>,
);
const itemOf = (name) => screen.getByText(name).closest('.wishlist-item');

beforeEach(() => {
  api.mockClear();
  auth = { apiFetch: api, user: { id: 'u1', preferences: {} } };
});

test('"Add to cellar" on a wanted item opens Add Bottle with its wine and vintage; "Bought" is still there', async () => {
  renderPage();
  await screen.findByText('Wine i1');
  expect(within(itemOf('Wine i1')).getByRole('button', { name: 'wishlist.bought' })).toBeInTheDocument();

  fireEvent.click(within(itemOf('Wine i1')).getByRole('button', { name: 'addToCellar.action' }));

  expect(await screen.findByTestId('add-page')).toHaveTextContent('/cellars/c1/add-bottle?wine=w-i1&vintage=2016');
  // Nothing on the wishlist changed on the way.
  expect(api.mock.calls.some(([, opts]) => opts?.method === 'PUT')).toBe(false);
});

test('a bought item can still be added to the cellar (no vintage set: the field is left to fill in)', async () => {
  renderPage();
  await screen.findByText('Wine i2');

  fireEvent.click(within(itemOf('Wine i2')).getByRole('button', { name: 'addToCellar.action' }));

  expect(await screen.findByTestId('add-page')).toHaveTextContent('/cellars/c1/add-bottle?wine=w-i2');
  expect(screen.getByTestId('add-page')).not.toHaveTextContent('vintage');
});
