import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';

// One page per wine and vintage (out for everyone; the classic page is gone).
// The same page for one bottle or many, always in the same order: the wine
// (with its description), the vintage (the sommelier's window, what the
// bottles share or that they differ), the bottles (one row each with what
// differs between them). Drink, Edit vintage and Add are the actions;
// viewers get none.

vi.mock('react-i18next', () => {
  const t = (key, a, b) => {
    const vars = b && typeof b === 'object' ? b : (a && typeof a === 'object' ? a : undefined);
    if (vars && vars.count !== undefined && Object.keys(vars).length === 1) return `${key}:${vars.count}`;
    return vars ? `${key}:${JSON.stringify(vars)}` : key;
  };
  return { useTranslation: () => ({ t, i18n: { language: 'en-GB' } }) };
});
vi.mock('../components/AuthImage', () => ({ default: ({ src, alt }) => <img src={src} alt={alt} /> }));
// A tripwire: the page does not use the cellar menu; were it put back, this
// stand-in would show up and the test below would say so.
vi.mock('../components/CellarNav', () => ({ default: () => <nav data-testid="cellar-nav" /> }));
// A tripwire too: the page is out of early access and carries no beta strip.
vi.mock('../components/BetaBadge', () => ({ default: ({ feature }) => <div data-testid="beta-badge">{feature}</div> }));
vi.mock('../components/bottle/WineRecordSection', () => ({ default: ({ suggestSignal }) => <div data-testid="wine-record">{suggestSignal}</div> }));
vi.mock('../components/bottle/PersonalDataCard', () => ({ default: ({ bottleId, vintage, scope, vintageScopable }) => <div data-testid="personal-data">{bottleId}:{vintage}:{scope}:{String(vintageScopable)}</div> }));
vi.mock('../components/bottle/LotHistory', () => ({ default: ({ bottleId, vintagePage }) => <div data-testid="lot-history">{bottleId}:{JSON.stringify(vintagePage)}</div> }));
vi.mock('../components/DrinkOneModal', () => ({
  default: ({ bottles, onDone }) => <button type="button" onClick={() => onDone(bottles[0], 'gifted')}>drink-stub:{bottles.length}</button>,
}));
vi.mock('../components/EditVintageModal', () => ({
  default: ({ bottles, focus, onDone }) => (
    <button type="button" onClick={onDone}>edit-stub:{bottles.map((b) => b._id).join(',')}{focus ? `|focus:${focus}` : ''}</button>
  ),
}));
vi.mock('../components/AddMoreBottlesModal', () => ({
  default: ({ bottle }) => <div data-testid="add-more">{bottle._id}:{bottle.vintage}</div>,
}));
vi.mock('../components/AddToPickListModal', () => ({
  default: ({ choices }) => <div data-testid="pick-list">{choices.map((b) => b._id).join(',')}</div>,
}));
vi.mock('../components/ReportWineModal', () => ({ default: ({ defaultReason }) => <div data-testid="report">{String(defaultReason)}</div> }));
vi.mock('../components/RecommendWineModal', () => ({ default: ({ wineId, wineName }) => <div data-testid="recommend">{wineId}:{wineName}</div> }));
vi.mock('../components/BarcodeScanModal', () => ({
  default: ({ bottles, otherCount, onSaved }) => (
    <div>
      <button type="button" onClick={() => onSaved('7310070000002', { done: bottles.length, total: bottles.length })}>
        barcode-stub:{bottles.map((b) => b._id).join(',')}|others:{otherCount}
      </button>
      <button type="button" onClick={() => onSaved('7310070000002', { done: bottles.length - 1, total: bottles.length })}>barcode-partial</button>
    </div>
  ),
}));
vi.mock('../components/ImageGallery', () => ({ default: ({ bottleId, vintage, vintageScope }) => <div data-testid="gallery">{bottleId}:{vintage}:{vintageScope ? 'all-bottles' : 'one-bottle'}</div> }));
vi.mock('../components/ImageUpload', () => ({ default: ({ bottleId, wineDefinitionId }) => <div data-testid="upload">{bottleId}:{wineDefinitionId}</div> }));
vi.mock('../components/bottle/WineReviewsCard', () => ({ default: ({ wine, vintage }) => <div data-testid="reviews">{wine._id}:{vintage}</div> }));
vi.mock('../components/bottle/OwnerInquiryCard', () => ({ default: ({ wineId }) => <div data-testid="inquiry">{wineId}</div> }));
vi.mock('../components/bottle/PriceHistoryTimeline', () => ({ default: ({ history }) => <div data-testid="price-history">{history.length}</div> }));
vi.mock('../components/bottle/PriceTrackingToggle', () => ({ default: ({ bottleId, vintage }) => <div data-testid="price-tracking">{bottleId}:{vintage}</div> }));
vi.mock('../utils/currency', () => ({ fetchRates: async () => null }));

let auth;
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => auth }));

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const WINE = {
  _id: 'w1', name: 'Château Margaux', producer: 'Château Margaux', slug: 'chateau-margaux', type: 'red',
  region: { name: 'Margaux' }, country: { name: 'France' },
  aiProfile: { description: 'Cassis, cedar and violets.', source: 'curator' },
};
const bottle = (id, over = {}) => ({
  _id: id, status: 'active', vintage: '2015', price: 400, currency: 'EUR', notes: 'En primeur',
  drinkFrom: 2025, drinkTo: 2045, wineDefinition: WINE, rackInfo: null, cellar: 'c1', ...over,
});
let page;
let api;

function Where() {
  const loc = useLocation();
  return <div data-testid="where">{loc.pathname}|{JSON.stringify(loc.state)}</div>;
}
const renderPage = (at = '/cellars/c1/vintages/w1/2015') => render(
  <MemoryRouter initialEntries={[at]}>
    <Routes>
      <Route path="/cellars/:id/vintages/:wineId/:vintage" element={<CellarVintage />} />
      <Route path="/cellars/:id/bottles/:bottleId" element={<Where />} />
    </Routes>
  </MemoryRouter>,
);
const { default: CellarVintage } = await import('./CellarVintage');
const { __setFeatureFlagsForTest } = await import('../utils/featureFlags');

beforeEach(() => {
  page = {
    cellar: { _id: 'c1', name: 'Home', userRole: 'owner', userColor: null },
    wine: WINE,
    vintage: '2015',
    bottles: [
      bottle('b1', { rackInfo: { rackId: 'r1', rackName: 'Left wall', position: 3 }, purchaseLocation: 'Systembolaget', bottleSize: '1500ml' }),
      bottle('b2', { rackInfo: { rackId: 'r1', rackName: 'Left wall', position: 7 }, price: 380 }),
      bottle('b3', { notes: 'Gift from Anna' }),
    ],
    total: 3, onOrderCount: 0, consumedCount: 1, historyBottleId: 'b1', historyBottleVintage: '2015',
  };
  api = vi.fn(async (url) => {
    if (url === '/api/cellars/c1/vintages/w1/2015') return ok(page);
    if (url.startsWith('/api/somm/maturity/lookup')) return ok({ profile: { status: 'reviewed', peakFrom: 2030, peakUntil: 2045 } });
    if (url === '/api/bottles/b9') return ok({ bottle: bottle('b9', { status: 'drank' }) });
    return ok({});
  });
  auth = { apiFetch: api, user: { id: 'u1', preferences: { ratingScale: '5', earlyAccess: true } } };
});

test('the wine, then the vintage, then the bottles — with the description, and no beta strip', async () => {
  renderPage();
  const wineTitle = await screen.findByText('cellarVintageBeta.wineTitle');
  const vintageTitle = screen.getByText('cellarVintageBeta.vintageTitle:{"vintage":"2015"}');
  const bottlesTitle = screen.getByText('cellarVintage.bottlesTitle');
  // Document order: wine → vintage → bottles.
  expect(wineTitle.compareDocumentPosition(vintageTitle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(vintageTitle.compareDocumentPosition(bottlesTitle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

  expect(screen.getByText('Cassis, cedar and violets.')).toBeInTheDocument();
  expect(screen.getByText('Château Margaux · Margaux · France')).toBeInTheDocument();
  expect(screen.queryByTestId('beta-badge')).toBeNull();
  // The stock line heads the bottle list (no summary box above the page).
  const stock = document.querySelector('.cvb-bottles .cvb-stock');
  expect(stock).toHaveTextContent('cellarVintageBeta.rackSlots:{"rack":"Left wall","slots":"3, 7","count":2}');
  expect(stock).toHaveTextContent('cellarVintage.drunk:1');
  expect(stock).toHaveTextContent('cellarVintageBeta.paid:{"amount":"1,180 EUR","count":3}');
  expect(document.querySelector('.cvb-summary')).toBeNull();
  // No cellar menu between the title and the page: it belongs to the cellar.
  expect(screen.queryByTestId('cellar-nav')).toBeNull();
  // The sommelier window, from the lookup.
  expect(screen.getByText('2030–2045')).toBeInTheDocument();
  // Own data on this vintage or all vintages, never "this bottle"; the
  // history card in its vintage-page form (drunk bottles + other vintages).
  expect(screen.getByTestId('personal-data')).toHaveTextContent('b1:2015:vintage:true');
  expect(screen.getByTestId('lot-history')).toHaveTextContent('b1:{"cellarId":"c1","fromPath":"/cellars/c1/vintages/w1/2015","consumedCount":1}');
});

test('what the bottles share shows once; what differs says so; each row shows what differs between bottles', async () => {
  renderPage();
  // The window is shared, the notes are not.
  expect(await screen.findByText('2025–2045')).toBeInTheDocument();
  expect(screen.getByText('cellarVintageBeta.notesDiffer')).toBeInTheDocument();

  const rows = [...document.querySelectorAll('.cvb-bottle-list > li')];
  expect(rows).toHaveLength(3);
  expect(within(rows[0]).getByText(/drinkOne.slot:.*"rack":"Left wall","position":3/)).toBeInTheDocument();
  // Size only when it is not a standard bottle; price, shop.
  expect(within(rows[0]).getByText(/1500ml|1\.5/)).toBeInTheDocument();
  expect(within(rows[0]).getByText(/400 EUR · Systembolaget/)).toBeInTheDocument();
  expect(within(rows[1]).getByText('380 EUR')).toBeInTheDocument();
  expect(within(rows[2]).getByText('drinkOne.unplaced')).toBeInTheDocument();
  // With differing notes, each row carries its own.
  expect(within(rows[2]).getByText('Gift from Anna')).toBeInTheDocument();
});

test('a row opens the bottle page, which is told to lead back here', async () => {
  renderPage();
  await screen.findByText('cellarVintageBeta.kindLine:{"count":3,"cellar":"Home"}');
  const rows = [...document.querySelectorAll('.cvb-bottle-list > li')];
  fireEvent.click(within(rows[1]).getByRole('link'));
  expect(screen.getByTestId('where').textContent).toBe('/cellars/c1/bottles/b2|{"fromVintage":"/cellars/c1/vintages/w1/2015"}');
});

test('Drink, Edit vintage and Add act on this vintage\'s bottles; the page reloads after each', async () => {
  renderPage();
  await screen.findByText('cellarVintageBeta.kindLine:{"count":3,"cellar":"Home"}');
  // Two surfaces (header and phone bar) carry the same actions.
  fireEvent.click(screen.getAllByText('cellarVintageBeta.drinkShort')[0]);
  page = { ...page, bottles: page.bottles.slice(1), total: 2 };
  fireEvent.click(await screen.findByText('drink-stub:3'));
  expect(await screen.findByText('cellarVintageBeta.kindLine:{"count":2,"cellar":"Home"}')).toBeInTheDocument();
  // Said with Undo now, not only "Logged" (live walkthrough 2026-10-15).
  expect(screen.getByRole('status')).toHaveTextContent('bottleNotice.takenOut');
  expect(screen.getByText('common.undo')).toBeInTheDocument();

  fireEvent.click(screen.getAllByText('cellarVintageBeta.editVintage')[0]);
  fireEvent.click(await screen.findByText('edit-stub:b2,b3'));
  expect(await screen.findByText('cellarVintageBeta.savedNote')).toBeInTheDocument();

  fireEvent.click(screen.getAllByText('cellarVintageBeta.add')[0]);
  expect(await screen.findByTestId('add-more')).toHaveTextContent('b2:2015');
});

test('nothing left: Add copies the last bottle drunk — buying the same vintage again', async () => {
  page = { ...page, bottles: [], total: 0, historyBottleId: 'b9' };
  renderPage();
  expect(await screen.findByText('cellarVintage.noneLeft')).toBeInTheDocument();
  expect(screen.queryByText('cellarVintageBeta.drinkShort')).toBeNull();
  expect(screen.queryByText('cellarVintageBeta.editVintage')).toBeNull();
  fireEvent.click(screen.getAllByText('cellarVintageBeta.add')[0]);
  expect(await screen.findByTestId('add-more')).toHaveTextContent('b9:2015');
  expect(api).toHaveBeenCalledWith('/api/bottles/b9');
});

test('a viewer of a shared cellar reads the page but gets no Drink, Edit or Add', async () => {
  page.cellar.userRole = 'viewer';
  renderPage();
  await screen.findByText('cellarVintageBeta.kindLine:{"count":3,"cellar":"Home"}');
  expect(screen.queryByText('cellarVintageBeta.drinkShort')).toBeNull();
  expect(screen.queryByText('cellarVintageBeta.editVintage')).toBeNull();
  expect(screen.queryByText('cellarVintageBeta.add')).toBeNull();
});

test('"Suggest a fix to the wine" opens the record\'s suggest mode', async () => {
  renderPage();
  await screen.findByText('cellarVintageBeta.kindLine:{"count":3,"cellar":"Home"}');
  expect(screen.getByTestId('wine-record')).toHaveTextContent('0');
  fireEvent.click(screen.getAllByLabelText('cellarDetail.moreActions')[0]);
  fireEvent.click(screen.getByText('cellarVintageBeta.editWine'));
  await waitFor(() => expect(screen.getByTestId('wine-record')).toHaveTextContent('1'));
});

// Beta feedback 2026-10-14: the bottle page is one level deeper, so the
// vintage page offers "Add to pick list" too, with the bottles to choose from.
test('early access: "Add to pick list" in the ⋮ menu offers the bottles of this vintage', async () => {
  __setFeatureFlagsForTest([{ key: 'pickLists', state: 'beta' }]);
  try {
    renderPage();
    await screen.findByText('cellarVintageBeta.wineTitle');
    fireEvent.click(screen.getAllByLabelText('cellarDetail.moreActions')[0]);
    fireEvent.click(screen.getByRole('menuitem', { name: /pickLists.addAction/ }));
    expect(await screen.findByTestId('pick-list')).toHaveTextContent('b1,b2,b3');
  } finally {
    __setFeatureFlagsForTest([]);
  }
});

test('no "Add to pick list" without the flag, or for a viewer of a shared cellar', async () => {
  const { unmount } = renderPage();
  await screen.findByText('cellarVintageBeta.wineTitle');
  fireEvent.click(screen.getAllByLabelText('cellarDetail.moreActions')[0]);
  expect(screen.queryByRole('menuitem', { name: /pickLists.addAction/ })).toBeNull();
  unmount();

  __setFeatureFlagsForTest([{ key: 'pickLists', state: 'beta' }]);
  try {
    page.cellar.userRole = 'viewer';
    renderPage();
    await screen.findByText('cellarVintageBeta.wineTitle');
    const more = screen.queryAllByLabelText('cellarDetail.moreActions');
    if (more.length) fireEvent.click(more[0]);
    expect(screen.queryByRole('menuitem', { name: /pickLists.addAction/ })).toBeNull();
  } finally {
    __setFeatureFlagsForTest([]);
  }
});

test('the page says what it is: the vintage, with how many bottles and where', async () => {
  renderPage();
  await screen.findByText('cellarVintageBeta.kindLine:{"count":3,"cellar":"Home"}');
  expect(screen.getByText('cellarVintageBeta.kind')).toHaveClass('page-kind');
  expect(screen.getByText('cellarVintageBeta.kindLine:{"count":3,"cellar":"Home"}')).toBeInTheDocument();
  // Each bottle row says it opens that bottle's own page.
  expect(screen.getAllByText('cellarVintageBeta.viewBottle')).toHaveLength(3);
});

test('what belongs to the wine and the vintage is here: photos, price, reviews, curator questions', async () => {
  renderPage();
  await screen.findByText('cellarVintageBeta.kindLine:{"count":3,"cellar":"Home"}');
  // This vintage's photos — of every bottle of it in the cellar, through a
  // bottle of it; "Add a photo" uploads through the same bottle.
  expect(screen.getByTestId('gallery')).toHaveTextContent('b1:2015:all-bottles');
  fireEvent.click(screen.getByText('cellarVintageBeta.addPhotoShort'));
  expect(await screen.findByTestId('upload')).toHaveTextContent('b1:w1');
  // Closing the window reloads the page (the photo may still be cut out).
  const loads = () => api.mock.calls.filter(([u]) => u === '/api/cellars/c1/vintages/w1/2015').length;
  const before = loads();
  fireEvent.click(screen.getByText('common.done'));
  await waitFor(() => expect(loads()).toBe(before + 1));
  // Market price of the vintage; nobody priced it yet, so only the tracking request.
  expect(await screen.findByTestId('price-tracking')).toHaveTextContent('b1:2015');
  expect(screen.queryByTestId('price-history')).toBeNull();
  expect(api).toHaveBeenCalledWith('/api/somm/prices/lookup?wine=w1&vintage=2015');
  expect(screen.getByTestId('reviews')).toHaveTextContent('w1:2015');
  expect(screen.getByTestId('inquiry')).toHaveTextContent('w1');
});

test('the ⋮ menu: a barcode for the bottles of the vintage\'s size, a report, a recommendation', async () => {
  renderPage();
  await screen.findByText('cellarVintageBeta.kindLine:{"count":3,"cellar":"Home"}');
  const openMenu = () => fireEvent.click(screen.getAllByLabelText('cellarDetail.moreActions')[0]);

  // b1 is a magnum — another product with its own code — so the code goes
  // on the two 75 cl bottles and the window is told one is left alone.
  openMenu();
  fireEvent.click(screen.getByText('barcodeScan.title'));
  fireEvent.click(await screen.findByText('barcode-stub:b2,b3|others:1'));
  expect(await screen.findByText('barcodeScan.savedOn:{"count":2,"code":"7310070000002"}')).toBeInTheDocument();

  // Some bottles not changed: the notice says how many were.
  openMenu();
  fireEvent.click(screen.getByText('barcodeScan.title'));
  fireEvent.click(await screen.findByText('barcode-partial'));
  expect(await screen.findByText('barcodeScan.savedSome:{"count":1,"total":2,"code":"7310070000002"}')).toBeInTheDocument();

  openMenu();
  fireEvent.click(screen.getByText('cellarVintageBeta.reportWine'));
  expect(await screen.findByTestId('report')).toHaveTextContent('null');

  // The wine is recommended by its name (the year is not part of it).
  openMenu();
  fireEvent.click(screen.getByText('cellarVintageBeta.recommend'));
  expect(await screen.findByTestId('recommend')).toHaveTextContent('w1:Château Margaux');
});

test('"Change barcode" when the bottles of the size share one; no barcode item when each has its own', async () => {
  page.bottles = [
    bottle('b1', { barcode: '7310070000002' }),
    bottle('b2'),
  ];
  const { unmount } = renderPage();
  await screen.findByText('cellarVintageBeta.kindLine:{"count":2,"cellar":"Home"}');
  fireEvent.click(screen.getAllByLabelText('cellarDetail.moreActions')[0]);
  expect(screen.getByText('barcodeScan.titleChange')).toBeInTheDocument();
  unmount();

  page.bottles = [
    bottle('b1', { barcode: '7310070000002' }),
    bottle('b2', { barcode: '0012345678905' }),
  ];
  renderPage();
  await screen.findByText('cellarVintageBeta.kindLine:{"count":2,"cellar":"Home"}');
  fireEvent.click(screen.getAllByLabelText('cellarDetail.moreActions')[0]);
  expect(screen.queryByText('barcodeScan.title')).toBeNull();
  expect(screen.queryByText('barcodeScan.titleChange')).toBeNull();
});

test('a priced vintage shows its price history and no tracking request', async () => {
  const base = api.getMockImplementation();
  api.mockImplementation(async (url, opts) => (url.startsWith('/api/somm/prices/lookup')
    ? ok({ history: [{ price: 120, currency: 'EUR' }, { price: 140, currency: 'EUR' }] })
    : base(url, opts)));
  renderPage();
  expect(await screen.findByTestId('price-history')).toHaveTextContent('2');
  expect(screen.queryByTestId('price-tracking')).toBeNull();
});

test('a private draft wine: no report, no recommendation, no price tracking (none of them take a draft)', async () => {
  page.wine = { ...WINE, draft: true };
  renderPage();
  await screen.findByText('cellarVintageBeta.kindLine:{"count":3,"cellar":"Home"}');
  await waitFor(() => expect(api).toHaveBeenCalledWith('/api/somm/prices/lookup?wine=w1&vintage=2015'));
  expect(screen.queryByTestId('price-tracking')).toBeNull();
  fireEvent.click(screen.getAllByLabelText('cellarDetail.moreActions')[0]);
  expect(screen.queryByText('cellarVintageBeta.reportWine')).toBeNull();
  expect(screen.queryByText('cellarVintageBeta.recommend')).toBeNull();
  // Its own photo and barcode are still the owner's to add.
  expect(screen.getByText('barcodeScan.title')).toBeInTheDocument();
});

test('a viewer and a demo account get no photo upload and no barcode', async () => {
  page.cellar.userRole = 'viewer';
  const { unmount } = renderPage();
  await screen.findByText('cellarVintageBeta.kindLine:{"count":3,"cellar":"Home"}');
  expect(screen.queryByText('cellarVintageBeta.addPhotoShort')).toBeNull();
  fireEvent.click(screen.getAllByLabelText('cellarDetail.moreActions')[0]);
  expect(screen.queryByText('barcodeScan.title')).toBeNull();
  unmount();

  page.cellar.userRole = 'owner';
  auth = { ...auth, user: { ...auth.user, isDemo: true } };
  renderPage();
  await screen.findByText('cellarVintageBeta.kindLine:{"count":3,"cellar":"Home"}');
  expect(screen.queryByText('cellarVintageBeta.addPhotoShort')).toBeNull();
});

test('the phone bar says "Edit vintage", not just "Edit"', async () => {
  renderPage();
  await screen.findByText('cellarVintageBeta.kindLine:{"count":3,"cellar":"Home"}');
  expect(document.querySelector('.cvb-mobile-actions')).toHaveTextContent('cellarVintageBeta.editVintage');
});

test('one bottle: the stock line speaks in the singular (one slot, "Paid")', async () => {
  page.bottles = [bottle('b1', { rackInfo: { rackId: 'r1', rackName: 'Left wall', position: 147 } })];
  page.consumedCount = 0;
  renderPage();
  await screen.findByText('cellarVintageBeta.kindLine:{"count":1,"cellar":"Home"}');
  const stock = document.querySelector('.cvb-stock');
  expect(stock).toHaveTextContent('cellarVintageBeta.rackSlots:{"rack":"Left wall","slots":"147","count":1}');
  expect(stock).toHaveTextContent('cellarVintageBeta.paid:{"amount":"400 EUR","count":1}');
});

test('a long list starts folded under its stock line; one toggle shows every row and folds them again', async () => {
  page.bottles = Array.from({ length: 8 }, (_, i) => bottle(`b${i + 1}`));
  renderPage();
  await screen.findByText('cellarVintageBeta.kindLine:{"count":8,"cellar":"Home"}');
  expect(document.querySelectorAll('.cvb-bottle-list > li')).toHaveLength(0);
  const toggle = document.querySelector('.cvb-bottles-toggle');
  expect(toggle).toHaveTextContent('cellarVintageBeta.showBottles:8');
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  fireEvent.click(toggle);
  expect(document.querySelectorAll('.cvb-bottle-list > li')).toHaveLength(8);
  // The same button, still in the page (focus stays on it), now folds.
  expect(document.querySelector('.cvb-bottles-toggle')).toBe(toggle);
  expect(toggle).toHaveTextContent('cellarVintageBeta.hideBottles');
  expect(toggle).toHaveAttribute('aria-expanded', 'true');
  expect(toggle).toHaveAttribute('aria-controls', 'cvb-bottle-list');
  fireEvent.click(toggle);
  expect(document.querySelectorAll('.cvb-bottle-list > li')).toHaveLength(0);
});

test('six bottles or fewer are never folded', async () => {
  page.bottles = Array.from({ length: 6 }, (_, i) => bottle(`b${i + 1}`));
  renderPage();
  await screen.findByText('cellarVintageBeta.kindLine:{"count":6,"cellar":"Home"}');
  expect(document.querySelectorAll('.cvb-bottle-list > li')).toHaveLength(6);
  expect(screen.queryByText(/cellarVintageBeta.(showBottles|hideBottles)/)).toBeNull();
});

describe('the folded list and coming back to the page', () => {
  const memoryStorage = () => {
    const m = new Map();
    return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear() };
  };
  beforeEach(() => { vi.stubGlobal('sessionStorage', memoryStorage()); });
  afterEach(() => { vi.unstubAllGlobals(); });

  test('back from one of its bottles, an unfolded list is still unfolded', async () => {
    page.bottles = Array.from({ length: 8 }, (_, i) => bottle(`b${i + 1}`));
    const { unmount } = renderPage();
    await screen.findByText('cellarVintageBeta.kindLine:{"count":8,"cellar":"Home"}');
    fireEvent.click(document.querySelector('.cvb-bottles-toggle'));
    unmount();
    renderPage();
    await screen.findByText('cellarVintageBeta.kindLine:{"count":8,"cellar":"Home"}');
    expect(document.querySelectorAll('.cvb-bottle-list > li')).toHaveLength(8);
  });

  test('when the notes differ and the list is folded, the hint opens the list', async () => {
    page.bottles = Array.from({ length: 8 }, (_, i) => bottle(`b${i + 1}`, { notes: `Note ${i}` }));
    renderPage();
    await screen.findByText('cellarVintageBeta.kindLine:{"count":8,"cellar":"Home"}');
    const hint = screen.getByText(/cellarVintageBeta.notesDiffer/);
    fireEvent.click(within(hint).getByRole('button'));
    expect(document.querySelectorAll('.cvb-bottle-list > li')).toHaveLength(8);
    expect(within(hint).queryByRole('button')).toBeNull();
  });
});

test('own data is told when "this vintage" cannot be scoped (an NV group of empty vintages)', async () => {
  page.historyBottleVintage = null;
  renderPage();
  await screen.findByText('cellarVintageBeta.kindLine:{"count":3,"cellar":"Home"}');
  expect(screen.getByTestId('personal-data')).toHaveTextContent(':vintage:false');
});

test('a vintage with a "%" in it does not crash the page (the router has decoded it already)', async () => {
  renderPage('/cellars/c1/vintages/w1/100%25');
  expect(await screen.findByText('cellarVintageBeta.wineTitle')).toBeInTheDocument();
});

// Beta feedback 2026-10-12: every block folds, and stays folded next time.
describe('folding blocks', () => {
  test('a section folded on the account starts folded; a click folds another and saves the whole list', async () => {
    auth.user.preferences.collapsedBlocks = ['vintage.bottles'];
    auth.updatePreferences = vi.fn().mockResolvedValue({ success: true });
    renderPage();
    await screen.findByText('cellarVintageBeta.kindLine:{"count":3,"cellar":"Home"}');
    expect(document.getElementById('cvb-bottles-body')).not.toBeVisible();
    expect(document.getElementById('cvb-wine-body')).toBeVisible();

    const wineToggle = document.querySelector('[aria-controls="cvb-wine-body"]');
    expect(wineToggle).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(wineToggle);
    expect(document.getElementById('cvb-wine-body')).not.toBeVisible();
    expect(wineToggle).toHaveAttribute('aria-expanded', 'false');
    await waitFor(() => expect(auth.updatePreferences).toHaveBeenLastCalledWith({ collapsedBlocks: ['vintage.bottles', 'vintage.wine'] }));
  });

  test('a card folds to its title row: the card stays, the block is marked folded and saved', async () => {
    auth.updatePreferences = vi.fn().mockResolvedValue({ success: true });
    renderPage();
    await screen.findByTestId('reviews');
    // The reviews card is mocked as a plain div (no .card), so no button: the
    // button only appears for a real card. The tasting profile is real.
    const tasting = document.querySelector('[data-block="vintage.tasting"]');
    const button = tasting.querySelector('.cblock-toggle');
    fireEvent.click(button);
    expect(tasting).toHaveClass('cblock--collapsed');
    await waitFor(() => expect(auth.updatePreferences).toHaveBeenLastCalledWith({ collapsedBlocks: ['vintage.tasting'] }));
    expect(within(tasting).getByText('bottleDetail.tastingProfile')).toBeInTheDocument();
  });

  test('"Suggest a fix" unfolds the wine record it opens', async () => {
    auth.user.preferences.collapsedBlocks = ['vintage.wine', 'vintage.record'];
    auth.updatePreferences = vi.fn().mockResolvedValue({ success: true });
    renderPage();
    await screen.findByText('cellarVintageBeta.kindLine:{"count":3,"cellar":"Home"}');
    expect(document.getElementById('cvb-wine-body')).not.toBeVisible();
    fireEvent.click(screen.getAllByLabelText('cellarDetail.moreActions')[0]);
    fireEvent.click(screen.getByText('cellarVintageBeta.editWine'));
    expect(document.getElementById('cvb-wine-body')).toBeVisible();
    expect(document.querySelector('[data-block="vintage.record"]')).not.toHaveClass('cblock--collapsed');
    await waitFor(() => expect(auth.updatePreferences).toHaveBeenLastCalledWith({ collapsedBlocks: [] }));
  });
});

// "Your drink window" has a way in of its own, for whoever may edit the
// vintage: classic opens Edit vintage at its window years; early access
// slides the window on the timeline's bar in place and saves it on every
// bottle of the vintage here through the bulk route.
describe('the vintage\'s own drink window', () => {
  const windowBlock = () => screen.getByText('cellarVintage.yourWindow').closest('.cvb-block');
  const noWindow = { drinkFrom: null, drinkTo: null };
  const loads = () => api.mock.calls.filter(([u]) => u === '/api/cellars/c1/vintages/w1/2015').length;
  const bulkCalls = () => api.mock.calls.filter(([u]) => u === '/api/bottles/bulk');
  const sentBulk = () => JSON.parse(bulkCalls()[0][1].body);
  const sliderYear = (name) => Number(screen.getByRole('slider', { name }).getAttribute('aria-valuenow'));
  // The bulk route's answer; the page read back afterwards holds `after`.
  const bulkAnswers = (answer, after) => {
    const base = api.getMockImplementation();
    api.mockImplementation(async (url, opts) => {
      if (url !== '/api/bottles/bulk') return base(url, opts);
      if (after) page = { ...page, bottles: page.bottles.map((b) => ({ ...b, ...after })) };
      return answer;
    });
  };

  describe('classic', () => {
    test('"Not set yet. · Set your own window" opens Edit vintage at its window', async () => {
      page.bottles = page.bottles.map((b) => ({ ...b, ...noWindow }));
      renderPage();
      await screen.findByText('cellarVintageBeta.kindLine:{"count":3,"cellar":"Home"}');
      expect(windowBlock()).toHaveTextContent('cellarVintageBeta.notSet · bottleDetail.windowSetOwn');
      fireEvent.click(within(windowBlock()).getByRole('button', { name: 'bottleDetail.windowSetOwn' }));
      expect(await screen.findByText('edit-stub:b1,b2,b3|focus:drinkWindow')).toBeInTheDocument();
    });

    test('a shared window gets "Change"; differing windows "Set one window for all" — both open it at the window', async () => {
      const { unmount } = renderPage();
      await screen.findByText('cellarVintageBeta.kindLine:{"count":3,"cellar":"Home"}');
      expect(within(windowBlock()).getByText('2025–2045')).toBeInTheDocument();
      fireEvent.click(within(windowBlock()).getByRole('button', { name: 'bottleDetail.windowChangeLabel' }));
      expect(await screen.findByText('edit-stub:b1,b2,b3|focus:drinkWindow')).toBeInTheDocument();
      unmount();

      page.bottles[1] = { ...page.bottles[1], drinkFrom: 2027 };
      renderPage();
      await screen.findByText('cellarVintageBeta.kindLine:{"count":3,"cellar":"Home"}');
      expect(windowBlock()).toHaveTextContent('cellarVintageBeta.windowDiffers');
      fireEvent.click(within(windowBlock()).getByRole('button', { name: 'cellarVintageBeta.windowSetForAll' }));
      expect(await screen.findByText('edit-stub:b1,b2,b3|focus:drinkWindow')).toBeInTheDocument();
    });

    test('Edit vintage itself still opens at the top of the dialog', async () => {
      renderPage();
      await screen.findByText('cellarVintageBeta.kindLine:{"count":3,"cellar":"Home"}');
      fireEvent.click(screen.getAllByText('cellarVintageBeta.editVintage')[0]);
      expect(await screen.findByText('edit-stub:b1,b2,b3')).toBeInTheDocument();
    });

    test('a viewer of a shared cellar reads the window but gets no link', async () => {
      page.cellar.userRole = 'viewer';
      const { unmount } = renderPage();
      await screen.findByText('cellarVintageBeta.kindLine:{"count":3,"cellar":"Home"}');
      expect(within(windowBlock()).getByText('2025–2045')).toBeInTheDocument();
      expect(within(windowBlock()).queryByRole('button')).toBeNull();
      unmount();
      page.bottles = page.bottles.map((b) => ({ ...b, ...noWindow }));
      renderPage();
      await screen.findByText('cellarVintageBeta.kindLine:{"count":3,"cellar":"Home"}');
      expect(windowBlock()).toHaveTextContent('cellarVintageBeta.notSet');
      expect(within(windowBlock()).queryByRole('button')).toBeNull();
    });
  });

  describe('early access', () => {
    beforeEach(() => { __setFeatureFlagsForTest([{ key: 'maturityTimeline', state: 'beta' }]); });
    afterEach(() => { __setFeatureFlagsForTest([]); });

    test('a shared window is a timeline with its own status; Adjust saves the four years on every bottle, then the page reloads', async () => {
      bulkAnswers(ok({ done: 3, doneIds: ['b1', 'b2', 'b3'], skipped: [] }), { drinkFrom: 2026 });
      renderPage();
      await screen.findByText('cellarVintageBeta.kindLine:{"count":3,"cellar":"Home"}');
      const timeline = within(windowBlock()).getByTestId('maturity-timeline');
      expect(timeline.querySelector('.mt-now-label')).toHaveTextContent(`${new Date().getFullYear()} · bottleDetail.personalDrinkNow`);
      fireEvent.click(within(windowBlock()).getByRole('button', { name: 'bottleDetail.windowAdjustLabel' }));
      expect([sliderYear('bottleDetail.windowHandleDrinkFrom'), sliderYear('bottleDetail.windowHandleDrinkTo')]).toEqual([2025, 2045]);
      fireEvent.keyDown(screen.getByRole('slider', { name: 'bottleDetail.windowHandleDrinkFrom' }), { key: 'ArrowRight' });
      // The editor says it writes to every bottle here, as Edit vintage does.
      expect(within(windowBlock()).getByText('editVintage.intro:3')).toBeInTheDocument();
      const before = loads();
      fireEvent.click(within(windowBlock()).getByRole('button', { name: 'editVintage.submit' }));

      expect(await screen.findByText('cellarVintageBeta.savedNote')).toBeInTheDocument();
      expect(sentBulk()).toEqual({
        action: 'update',
        bottleIds: ['b1', 'b2', 'b3'],
        fields: { drinkFrom: 2026, peakFrom: null, peakUntil: null, drinkTo: 2045 },
      });
      await waitFor(() => expect(screen.queryByRole('slider')).toBeNull());
      expect(loads()).toBe(before + 1);
      // The page as reloaded, the keyboard back on its action.
      expect(within(windowBlock()).getByRole('button', { name: 'bottleDetail.windowAdjustLabel' })).toHaveFocus();
    });

    test('windows that differ: "Set one window for all" starts from the sommelier\'s years and sets one window on every bottle', async () => {
      page.bottles[1] = { ...page.bottles[1], drinkFrom: 2027 };
      bulkAnswers(ok({ done: 3, doneIds: ['b1', 'b2', 'b3'], skipped: [] }));
      renderPage();
      await screen.findByText('cellarVintageBeta.kindLine:{"count":3,"cellar":"Home"}');
      // The sommelier's window (2030–2045) has loaded.
      await screen.findByText('2030–2045');
      expect(within(windowBlock()).queryByTestId('maturity-timeline')).toBeNull();
      fireEvent.click(within(windowBlock()).getByRole('button', { name: 'cellarVintageBeta.windowSetForAll' }));
      expect([sliderYear('bottleDetail.windowHandleDrinkFrom'), sliderYear('bottleDetail.windowHandleDrinkTo')]).toEqual([2030, 2045]);
      // Not a window of their own yet: nothing to remove.
      expect(screen.queryByRole('button', { name: 'bottleDetail.windowRemoveMine' })).toBeNull();
      fireEvent.click(within(windowBlock()).getByRole('button', { name: 'editVintage.submit' }));
      await waitFor(() => expect(bulkCalls()).toHaveLength(1));
      expect(sentBulk()).toEqual({
        action: 'update',
        bottleIds: ['b1', 'b2', 'b3'],
        fields: { drinkFrom: 2030, peakFrom: null, peakUntil: null, drinkTo: 2045 },
      });
    });

    test('not set yet: "Set your own window" opens the editor in place', async () => {
      page.bottles = page.bottles.map((b) => ({ ...b, ...noWindow }));
      renderPage();
      await screen.findByText('2030–2045');
      fireEvent.click(within(windowBlock()).getByRole('button', { name: 'bottleDetail.windowSetOwn' }));
      expect(within(windowBlock()).getAllByRole('slider')).toHaveLength(2);
      // Cancel leaves the bottles alone.
      fireEvent.click(within(windowBlock()).getByRole('button', { name: 'common.cancel' }));
      expect(screen.queryByRole('slider')).toBeNull();
      expect(bulkCalls()).toHaveLength(0);
      expect(within(windowBlock()).getByRole('button', { name: 'bottleDetail.windowSetOwn' })).toHaveFocus();
    });

    test('bottles the bulk route skips are counted in the notice; a refusal keeps the editor open with its message', async () => {
      bulkAnswers(ok({ done: 2, doneIds: ['b1', 'b2'], skipped: [{ id: 'b3', reason: 'invalid' }] }));
      const { unmount } = renderPage();
      await screen.findByText('cellarVintageBeta.kindLine:{"count":3,"cellar":"Home"}');
      fireEvent.click(within(windowBlock()).getByRole('button', { name: 'bottleDetail.windowAdjustLabel' }));
      fireEvent.click(within(windowBlock()).getByRole('button', { name: 'editVintage.submit' }));
      expect(await screen.findByText('bulk.doneInfo:2 bulk.windowSkippedInfo:1')).toBeInTheDocument();
      unmount();

      bulkAnswers({ ok: false, status: 403, json: async () => ({ error: 'Not allowed' }) });
      renderPage();
      await screen.findByText('cellarVintageBeta.kindLine:{"count":3,"cellar":"Home"}');
      fireEvent.click(within(windowBlock()).getByRole('button', { name: 'bottleDetail.windowAdjustLabel' }));
      fireEvent.click(within(windowBlock()).getByRole('button', { name: 'editVintage.submit' }));
      expect(await within(windowBlock()).findByRole('alert')).toHaveTextContent('Not allowed');
      expect(within(windowBlock()).getAllByRole('slider')).toHaveLength(2);
    });

    test('a viewer sees the timeline, with no Adjust', async () => {
      page.cellar.userRole = 'viewer';
      renderPage();
      await screen.findByText('cellarVintageBeta.kindLine:{"count":3,"cellar":"Home"}');
      expect(within(windowBlock()).getByTestId('maturity-timeline')).toBeInTheDocument();
      expect(within(windowBlock()).queryByRole('button')).toBeNull();
    });
  });
});

// Release audit 2026-10-16: NV follows the bottle page's rule — a window
// only in relative mode and with a year to measure from.
describe('NV maturity', () => {
  const nvPage = (bottles) => ({ ...page, vintage: 'NV', bottles, total: bottles.length });
  const withProfile = (profile, bottles) => {
    api.mockImplementation(async (url) => {
      if (url === '/api/cellars/c1/vintages/w1/NV') return ok(nvPage(bottles));
      if (url.startsWith('/api/somm/maturity/lookup')) return ok({ profile });
      return ok({});
    });
  };

  test('a relative window with no bottle left to measure from shows no years and no badge', async () => {
    withProfile({ status: 'reviewed', relative: true, earlyFrom: 0, earlyUntil: 1, peakFrom: 1, peakUntil: 3, lateFrom: 3, lateUntil: 5 }, []);
    renderPage('/cellars/c1/vintages/w1/NV');
    await screen.findByText('cellarVintageBeta.wineTitle');
    await waitFor(() => expect(api.mock.calls.some(([u]) => u.startsWith('/api/somm/maturity/lookup'))).toBe(true));
    await new Promise((r) => setTimeout(r, 20));
    expect(document.querySelector('.maturity-badge--declining')).toBeNull();
    expect(screen.queryByText(/^0–1$/)).toBeNull();
  });

  test('an old absolute NV window waits for review, as on the bottle page', async () => {
    withProfile({ status: 'reviewed', peakFrom: 2015, peakUntil: 2018 }, [page.bottles[1]]);
    renderPage('/cellars/c1/vintages/w1/NV');
    expect(await screen.findByText('bottleDetail.awaitingSommelier')).toBeInTheDocument();
  });
});
