import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

// The page of a bottle already drunk: "Move back to cellar" for two days, and
// — new — "Add again", which puts new bottles of the same wine and vintage in
// the cellar (components/AddMoreBottlesModal, as the vintage page's "Add").
// Before, a member who drank one by mistake and wanted it back after the
// window, or simply bought it again, had no way from here but a new scan.

vi.mock('react-i18next', () => {
  const t = (key, a, b) => {
    const vars = b && typeof b === 'object' ? b : (a && typeof a === 'object' ? a : undefined);
    return vars && vars.count !== undefined ? `${key}:${vars.count}` : key;
  };
  return { useTranslation: () => ({ t, i18n: { language: 'en-GB' } }) };
});
// The page's cards are beside the point here.
vi.mock('../components/bottle/HeroImage', () => ({ default: () => null }));
vi.mock('../components/bottle/ConsumedDetails', () => ({ default: () => <div data-testid="consumed-details" /> }));
vi.mock('../components/bottle/ViewDetails', () => ({ default: () => null }));
vi.mock('../components/bottle/EditForm', () => ({ default: () => null }));
vi.mock('../components/BottleJourney', () => ({ default: () => null }));
vi.mock('../components/bottle/OwnerInquiryCard', () => ({ default: () => null }));
vi.mock('../components/bottle/PersonalDataCard', () => ({ default: () => null }));
vi.mock('../components/bottle/LotHistory', () => ({ default: () => null }));
vi.mock('../components/bottle/TastingProfileCard', () => ({ default: () => null }));
vi.mock('../components/bottle/WineReviewsCard', () => ({ default: () => null }));
vi.mock('../components/ShareButton', () => ({ default: () => null }));
vi.mock('../components/CollapsibleBlock', () => ({ default: ({ children }) => <div>{children}</div> }));
vi.mock('../utils/collapsedBlocks', () => ({
  useCollapsedBlocks: () => ({ isCollapsed: () => false, toggle: () => {}, expand: () => {} }),
}));
vi.mock('../utils/featureFlags', () => ({ useFeature: () => false }));
vi.mock('../utils/currency', () => ({ fetchRates: async () => null }));
vi.mock('../components/AddMoreBottlesModal', () => ({
  default: ({ bottle, onAdded, copyDetailsDefault }) => (
    <div data-testid="add-more">
      {bottle._id}:{bottle.status}|copy:{String(copyDetailsDefault)}
      <button type="button" onClick={() => onAdded(3)}>add-three</button>
    </div>
  ),
}));

let auth;
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => auth }));

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const hoursAgo = (h) => new Date(Date.now() - h * 60 * 60 * 1000).toISOString();
const drunk = (over = {}) => ({
  _id: 'b1', cellar: 'c1', status: 'drank', consumedReason: 'drank', vintage: '2016',
  consumedAt: hoursAgo(3), consumedLoggedAt: hoursAgo(3),
  wineDefinition: { _id: 'w1', name: 'Barolo', producer: 'Borgogno', type: 'red' },
  ...over,
});

let api;
const setup = ({ bottle = drunk(), role = 'owner', isDemo = false } = {}) => {
  api = vi.fn(async (url) => {
    if (url === '/api/bottles/b1') return ok({ bottle, userRole: role });
    return ok({});
  });
  auth = { apiFetch: api, user: { id: 'u1', isDemo, preferences: { ratingScale: '5', currency: 'EUR' } } };
};

const { default: BottleDetail } = await import('./BottleDetail');
const renderPage = () => render(
  <MemoryRouter initialEntries={['/cellars/c1/bottles/b1']}>
    <Routes>
      <Route path="/cellars/:id/bottles/:bottleId" element={<BottleDetail />} />
    </Routes>
  </MemoryRouter>,
);

test('a bottle drunk a few hours ago offers both Move back and Add again; Add again copies it into the cellar', async () => {
  setup();
  renderPage();

  expect(await screen.findByRole('button', { name: /bottleDetail\.restore$/ })).toBeInTheDocument();
  const reads = api.mock.calls.filter(([u]) => u === '/api/bottles/b1').length;
  fireEvent.click(screen.getByRole('button', { name: /bottleDetail\.addAgain$/ }));

  // A new purchase: the old bottle's details are not copied unless asked for.
  expect(await screen.findByTestId('add-more')).toHaveTextContent('b1:drank|copy:false');
  fireEvent.click(screen.getByText('add-three'));

  expect(await screen.findByText('bottleDetail.addMore.success:3')).toBeInTheDocument();
  expect(screen.queryByTestId('add-more')).toBeNull();
  await waitFor(() => expect(api.mock.calls.filter(([u]) => u === '/api/bottles/b1').length).toBe(reads + 1));
});

test('a bottle still in the cellar: "Add more bottles" keeps copying its details by default', async () => {
  setup({ bottle: drunk({ status: 'active', consumedReason: undefined, consumedAt: undefined, consumedLoggedAt: undefined }) });
  renderPage();

  fireEvent.click((await screen.findAllByRole('button', { name: 'cellarDetail.moreActions' }))[0]);
  // The header ⋮ and the phone bar's ⋮ share one open state: both menus show.
  fireEvent.click(screen.getAllByRole('menuitem', { name: /bottleDetail\.addMore\.action/ })[0]);

  expect(await screen.findByTestId('add-more')).toHaveTextContent('b1:active|copy:true');
  expect(screen.queryByRole('button', { name: /bottleDetail\.addAgain$/ })).toBeNull();
});

test('past the two days only Add again is left', async () => {
  setup({ bottle: drunk({ consumedAt: hoursAgo(72), consumedLoggedAt: hoursAgo(72) }) });
  renderPage();

  expect(await screen.findByRole('button', { name: /bottleDetail\.addAgain$/ })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /bottleDetail\.restore$/ })).toBeNull();
});

test('a member who may only view gets neither; a demo visitor gets no Add again', async () => {
  setup({ role: 'viewer' });
  const first = renderPage();
  await screen.findByTestId('consumed-details');
  expect(screen.queryByRole('button', { name: /bottleDetail\.restore$/ })).toBeNull();
  expect(screen.queryByRole('button', { name: /bottleDetail\.addAgain$/ })).toBeNull();
  first.unmount();

  setup({ isDemo: true });
  renderPage();
  expect(await screen.findByRole('button', { name: /bottleDetail\.restore$/ })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /bottleDetail\.addAgain$/ })).toBeNull();
});

test('a bottle still waiting on its wine request has no wine to copy: no Add again', async () => {
  setup({ bottle: drunk({ wineDefinition: null, pendingWineRequest: { wineName: 'Unknown red' } }) });
  renderPage();
  await screen.findByTestId('consumed-details');
  expect(screen.queryByRole('button', { name: /bottleDetail\.addAgain$/ })).toBeNull();
});
