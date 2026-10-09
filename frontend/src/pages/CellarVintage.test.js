import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

// One wine and vintage in a cellar (support ticket 2026-10-09): the page
// behind a grouped "n identical bottles" entry. A view over existing data:
// the count, where the bottles sit, what they share, the sommelier window,
// and "Drink one", which logs a single bottle and reloads the page.

vi.mock('react-i18next', () => {
  const t = (key, a, b) => {
    const vars = b && typeof b === 'object' ? b : (a && typeof a === 'object' ? a : undefined);
    if (vars && vars.count !== undefined && Object.keys(vars).length === 1) return `${key}:${vars.count}`;
    return vars ? `${key}:${JSON.stringify(vars)}` : key;
  };
  return { useTranslation: () => ({ t, i18n: { language: 'en-GB' } }) };
});
vi.mock('../components/AuthImage', () => ({ default: ({ src, alt }) => <img src={src} alt={alt} /> }));
vi.mock('../components/CellarNav', () => ({ default: () => null }));
vi.mock('../components/bottle/WineRecordSection', () => ({ default: () => <div data-testid="wine-record" /> }));
vi.mock('../components/bottle/PersonalDataCard', () => ({ default: ({ bottleId, vintage }) => <div data-testid="personal-data">{bottleId}:{vintage}</div> }));
vi.mock('../components/bottle/LotHistory', () => ({ default: ({ bottleId }) => <div data-testid="lot-history">{bottleId}</div> }));
vi.mock('../components/DrinkOneModal', () => ({
  default: ({ bottles, onDone }) => <button type="button" onClick={() => onDone(bottles[0], 'gifted')}>drink-one-stub:{bottles.length}</button>,
}));
vi.mock('../components/RatingInput', () => ({ default: () => null }));

let auth;
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => auth }));

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const WINE = { _id: 'w1', name: 'Château Margaux', producer: 'Château Margaux', slug: 'chateau-margaux', image: '/api/uploads/processed/registry.webp', imageCredit: 'registry' };
const bottle = (id, over = {}) => ({
  _id: id, status: 'active', vintage: '2015', price: 400, currency: 'EUR', notes: 'En primeur', drinkFrom: 2025, drinkTo: 2045,
  wineDefinition: WINE, rackInfo: null, ...over,
});
let page;

let api;
beforeEach(() => {
  page = {
    cellar: { _id: 'c1', name: 'Home', userRole: 'owner', userColor: null },
    wine: WINE,
    vintage: '2015',
    bottles: [
      bottle('b1', { rackInfo: { rackId: 'r1', rackName: 'Left wall', position: 3, inRoom: false }, vintageImageUrl: '/api/uploads/processed/pub-2015.webp', vintageImageCredit: 'Anna' }),
      bottle('b2', { rackInfo: { rackId: 'r1', rackName: 'Left wall', position: 7, inRoom: false } }),
      bottle('b3'),
    ],
    total: 3, onOrderCount: 2, consumedCount: 1, historyBottleId: 'b1',
    shared: { notes: 'En primeur', drinkFrom: 2025, drinkTo: 2045, peakFrom: null, peakUntil: null },
  };
  api = vi.fn(async (url) => {
    if (url === '/api/cellars/c1/vintages/w1/2015') return ok(page);
    if (url.startsWith('/api/somm/maturity/lookup')) return ok({ profile: { status: 'reviewed', peakFrom: 2030, peakUntil: 2045 } });
    return ok({});
  });
  auth = { apiFetch: api, user: { id: 'u1', preferences: { ratingScale: '5' } } };
});

const renderPage = () => render(
  <MemoryRouter initialEntries={['/cellars/c1/vintages/w1/2015']}>
    <Routes><Route path="/cellars/:id/vintages/:wineId/:vintage" element={<CellarVintage />} /></Routes>
  </MemoryRouter>,
);
const { default: CellarVintage } = await import('./CellarVintage');

test('the count, the on-order and drunk links, where the bottles sit, what they share, and the same-vintage photo as hero', async () => {
  renderPage();
  expect(await screen.findByText('cellarVintage.inCellar:3')).toBeInTheDocument();
  expect(screen.getByText('cellarVintage.onOrder:2')).toHaveAttribute('href', '/cellars/c1/on-order');
  expect(screen.getByText('cellarVintage.drunk:1')).toHaveAttribute('href', '/cellars/c1/history');
  expect(screen.getByText(/cellarVintage.rackSlots:.*"slots":"3, 7"/)).toBeInTheDocument();
  expect(screen.getByText('cellarVintage.unplaced:1')).toBeInTheDocument();
  expect(screen.getByText(/cellarVintage.paidTotal:.*1,200 EUR/)).toBeInTheDocument();
  // Shared once, not three times: the window and the note.
  expect(screen.getByText('cellarVintage.sharedTitle:3')).toBeInTheDocument();
  expect(screen.getByText('2025–2045')).toBeInTheDocument();
  expect(screen.getAllByText('En primeur')).toHaveLength(1);
  // Hero: a public photo of THIS vintage beats the registry image, with its credit.
  expect(screen.getByAltText('Château Margaux 2015').getAttribute('src')).toBe('/api/uploads/processed/pub-2015.webp');
  expect(document.querySelector('.cellar-vintage-hero .bd-wine-image-credit').textContent).toBe('Anna');
  // The bottle-keyed cards get the page's history bottle and the vintage.
  expect(screen.getByTestId('personal-data').textContent).toBe('b1:2015');
  expect(screen.getByTestId('lot-history').textContent).toBe('b1');
  expect(screen.getByTestId('wine-record')).toBeInTheDocument();
  expect(screen.getByText('cellarVintage.registryLink')).toHaveAttribute('href', '/wines/chateau-margaux');
  // The sommelier window for this vintage is rendered from the lookup.
  expect(screen.getByText('2030–2045')).toBeInTheDocument();
  expect(api).toHaveBeenCalledWith('/api/somm/maturity/lookup?wine=w1&vintage=2015');
});

test('Drink one hands the page\'s bottles to the picker and reloads once a bottle was logged', async () => {
  renderPage();
  fireEvent.click(await screen.findByText('cellarVintage.drinkOne'));
  const stub = await screen.findByText('drink-one-stub:3');
  page = { ...page, bottles: page.bottles.slice(1), total: 2, consumedCount: 2 };
  fireEvent.click(stub);
  expect(await screen.findByText('cellarVintage.inCellar:2')).toBeInTheDocument();
  expect(screen.getByText('cellarVintage.drunkNote')).toBeInTheDocument();
  await waitFor(() => expect(api.mock.calls.filter(([u]) => u === '/api/cellars/c1/vintages/w1/2015')).toHaveLength(2));
});

test('a viewer of a shared cellar gets the page without the actions; an editor can drink but not set the window for all', async () => {
  page.cellar.userRole = 'viewer';
  const { unmount } = renderPage();
  expect(await screen.findByText('cellarVintage.inCellar:3')).toBeInTheDocument();
  expect(screen.queryByText('cellarVintage.drinkOne')).toBeNull();
  expect(screen.queryByText('cellarVintage.setWindowAll:3')).toBeNull();
  unmount();

  page.cellar.userRole = 'editor';
  renderPage();
  expect(await screen.findByText('cellarVintage.drinkOne')).toBeInTheDocument();
  expect(screen.queryByText('cellarVintage.setWindowAll:3')).toBeNull();
});

test('nothing left of the vintage: the page still opens on its history', async () => {
  page = { ...page, bottles: [], total: 0, consumedCount: 3, historyBottleId: 'b9', shared: { notes: null, drinkFrom: null, drinkTo: null, peakFrom: null, peakUntil: null } };
  renderPage();
  expect(await screen.findByText('cellarVintage.noneLeft')).toBeInTheDocument();
  expect(screen.getByTestId('lot-history').textContent).toBe('b9');
  expect(screen.queryByText('cellarVintage.drinkOne')).toBeNull();
});

test('a refused load shows the server\'s reason', async () => {
  api = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({ error: 'No bottles of this wine and vintage here' }) }));
  auth = { apiFetch: api, user: { id: 'u1' } };
  renderPage();
  expect(await screen.findByText('No bottles of this wine and vintage here')).toBeInTheDocument();
});
