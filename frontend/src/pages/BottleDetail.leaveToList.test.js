import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';

// Drink on a bottle page lands on the cellar list the visit started from —
// "all my cellars" still chosen if it was — as a coming back. It used to open
// the bottle's own cellar fresh, so the chosen cellars were gone after every
// bottle drunk, and a bottle opened from the all-cellars view of another
// cellar's page landed on its own cellar instead.

vi.mock('react-i18next', () => {
  const t = (key, a, b) => {
    const vars = b && typeof b === 'object' ? b : (a && typeof a === 'object' ? a : undefined);
    return vars && vars.count !== undefined ? `${key}:${vars.count}` : key;
  };
  return { useTranslation: () => ({ t, i18n: { language: 'en-GB' } }) };
});
// The page's cards are beside the point here.
vi.mock('../components/bottle/HeroImage', () => ({ default: () => null }));
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
vi.mock('../components/ConsumeModal', () => ({
  ConsumeModal: ({ onConfirm }) => <button type="button" onClick={() => onConfirm('drank', '', null, '5')}>confirm-drink</button>,
}));
// No journal prompt in between: Drink leaves the page at once.
vi.mock('../components/JournalPrompt', () => ({ default: () => null, journalPromptOptedOut: () => true }));

let auth;
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => auth }));

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const BOTTLE = {
  _id: 'b1', cellar: 'c1', status: 'active', vintage: '2016',
  wineDefinition: { _id: 'w1', name: 'Barolo', producer: 'Borgogno', type: 'red' },
};

beforeEach(() => {
  const api = vi.fn(async (url) => {
    if (url === '/api/bottles/b1') return ok({ bottle: BOTTLE, userRole: 'owner' });
    if (url === '/api/bottles/b1/consume') return ok({ bottle: { ...BOTTLE, status: 'drank' } });
    return ok({});
  });
  auth = { apiFetch: api, user: { id: 'u1', preferences: { ratingScale: '5', currency: 'EUR' } } };
});

function Where() {
  const loc = useLocation();
  return <div data-testid="where">{loc.pathname}{loc.search}|{JSON.stringify(loc.state)}</div>;
}

const { default: BottleDetail } = await import('./BottleDetail');
const renderBottle = (state) => render(
  <MemoryRouter initialEntries={[{ pathname: '/cellars/c1/bottles/b1', state }]}>
    <Routes>
      <Route path="/cellars/:id/bottles/:bottleId" element={<BottleDetail />} />
      <Route path="/cellars/:id" element={<Where />} />
      <Route path="/cellars/:id/vintages/:wineId/:vintage" element={<Where />} />
    </Routes>
  </MemoryRouter>,
);
const drink = async () => {
  fireEvent.click(await screen.findByRole('button', { name: /bottleDetail\.removeBottle$/ }));
  fireEvent.click(await screen.findByText('confirm-drink'));
  const where = (await screen.findByTestId('where')).textContent;
  const [path, state] = where.split('|');
  return { path, state: JSON.parse(state) };
};

test('opened from a cellar list: Drink comes back to that list, with the notice', async () => {
  // The all-cellars view on another cellar's page (the bottle lives in c1).
  renderBottle({ backTo: '/cellars/c2', backFrom: 'cellar' });
  const { path, state } = await drink();
  expect(path).toBe('/cellars/c2');
  expect(state.returning).toBe(true);
  expect(state.bottleNotice).toMatchObject({ kind: 'consumed', reason: 'drank', bottleId: 'b1' });
});

test('opened through the vintage page: Drink comes back to the list that page was opened from', async () => {
  renderBottle({ fromVintage: '/cellars/c1/vintages/w1/2016', cellarList: '/cellars/c2' });
  const { path, state } = await drink();
  expect(path).toBe('/cellars/c2');
  expect(state.returning).toBe(true);
  expect(state.bottleNotice.bottleId).toBe('b1');
});

test('the back link to the vintage page keeps the cellar list for that page', async () => {
  renderBottle({ fromVintage: '/cellars/c1/vintages/w1/2016', cellarList: '/cellars/c2' });
  fireEvent.click(await screen.findByText('bottleDetail.backToVintage'));
  const [path, state] = screen.getByTestId('where').textContent.split('|');
  expect(path).toBe('/cellars/c1/vintages/w1/2016');
  expect(JSON.parse(state)).toEqual({ returning: true, cellarList: '/cellars/c2' });
});

test('opened from anywhere else: Drink opens the bottle\'s own cellar, as before', async () => {
  renderBottle(undefined);
  const { path, state } = await drink();
  expect(path).toBe('/cellars/c1');
  expect(state.returning).toBeUndefined();
  expect(state.bottleNotice.bottleId).toBe('b1');
});

test('a handed list that is not an in-app cellar path is ignored', async () => {
  renderBottle({ backTo: '//evil.example/cellars/c2', backFrom: 'cellar' });
  const { path, state } = await drink();
  expect(path).toBe('/cellars/c1');
  expect(state.returning).toBeUndefined();
});
