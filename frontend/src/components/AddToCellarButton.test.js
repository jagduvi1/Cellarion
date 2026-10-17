import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';

// "Add to cellar" (wishlist item, wine page) opens Add Bottle with the wine —
// and the vintage when known — chosen. Which cellar: the default one, else the
// only one the member may add to, else they pick; cellars they may only view
// are never offered.

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k) => k }) }));

let auth;
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => auth }));

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
let cellars;
const api = vi.fn(async (url) => (url === '/api/cellars' ? cellars() : ok({})));

const { default: AddToCellarButton } = await import('./AddToCellarButton');

function AddPage() {
  const location = useLocation();
  return <div data-testid="add-page">{location.pathname}{location.search}</div>;
}
const renderButton = (props = {}) => render(
  <MemoryRouter initialEntries={['/wishlist']}>
    <Routes>
      <Route path="/wishlist" element={<AddToCellarButton wineId="w1" vintage="2016" {...props} />} />
      <Route path="/cellars/:id/add-bottle" element={<AddPage />} />
      <Route path="/cellars" element={<div data-testid="cellars-page" />} />
    </Routes>
  </MemoryRouter>,
);
const list = (...rows) => () => ok({ cellars: rows });

beforeEach(() => {
  api.mockClear();
  auth = { apiFetch: api, user: { id: 'u1', preferences: {} } };
});

test('the default cellar is used when the member may add to it', async () => {
  auth.user.preferences.defaultCellarId = 'c2';
  cellars = list({ _id: 'c1', name: 'Home', userRole: 'owner' }, { _id: 'c2', name: 'Storage', userRole: 'editor' });
  renderButton();
  fireEvent.click(screen.getByRole('button', { name: 'addToCellar.action' }));

  expect(await screen.findByTestId('add-page')).toHaveTextContent('/cellars/c2/add-bottle?wine=w1&vintage=2016');
});

test('the only cellar the member may add to is used — a viewed one is not a choice', async () => {
  cellars = list({ _id: 'c1', name: 'Shared with me', userRole: 'viewer' }, { _id: 'c3', name: 'Home', userRole: 'owner' });
  renderButton({ vintage: undefined });
  fireEvent.click(screen.getByRole('button', { name: 'addToCellar.action' }));

  expect((await screen.findByTestId('add-page')).textContent).toBe('/cellars/c3/add-bottle?wine=w1');
});

test('with several and no usable default, the member picks one', async () => {
  auth.user.preferences.defaultCellarId = 'c9'; // a cellar since deleted
  cellars = list(
    { _id: 'c1', name: 'Home', userRole: 'owner' },
    { _id: 'c2', name: 'Storage', userRole: 'editor' },
    { _id: 'c4', name: 'Friend’s', userRole: 'viewer' },
  );
  renderButton();
  fireEvent.click(screen.getByRole('button', { name: 'addToCellar.action' }));

  const dialog = await screen.findByRole('dialog', { name: 'addToCellar.pickTitle' });
  expect(within(dialog).getByRole('button', { name: 'Home' })).toBeInTheDocument();
  expect(within(dialog).queryByRole('button', { name: 'Friend’s' })).toBeNull();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Storage' }));

  expect(await screen.findByTestId('add-page')).toHaveTextContent('/cellars/c2/add-bottle?wine=w1&vintage=2016');
});

test('no cellar to add to: the cellars page, where the first one is made', async () => {
  cellars = list({ _id: 'c1', name: 'Shared with me', userRole: 'viewer' });
  renderButton();
  fireEvent.click(screen.getByRole('button', { name: 'addToCellar.action' }));
  expect(await screen.findByTestId('cellars-page')).toBeInTheDocument();
});

test('cellars that cannot be read say so, and nothing opens', async () => {
  cellars = () => ({ ok: false, status: 500, json: async () => ({ error: 'boom' }) });
  renderButton();
  fireEvent.click(screen.getByRole('button', { name: 'addToCellar.action' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('addToCellar.loadError');
  expect(screen.queryByTestId('add-page')).toBeNull();
});

test('a demo visitor gets no button (adding bottles is not open to the demo)', () => {
  auth.user.isDemo = true;
  renderButton();
  expect(screen.queryByRole('button', { name: 'addToCellar.action' })).toBeNull();
});
