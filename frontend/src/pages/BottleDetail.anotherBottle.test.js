import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, Link } from 'react-router-dom';

// The bottle page stays mounted when its address changes to another bottle (a
// notification link, the search in the header, Back). What the page held for
// the bottle before stayed on screen: its photo when the next bottle had none,
// an error banner, the curator's question for the other wine. The page is
// keyed by its address, the photos are what each answer says, and the two
// per-wine cards are keyed by the wine.
//
// Harness from BottleDetail.leaveToList.test.js.

vi.mock('react-i18next', () => {
  const t = (key, a, b) => {
    const vars = b && typeof b === 'object' ? b : (a && typeof a === 'object' ? a : undefined);
    return vars && vars.count !== undefined ? `${key}:${vars.count}` : key;
  };
  return { useTranslation: () => ({ t, i18n: { language: 'en-GB' } }) };
});
// The photo the page hands to its picture, in the page's own order of choice.
vi.mock('../components/bottle/HeroImage', () => ({
  default: ({ defaultImage, pendingImage, vintageImage, otherVintageImage }) => (
    <div data-testid="photo">{defaultImage || pendingImage || vintageImage || otherVintageImage || 'no-photo'}</div>
  ),
}));
// "Reload" stands for any action on the page that re-reads the bottle.
vi.mock('../components/bottle/ViewDetails', () => ({
  default: ({ onWineChanged }) => <button type="button" onClick={onWineChanged}>reload</button>,
}));
// The two per-wine cards say which wine they were opened for, as a card that
// keeps what it loaded would.
vi.mock('../components/bottle/OwnerInquiryCard', async () => {
  const { useState: useStateInMock } = await import('react');
  return { default: ({ wineId }) => { const [openedFor] = useStateInMock(wineId); return <div data-testid="inquiry-card">{openedFor}</div>; } };
});
vi.mock('../components/bottle/PersonalDataCard', async () => {
  const { useState: useStateInMock } = await import('react');
  return { default: ({ wineId }) => { const [openedFor] = useStateInMock(wineId); return <div data-testid="personal-card">{openedFor}</div>; } };
});
vi.mock('../components/bottle/EditForm', () => ({ default: () => null }));
vi.mock('../components/BottleJourney', () => ({ default: () => null }));
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
vi.mock('../components/JournalPrompt', () => ({ default: () => null, journalPromptOptedOut: () => true }));

let auth;
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => auth }));

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const refused = (status, body) => ({ ok: false, status, json: async () => body });
const bottle = (id, wine) => ({ _id: id, cellar: 'c1', status: 'active', vintage: '2016', wineDefinition: wine });
const BAROLO = { _id: 'w1', name: 'Barolo', producer: 'Borgogno', type: 'red' };
const RIOJA = { _id: 'w2', name: 'Rioja', producer: 'Example Bodega', type: 'red' };

// What the server answers for each bottle; a test changes it between loads.
let answers;
beforeEach(() => {
  answers = {
    b1: { bottle: bottle('b1', BAROLO), userRole: 'owner', defaultImageUrl: '/api/uploads/b1.webp' },
    b2: { bottle: bottle('b2', RIOJA), userRole: 'owner' },
  };
  const api = vi.fn(async (url) => {
    const read = /^\/api\/bottles\/(b\d)$/.exec(url);
    if (read) return ok(answers[read[1]]);
    if (url === '/api/bottles/b1/consume') return refused(409, { error: 'This bottle is already gone' });
    return ok({});
  });
  auth = { apiFetch: api, user: { id: 'u1', preferences: { ratingScale: '5', currency: 'EUR' } } };
});

const { default: BottleDetail } = await import('./BottleDetail');
const renderAtFirstBottle = () => render(
  <MemoryRouter initialEntries={['/cellars/c1/bottles/b1']}>
    <Link to="/cellars/c1/bottles/b2">to the other bottle</Link>
    <Routes>
      <Route path="/cellars/:id/bottles/:bottleId" element={<BottleDetail />} />
    </Routes>
  </MemoryRouter>,
);
const photo = () => screen.getByTestId('photo').textContent;
const goToTheOtherBottle = async () => {
  fireEvent.click(screen.getByText('to the other bottle'));
  await screen.findByRole('heading', { name: /Rioja/ });
};

test('another bottle does not show the photo of the bottle before', async () => {
  renderAtFirstBottle();
  await waitFor(() => expect(photo()).toMatch(/\/api\/uploads\/b1\.webp$/));

  await goToTheOtherBottle();

  expect(photo()).toBe('no-photo');
});

test('another bottle does not show the error of the bottle before', async () => {
  renderAtFirstBottle();
  fireEvent.click(await screen.findByRole('button', { name: /bottleDetail\.removeBottle$/ }));
  fireEvent.click(await screen.findByText('confirm-drink'));
  expect(await screen.findByText('This bottle is already gone')).toBeInTheDocument();

  await goToTheOtherBottle();

  expect(screen.queryByText('This bottle is already gone')).not.toBeInTheDocument();
});

test('another bottle opens both per-wine cards for its own wine', async () => {
  renderAtFirstBottle();
  await waitFor(() => expect(screen.getByTestId('inquiry-card')).toHaveTextContent('w1'));
  expect(screen.getByTestId('personal-card')).toHaveTextContent('w1');

  await goToTheOtherBottle();

  expect(screen.getByTestId('inquiry-card')).toHaveTextContent('w2');
  expect(screen.getByTestId('personal-card')).toHaveTextContent('w2');
});

test('the same bottle read again after its photo went shows no photo', async () => {
  renderAtFirstBottle();
  await waitFor(() => expect(photo()).toMatch(/\/api\/uploads\/b1\.webp$/));

  answers.b1 = { bottle: bottle('b1', BAROLO), userRole: 'owner' };
  fireEvent.click(screen.getByText('reload'));

  await waitFor(() => expect(photo()).toBe('no-photo'));
});

test('the same bottle moved to another wine opens both per-wine cards for the new wine', async () => {
  renderAtFirstBottle();
  await waitFor(() => expect(screen.getByTestId('inquiry-card')).toHaveTextContent('w1'));

  answers.b1 = { bottle: bottle('b1', RIOJA), userRole: 'owner' };
  fireEvent.click(screen.getByText('reload'));

  await waitFor(() => expect(screen.getByTestId('inquiry-card')).toHaveTextContent('w2'));
  expect(screen.getByTestId('personal-card')).toHaveTextContent('w2');
});
