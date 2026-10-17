import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';

// The registry wine's page had "Add to Wishlist" and no way to put a bottle of
// it in a cellar. "Add to cellar" sits beside it for a signed-in member and
// opens Add Bottle with the wine chosen; an anonymous visitor sees neither.

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k) => k }) }));
vi.mock('../components/Layout', () => ({ default: ({ children }) => <div>{children}</div> }));
vi.mock('../components/SEOHead', () => ({ default: () => null }));
vi.mock('../components/WineImage', () => ({ default: () => null }));
vi.mock('../components/WineDiscussionsPanel', () => ({ default: () => null }));

let auth;
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => auth }));

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const WINE = { _id: 'a1b2c3d4e5f6a1b2c3d4e5f6', slug: 'borgogno-barolo', name: 'Barolo', producer: 'Borgogno', type: 'red' };
const api = vi.fn(async (url) => {
  if (url.endsWith('/api/wines/borgogno-barolo/public')) return ok({ wine: WINE });
  if (url === '/api/cellars') return ok({ cellars: [{ _id: 'c1', name: 'Home', userRole: 'owner' }] });
  return ok({});
});

const { default: WineDetail } = await import('./WineDetail');

function AddPage() {
  const location = useLocation();
  return <div data-testid="add-page">{location.pathname}{location.search}</div>;
}
const renderPage = () => render(
  <MemoryRouter initialEntries={['/wines/borgogno-barolo']}>
    <Routes>
      <Route path="/wines/:idOrSlug" element={<WineDetail />} />
      <Route path="/cellars/:id/add-bottle" element={<AddPage />} />
    </Routes>
  </MemoryRouter>,
);

test('"Add to cellar" beside "Add to Wishlist" opens Add Bottle with this wine', async () => {
  auth = { apiFetch: api, user: { id: 'u1', preferences: {} } };
  renderPage();
  expect(await screen.findByText('wineDetail.addToWishlist')).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'addToCellar.action' }));

  expect(await screen.findByTestId('add-page')).toHaveTextContent(`/cellars/c1/add-bottle?wine=${WINE._id}`);
});

test('an anonymous visitor gets neither', async () => {
  auth = { apiFetch: api, user: null };
  const fetchMock = vi.fn(async () => ok({ wine: WINE }));
  vi.stubGlobal('fetch', fetchMock);
  try {
    renderPage();
    expect(await screen.findByText('Barolo')).toBeInTheDocument();
    expect(screen.queryByText('wineDetail.addToWishlist')).toBeNull();
    expect(screen.queryByRole('button', { name: 'addToCellar.action' })).toBeNull();
  } finally {
    vi.unstubAllGlobals();
  }
});
