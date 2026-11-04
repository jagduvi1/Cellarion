import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

// "Open bottle…" on the bottle page: a bottle in a rack gets "Take it out of
// the rack" (ticked for every method but Coravin), and the page stops
// showing the slot once it is out. A bottle in no rack is not asked.

vi.mock('react-i18next', () => {
  const t = (key, a, b) => {
    const vars = b && typeof b === 'object' ? b : (a && typeof a === 'object' ? a : undefined);
    return vars && vars.count !== undefined ? `${key}:${vars.count}` : key;
  };
  return { useTranslation: () => ({ t, i18n: { language: 'en-GB' } }) };
});
// The page's cards are beside the point here.
vi.mock('../components/bottle/HeroImage', () => ({ default: () => null }));
vi.mock('../components/bottle/ViewDetails', () => ({ default: ({ rackInfo }) => <div data-testid="rack">{rackInfo ? `${rackInfo.rackName}:${rackInfo.position}` : 'unplaced'}</div> }));
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

let auth;
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => auth }));

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const BOTTLE = {
  _id: 'b1', cellar: 'c1', status: 'active', vintage: '2016', bottleSize: '750ml', pours: [], openedAt: null,
  wineDefinition: { _id: 'w1', name: 'Barolo', producer: 'Borgogno', type: 'red' },
};
const RACK = { rackId: 'r1', rackName: 'Left wall', position: 7, inRoom: false };

let api;
let reads;
const setup = ({ rackInfo = RACK } = {}) => {
  reads = 0;
  api = vi.fn(async (url, opts = {}) => {
    if (url === '/api/bottles/b1' && !opts.method) {
      reads += 1;
      return ok({ bottle: BOTTLE, userRole: 'owner', rackInfo });
    }
    if (url === '/api/bottles/b1/open' && opts.method === 'POST') {
      const body = JSON.parse(opts.body);
      return ok({
        bottle: { ...BOTTLE, openedAt: new Date().toISOString(), preservationMethod: body.preservationMethod, pours: [] },
        takenOutOf: body.takeOutOfRack ? { rackId: 'r1', rackName: 'Left wall', position: 7 } : null,
      });
    }
    return ok({});
  });
  auth = { apiFetch: api, user: { id: 'u1', preferences: { ratingScale: '5', currency: 'EUR' } } };
};

const { default: BottleDetail } = await import('./BottleDetail');
const renderPage = () => render(
  <MemoryRouter initialEntries={['/cellars/c1/bottles/b1']}>
    <Routes><Route path="/cellars/:id/bottles/:bottleId" element={<BottleDetail />} /></Routes>
  </MemoryRouter>,
);
const openDialog = async () => {
  fireEvent.click((await screen.findAllByRole('button', { name: /openBottle\.openBtn/ }))[0]);
};
const openCall = () => api.mock.calls.find(([u, o]) => u === '/api/bottles/b1/open' && o?.method === 'POST');

test('a racked bottle opened with a stopper comes out of its slot', async () => {
  setup();
  renderPage();
  expect(await screen.findByTestId('rack')).toHaveTextContent('Left wall:7');
  await openDialog();

  const box = screen.getByRole('checkbox', { name: /openBottle\.takeOut\b/ });
  expect(box).not.toBeChecked(); // Coravin first: it goes back into the rack
  fireEvent.click(screen.getByRole('radio', { name: /openBottle\.method\.vacuum\b/ }));
  expect(box).toBeChecked();
  fireEvent.click(screen.getByRole('button', { name: 'openBottle.confirmBtn' }));

  await waitFor(() => expect(openCall()).toBeTruthy());
  expect(JSON.parse(openCall()[1].body)).toEqual({ preservationMethod: 'vacuum', takeOutOfRack: true });
  await waitFor(() => expect(screen.getByTestId('rack')).toHaveTextContent('unplaced'));
});

test('a Coravin left in its slot keeps it', async () => {
  setup();
  renderPage();
  await screen.findByTestId('rack');
  await openDialog();
  fireEvent.click(screen.getByRole('button', { name: 'openBottle.confirmBtn' }));
  await waitFor(() => expect(openCall()).toBeTruthy());
  expect(JSON.parse(openCall()[1].body)).toEqual({ preservationMethod: 'coravin', takeOutOfRack: false });
  expect(screen.getByTestId('rack')).toHaveTextContent('Left wall:7');
});

test('a bottle in no rack is not asked', async () => {
  setup({ rackInfo: null });
  renderPage();
  expect(await screen.findByTestId('rack')).toHaveTextContent('unplaced');
  await openDialog();
  expect(screen.queryByRole('checkbox', { name: /openBottle\.takeOut\b/ })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'openBottle.confirmBtn' }));
  await waitFor(() => expect(openCall()).toBeTruthy());
  expect(JSON.parse(openCall()[1].body)).toEqual({ preservationMethod: 'coravin' });
});

test('undoing an open that put the bottle back reloads the page to show its slot', async () => {
  setup();
  const opened = { ...BOTTLE, openedAt: new Date().toISOString(), preservationMethod: 'recorked', pours: [] };
  api.mockImplementation(async (url, opts = {}) => {
    if (url === '/api/bottles/b1' && !opts.method) {
      reads += 1;
      return reads === 1
        ? ok({ bottle: opened, userRole: 'owner', rackInfo: null })
        : ok({ bottle: BOTTLE, userRole: 'owner', rackInfo: RACK });
    }
    if (url === '/api/bottles/b1/open' && opts.method === 'DELETE') {
      return ok({ bottle: { ...BOTTLE, openedAt: null, pours: [] }, putBack: { rackId: 'r1', rackName: 'Left wall', position: 7 } });
    }
    return ok({});
  });
  renderPage();
  expect(await screen.findByTestId('rack')).toHaveTextContent('unplaced');
  fireEvent.click(await screen.findByRole('button', { name: /openBottle\.undoOpen/ }));
  await waitFor(() => expect(screen.getByTestId('rack')).toHaveTextContent('Left wall:7'));
  expect(reads).toBe(2);
});
