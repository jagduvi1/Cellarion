import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';

// One page per wine and vintage — the early-access layout. The same page for
// one bottle or many, always in the same order: the wine (with its
// description), the vintage (the sommelier's window, what the bottles share
// or that they differ), the bottles (one row each with what differs between
// them). Drink, Edit vintage and Add are the actions; viewers get none.

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
vi.mock('../components/BetaBadge', () => ({ default: ({ feature }) => <div data-testid="beta-badge">{feature}</div> }));
vi.mock('../components/bottle/WineRecordSection', () => ({ default: ({ suggestSignal }) => <div data-testid="wine-record">{suggestSignal}</div> }));
vi.mock('../components/bottle/PersonalDataCard', () => ({ default: ({ bottleId, vintage }) => <div data-testid="personal-data">{bottleId}:{vintage}</div> }));
vi.mock('../components/bottle/LotHistory', () => ({ default: ({ bottleId }) => <div data-testid="lot-history">{bottleId}</div> }));
vi.mock('../components/DrinkOneModal', () => ({
  default: ({ bottles, onDone }) => <button type="button" onClick={() => onDone(bottles[0], 'gifted')}>drink-stub:{bottles.length}</button>,
}));
vi.mock('../components/EditVintageModal', () => ({
  default: ({ bottles, onDone }) => <button type="button" onClick={onDone}>edit-stub:{bottles.map((b) => b._id).join(',')}</button>,
}));
vi.mock('../components/AddMoreBottlesModal', () => ({
  default: ({ bottle }) => <div data-testid="add-more">{bottle._id}:{bottle.vintage}</div>,
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
const renderPage = () => render(
  <MemoryRouter initialEntries={['/cellars/c1/vintages/w1/2015']}>
    <Routes>
      <Route path="/cellars/:id/vintages/:wineId/:vintage" element={<CellarVintageBeta />} />
      <Route path="/cellars/:id/bottles/:bottleId" element={<Where />} />
    </Routes>
  </MemoryRouter>,
);
const { default: CellarVintageBeta } = await import('./CellarVintageBeta');

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
    total: 3, onOrderCount: 0, consumedCount: 1, historyBottleId: 'b1',
  };
  api = vi.fn(async (url) => {
    if (url === '/api/cellars/c1/vintages/w1/2015') return ok(page);
    if (url.startsWith('/api/somm/maturity/lookup')) return ok({ profile: { status: 'reviewed', peakFrom: 2030, peakUntil: 2045 } });
    if (url === '/api/bottles/b9') return ok({ bottle: bottle('b9', { status: 'drank' }) });
    return ok({});
  });
  auth = { apiFetch: api, user: { id: 'u1', preferences: { ratingScale: '5', earlyAccess: true } } };
});

test('the wine, then the vintage, then the bottles — with the description and the beta strip', async () => {
  renderPage();
  const wineTitle = await screen.findByText('cellarVintageBeta.wineTitle');
  const vintageTitle = screen.getByText('cellarVintageBeta.vintageTitle:{"vintage":"2015"}');
  const bottlesTitle = screen.getByText('cellarVintage.bottlesTitle');
  // Document order: wine → vintage → bottles.
  expect(wineTitle.compareDocumentPosition(vintageTitle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(vintageTitle.compareDocumentPosition(bottlesTitle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

  expect(screen.getByText('Cassis, cedar and violets.')).toBeInTheDocument();
  expect(screen.getByText('Château Margaux · Margaux · France')).toBeInTheDocument();
  expect(screen.getByTestId('beta-badge')).toHaveTextContent('vintagePage');
  expect(screen.getByText('cellarVintage.inCellar:3')).toBeInTheDocument();
  expect(screen.getByText(/cellarVintage.rackSlots:.*"slots":"3, 7"/)).toBeInTheDocument();
  // The sommelier window, from the lookup.
  expect(screen.getByText('2030–2045')).toBeInTheDocument();
  expect(screen.getByTestId('personal-data')).toHaveTextContent('b1:2015');
  expect(screen.getByTestId('lot-history')).toHaveTextContent('b1');
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
  await screen.findByText('cellarVintage.inCellar:3');
  const rows = [...document.querySelectorAll('.cvb-bottle-list > li')];
  fireEvent.click(within(rows[1]).getByRole('link'));
  expect(screen.getByTestId('where').textContent).toBe('/cellars/c1/bottles/b2|{"fromVintage":"/cellars/c1/vintages/w1/2015"}');
});

test('Drink, Edit vintage and Add act on this vintage\'s bottles; the page reloads after each', async () => {
  renderPage();
  await screen.findByText('cellarVintage.inCellar:3');
  // Two surfaces (header and phone bar) carry the same actions.
  fireEvent.click(screen.getAllByText('cellarVintageBeta.drinkShort')[0]);
  page = { ...page, bottles: page.bottles.slice(1), total: 2 };
  fireEvent.click(await screen.findByText('drink-stub:3'));
  expect(await screen.findByText('cellarVintage.inCellar:2')).toBeInTheDocument();
  expect(screen.getByText('cellarVintage.drunkNote')).toBeInTheDocument();

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
  await screen.findByText('cellarVintage.inCellar:3');
  expect(screen.queryByText('cellarVintageBeta.drinkShort')).toBeNull();
  expect(screen.queryByText('cellarVintageBeta.editVintage')).toBeNull();
  expect(screen.queryByText('cellarVintageBeta.add')).toBeNull();
});

test('"Suggest a fix to the wine" opens the record\'s suggest mode', async () => {
  renderPage();
  await screen.findByText('cellarVintage.inCellar:3');
  expect(screen.getByTestId('wine-record')).toHaveTextContent('0');
  fireEvent.click(screen.getAllByLabelText('cellarDetail.moreActions')[0]);
  fireEvent.click(screen.getByText('cellarVintageBeta.editWine'));
  await waitFor(() => expect(screen.getByTestId('wine-record')).toHaveTextContent('1'));
});

test('the page says what it is: the vintage, with how many bottles and where', async () => {
  renderPage();
  await screen.findByText('cellarVintage.inCellar:3');
  expect(screen.getByText('cellarVintageBeta.kind')).toHaveClass('page-kind');
  expect(screen.getByText('cellarVintageBeta.kindLine:{"count":3,"cellar":"Home"}')).toBeInTheDocument();
  // Each bottle row says it opens that bottle's own page.
  expect(screen.getAllByText('cellarVintageBeta.openBottle')).toHaveLength(3);
});

test('what belongs to the wine and the vintage is here: photos, price, reviews, curator questions', async () => {
  renderPage();
  await screen.findByText('cellarVintage.inCellar:3');
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
  await screen.findByText('cellarVintage.inCellar:3');
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
  await screen.findByText('cellarVintage.inCellar:2');
  fireEvent.click(screen.getAllByLabelText('cellarDetail.moreActions')[0]);
  expect(screen.getByText('barcodeScan.titleChange')).toBeInTheDocument();
  unmount();

  page.bottles = [
    bottle('b1', { barcode: '7310070000002' }),
    bottle('b2', { barcode: '0012345678905' }),
  ];
  renderPage();
  await screen.findByText('cellarVintage.inCellar:2');
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
  await screen.findByText('cellarVintage.inCellar:3');
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
  await screen.findByText('cellarVintage.inCellar:3');
  expect(screen.queryByText('cellarVintageBeta.addPhotoShort')).toBeNull();
  fireEvent.click(screen.getAllByLabelText('cellarDetail.moreActions')[0]);
  expect(screen.queryByText('barcodeScan.title')).toBeNull();
  unmount();

  page.cellar.userRole = 'owner';
  auth = { ...auth, user: { ...auth.user, isDemo: true } };
  renderPage();
  await screen.findByText('cellarVintage.inCellar:3');
  expect(screen.queryByText('cellarVintageBeta.addPhotoShort')).toBeNull();
});
