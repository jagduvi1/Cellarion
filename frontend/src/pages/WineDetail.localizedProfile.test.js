import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

// The public wine page and the language for the AI-written wine texts
// (SuperAdmin → AI). The server sends the translated prose beside the English
// while it is fresh (backend utils/profileLanguage displayProfile); the
// tasting card shows it, marked with its language. A copy made of an older
// English text, or no copy, shows the English as before. The page's meta
// description stays the English one — the same text the crawler page
// (backend og/wine.js) carries.

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k, d) => (typeof d === 'string' ? d : k) }) }));
vi.mock('../components/Layout', () => ({ default: ({ children }) => <div>{children}</div> }));
const seo = vi.fn();
vi.mock('../components/SEOHead', () => ({ default: (props) => { seo(props); return null; } }));
vi.mock('../components/WineImage', () => ({ default: () => null }));
vi.mock('../components/WineDiscussionsPanel', () => ({ default: () => null }));
vi.mock('../components/AddToCellarButton', () => ({ default: () => null }));
vi.mock('../components/WineContextCards', () => ({ WhenToDrinkCard: () => null, WhereFromCard: () => null, MoreWinesCard: () => null }));

let auth;
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => auth }));

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
let body;
const fetchWine = vi.fn(async () => ok(body));
globalThis.fetch = fetchWine;

const { default: WineDetail } = await import('./WineDetail');

const AT = '2026-11-13T10:00:00.000Z';
const WINE = { _id: 'a1b2c3d4e5f6a1b2c3d4e5f6', slug: 'sandrone-cannubi-boschis', name: 'Cannubi Boschis', producer: 'Luciano Sandrone', type: 'red' };
const MEMBER_PROFILE = {
  body: 'full', tannin: 'high', acidity: 'high', sweetness: 'dry', source: 'ai',
  description: 'Firm and fragrant.', flavors: ['tar', 'rose'], foodPairings: ['braised beef'], generatedAt: AT,
};
const COPY = { lang: 'de', description: 'Fest und duftig.', flavors: ['Teer', 'Rose'], foodPairings: ['Schmorbraten'], generatedAt: AT };

const renderPage = () => render(
  <MemoryRouter initialEntries={[`/wines/${WINE.slug}`]}>
    <Routes><Route path="/wines/:idOrSlug" element={<WineDetail />} /></Routes>
  </MemoryRouter>,
);

beforeEach(() => {
  seo.mockClear();
  auth = { apiFetch: fetchWine, user: { id: 'u1' } };
});

test('a member sees the fresh translation in the card; the meta description stays English', async () => {
  body = { wine: { ...WINE, aiProfile: { ...MEMBER_PROFILE, localized: COPY } }, context: null };
  const { container } = renderPage();
  expect(await screen.findByText('Fest und duftig.')).toBeInTheDocument();
  expect(container.querySelector('.bd-ai-prose')).toHaveAttribute('lang', 'de');
  expect(screen.getByText('Teer')).toBeInTheDocument();
  expect(screen.getByText('Schmorbraten')).toHaveAttribute('lang', 'de');
  expect(screen.queryByText('Firm and fragrant.')).toBeNull();
  expect(seo.mock.calls.at(-1)[0].description).toBe('Cannubi Boschis — Luciano Sandrone. Firm and fragrant.');
});

test('a visitor sees the translated description (the tier sends no lists)', async () => {
  auth = { apiFetch: fetchWine, user: null };
  body = {
    wine: { ...WINE, aiProfile: { description: 'Firm and fragrant.', style: 'full-bodied, high tannin', source: 'ai', localized: { lang: 'de', description: 'Fest und duftig.' } } },
    context: null,
  };
  renderPage();
  expect(await screen.findByText('Fest und duftig.')).toBeInTheDocument();
  expect(screen.getByText('full-bodied, high tannin')).toBeInTheDocument();
});

test('a copy made of an older English text: the English', async () => {
  body = { wine: { ...WINE, aiProfile: { ...MEMBER_PROFILE, generatedAt: '2026-11-14T08:00:00.000Z', localized: COPY } }, context: null };
  const { container } = renderPage();
  expect(await screen.findByText('Firm and fragrant.')).toBeInTheDocument();
  expect(screen.getByText('tar')).toBeInTheDocument();
  expect(screen.queryByText('Fest und duftig.')).toBeNull();
  expect(container.querySelector('[lang]')).toBeNull();
});

test('no copy: the English card, as before', async () => {
  body = { wine: { ...WINE, aiProfile: MEMBER_PROFILE }, context: null };
  const { container } = renderPage();
  expect(await screen.findByText('Firm and fragrant.')).toBeInTheDocument();
  expect(container.querySelector('.bd-ai-pairings').textContent).toBe('Pairs with:braised beef');
  expect(container.querySelector('[lang]')).toBeNull();
});
