import { render, screen, within, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

// The public wine page shows what the server's `context` holds around the
// wine: links to the place and grape pages that exist, a note about the
// region and each grape, related wines, and the drink windows. Drink windows
// are the registry data most worth keeping: a signed-out visitor learns only
// how many vintages are reviewed (and gets a sign-up link), a member sees the
// years.

// t echoes the key and its options so a test can see what was interpolated.
const t = (k, o) => {
  if (!o || typeof o !== 'object') return k;
  const opts = Object.fromEntries(Object.entries(o).filter(([key]) => key !== 'defaultValue'));
  return Object.keys(opts).length ? `${k}|${JSON.stringify(opts)}` : k;
};
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t }) }));
vi.mock('../components/Layout', () => ({ default: ({ children }) => <div>{children}</div> }));
vi.mock('../components/SEOHead', () => ({ default: () => null }));
vi.mock('../components/WineImage', () => ({ default: () => null }));
vi.mock('../components/WineDiscussionsPanel', () => ({ default: () => null }));
vi.mock('../components/AddToCellarButton', () => ({ default: () => null }));

let auth;
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => auth }));

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const WINE = {
  _id: 'a1b2c3d4e5f6a1b2c3d4e5f6', slug: 'caiarossa-pergolaia-bianco', name: 'Pergolaia Bianco', producer: 'Caiarossa', type: 'white',
  region: { name: 'Tuscany' }, country: { name: 'Italy' }, grapes: [{ name: 'Vermentino' }, { name: 'Viognier' }],
};
const CONTEXT = {
  region: { name: 'Tuscany', path: '/regions/tuscany', excerpt: 'Tuscany is one of Italy’s most iconic wine regions.' },
  country: { name: 'Italy', path: null, excerpt: null },
  grapes: [
    { name: 'Vermentino', path: '/grapes/vermentino', excerpt: 'Vermentino is a white grape of the Mediterranean coast.' },
    { name: 'Viognier', path: null, excerpt: null },
  ],
  sameProducer: [{ name: 'Aria di Caiarossa', producer: 'Caiarossa', type: 'red', place: 'Costa Toscana', path: '/wines/caiarossa-aria-di-caiarossa' }],
  similar: [{ name: 'Costa Toscana Bianco', producer: 'Podere La Regola', type: 'white', place: 'Costa Toscana', path: '/wines/podere-la-regola-costa-toscana-bianco' }],
  reviewedVintages: 1,
};
const WINDOW = { vintage: '2025', relative: false, earlyFrom: 2025, earlyUntil: 2027, peakFrom: 2027, peakUntil: 2029, lateFrom: 2029, lateUntil: 2031 };

let body;
const fetchWine = vi.fn(async () => ok(body));
globalThis.fetch = fetchWine;

const { default: WineDetail } = await import('./WineDetail');

const renderPage = () => render(
  <MemoryRouter initialEntries={[`/wines/${WINE.slug}`]}>
    <Routes>
      <Route path="/wines/:idOrSlug" element={<WineDetail />} />
    </Routes>
  </MemoryRouter>,
);

test('a visitor sees how many vintages are reviewed and a sign-up link, never the years', async () => {
  auth = { apiFetch: fetchWine, user: null };
  body = { wine: WINE, context: CONTEXT };
  renderPage();
  expect(await screen.findByText('wineDetail.whenToDrink')).toBeInTheDocument();
  expect(screen.getByText('wineDetail.windowTeaser|{"count":1}')).toBeInTheDocument();
  // The arrow is decoration, hidden from screen readers: the link's name is the words.
  expect(screen.getByRole('link', { name: 'wineDetail.windowTeaserCta' })).toHaveAttribute('href', '/login?mode=register');
  expect(document.body.textContent).not.toMatch(/2027|2029/);
});

// The serving line everyone sees on the wine page: the temperature in the
// reader's unit and the air trait in words; the per-bottle decanting advice
// stays on the bottle page.
test('a visitor sees the serving temperature and the air trait, a member in the unit they chose', async () => {
  const serving = { temperature: { min: 8, max: 10, source: 'style' }, unit: 'C', needsAir: 'none' };
  auth = { apiFetch: fetchWine, user: null };
  body = { wine: { ...WINE, serving }, context: CONTEXT };
  const { unmount } = renderPage();
  await screen.findByText('wineDetail.whenToDrink');
  expect(document.querySelector('.bd-ai-serving').textContent)
    .toBe('serving.label:serving.temperature|{"range":"8–10 °C"} · serving.needsAir.none (serving.bySommelier)');
  unmount();

  auth = { apiFetch: fetchWine, user: { id: 'u1', preferences: { temperatureUnit: 'F' } } };
  body = { wine: { ...WINE, serving: { ...serving, needsAir: null } }, context: CONTEXT };
  renderPage();
  await screen.findByText('wineDetail.whenToDrink');
  expect(document.querySelector('.bd-ai-serving').textContent)
    .toBe('serving.label:serving.temperature|{"range":"46–50 °F"} (serving.byStyle)');
});

test('a member sees the drink windows', async () => {
  auth = { apiFetch: fetchWine, user: { id: 'u1', preferences: {} } };
  body = { wine: WINE, context: { ...CONTEXT, drinkWindows: [WINDOW] } };
  renderPage();
  expect(await screen.findByText('2025')).toBeInTheDocument();
  expect(screen.getByText('wineDetail.windowBest|{"from":2027,"until":2029}')).toBeInTheDocument();
  expect(screen.queryByText('wineDetail.windowTeaserCta')).not.toBeInTheDocument();
});

test('a member with many reviewed vintages sees six, then all on request', async () => {
  auth = { apiFetch: fetchWine, user: { id: 'u1', preferences: {} } };
  const windows = Array.from({ length: 8 }, (_, i) => ({ ...WINDOW, vintage: String(2020 - i) }));
  body = { wine: WINE, context: { ...CONTEXT, reviewedVintages: 8, drinkWindows: windows } };
  renderPage();
  expect(await screen.findByText('2020')).toBeInTheDocument();
  expect(screen.queryByText('2014')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'wineDetail.windowShowAll|{"count":8}' }));
  expect(screen.getByText('2014')).toBeInTheDocument();
});

test('places and grapes link to their pages only when the page exists; related wines link to their pages', async () => {
  auth = { apiFetch: fetchWine, user: null };
  body = { wine: WINE, context: CONTEXT };
  renderPage();
  await screen.findByText('wineDetail.whereFrom');
  const links = screen.getAllByRole('link').map((a) => a.getAttribute('href'));
  expect(links).toContain('/regions/tuscany');
  expect(links).toContain('/grapes/vermentino');
  expect(links).not.toContain('/countries/italy');
  expect(screen.getByText('Tuscany is one of Italy’s most iconic wine regions.')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Aria di Caiarossa' })).toHaveAttribute('href', '/wines/caiarossa-aria-di-caiarossa');
  expect(screen.getByRole('link', { name: 'Costa Toscana Bianco' })).toHaveAttribute('href', '/wines/podere-la-regola-costa-toscana-bianco');
  const details = document.querySelector('.wd-details');
  expect(within(details).getByText('Italy').tagName).not.toBe('A');
});

test('without a context the page shows the wine and none of the new cards', async () => {
  auth = { apiFetch: fetchWine, user: null };
  body = { wine: WINE };
  renderPage();
  expect(await screen.findByText('Pergolaia Bianco')).toBeInTheDocument();
  expect(screen.queryByText('wineDetail.whenToDrink')).not.toBeInTheDocument();
  expect(screen.queryByText('wineDetail.whereFrom')).not.toBeInTheDocument();
  expect(screen.queryByText('wineDetail.moreWines')).not.toBeInTheDocument();
});
