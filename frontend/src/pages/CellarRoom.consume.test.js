import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

// The 3D room's "Drink" opens the one "take out of the cellar" dialog the
// bottle page and the racks use (components/ConsumeModal): the wine, the
// reservation warning, "Just a glass". What follows is the room's own: the
// bottle leaves its slot and the panel closes, a refusal keeps the dialog
// open with the reason, a refused glass says why and stays. The drawing is
// beside the point (three.js): the bottle is picked through ?highlight=.

vi.mock('react-i18next', () => {
  const t = (key, a, b) => {
    const vars = b && typeof b === 'object' ? b : (a && typeof a === 'object' ? a : undefined);
    if (typeof a === 'string' && !vars) return key;
    return vars ? `${key}:${JSON.stringify(vars)}` : key;
  };
  return { useTranslation: () => ({ t, i18n: { language: 'en-GB' } }) };
});
vi.mock('@react-three/fiber', () => ({ Canvas: () => <div data-testid="room-canvas" /> }));
vi.mock('../components/room/RoomScene', () => ({ default: () => null }));
vi.mock('../components/CellarNav', () => ({ default: () => null }));
vi.mock('../components/WineImage', () => ({ default: () => null }));
vi.mock('../components/RatingInput', () => ({ default: () => <div data-testid="rating-input" /> }));
vi.mock('../components/JournalPrompt', () => ({
  default: ({ bottle }) => <div data-testid="journal-prompt">{bottle._id}</div>,
  journalPromptOptedOut: () => false,
}));

let auth;
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => auth }));

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const refused = (status, body) => ({ ok: false, status, json: async () => body });

const bottle = (over = {}) => ({
  _id: 'b1', vintage: '2015', status: 'active',
  wineDefinition: { _id: 'w1', name: 'Château Margaux', producer: 'Château Margaux', type: 'red' },
  ...over,
});
const rackWith = (b) => ({
  _id: 'r1', name: 'Left wall', type: 'grid', rows: 2, cols: 2, cellar: 'c1',
  slots: [{ position: 3, bottle: b }], zones: [], disabledPositions: [],
});

let api;
let consumeResponse;
let pourResponse;
// PUT of slot 3: an Undo putting the bottle back where it came from.
let putResponse;
const setup = (b = bottle()) => {
  consumeResponse = ok({ bottle: { _id: 'b1', status: 'drank' } });
  pourResponse = ok({ bottle: { _id: 'b1' } });
  putResponse = () => ok({ rack: rackWith(b) });
  api = vi.fn(async (url, opts) => {
    if (url === '/api/cellars/c1') return ok({ cellar: { _id: 'c1', name: 'Home', userRole: 'owner' } });
    if (url === '/api/racks?cellar=c1') return ok({ racks: [rackWith(b)] });
    if (url === '/api/racks/r1/slots/3' && opts?.method === 'PUT') return putResponse();
    if (url === '/api/cellar-layout?cellar=c1') return ok({ layout: null });
    if (url === '/api/bottles/b1/consume') return consumeResponse;
    if (url === '/api/bottles/b1/pour') return pourResponse;
    return ok({});
  });
  auth = { apiFetch: api, user: { id: 'u1', preferences: { ratingScale: '5' } } };
};

const renderRoom = () => render(
  <MemoryRouter initialEntries={['/cellars/c1/room?highlight=b1']}>
    <Routes>
      <Route path="/cellars/:id/room" element={<CellarRoom />} />
      <Route path="/cellars/:id/bottles/:bottleId" element={<div>bottle-page</div>} />
    </Routes>
  </MemoryRouter>,
);
const { default: CellarRoom } = await import('./CellarRoom');

const openDrinkDialog = async () => {
  const panel = await screen.findByText('racks.remove');
  fireEvent.click(panel);
  return screen.getByRole('dialog', { name: 'bottleDetail.removeBottleTitle' });
};

test('"Drink" in the room opens the shared dialog: the wine, the warning for a reserved bottle, "Just a glass"', async () => {
  setup(bottle({ reservedFor: 'Anna', reservedUntil: 2030 }));
  renderRoom();
  const dialog = await openDrinkDialog();

  expect(within(dialog).getByText('Château Margaux 2015')).toBeInTheDocument();
  expect(within(dialog).getByRole('alert')).toHaveTextContent('bottleDetail.consumeReservedWarning');
  expect(within(dialog).getByRole('button', { name: /openBottle\.partialOption/ })).toBeInTheDocument();
  expect(within(dialog).getByTestId('rating-input')).toBeInTheDocument();
});

test('confirming takes the bottle out: one request, the panel closes, the journal prompt follows', async () => {
  setup();
  renderRoom();
  const dialog = await openDrinkDialog();
  fireEvent.click(within(dialog).getByRole('button', { name: 'common.confirm' }));

  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'bottleDetail.removeBottleTitle' })).not.toBeInTheDocument());
  expect(api.mock.calls.filter(([u]) => u === '/api/bottles/b1/consume')).toHaveLength(1);
  expect(screen.queryByText('racks.remove')).not.toBeInTheDocument();
  expect(screen.getByTestId('journal-prompt')).toHaveTextContent('b1');
});

const reads = (u) => api.mock.calls.filter(([x]) => x === u).length;
const slotPuts = () => api.mock.calls.filter(([u, o]) => u === '/api/racks/r1/slots/3' && o?.method === 'PUT');
const drinkThenNotice = async () => {
  const dialog = await openDrinkDialog();
  fireEvent.click(within(dialog).getByRole('button', { name: 'common.confirm' }));
  return (await screen.findByText('bottleNotice.drunk:{"name":"Château Margaux 2015"}')).closest('.bottle-undo-notice');
};

test('after a take-out the floating notice offers Undo; Undo puts the bottle back in its slot and closes its journal prompt', async () => {
  setup();
  renderRoom();
  const notice = await drinkThenNotice();
  expect(notice).toHaveClass('bottle-undo-notice--floating');
  expect(screen.getByTestId('journal-prompt')).toHaveTextContent('b1');
  const racksBefore = reads('/api/racks?cellar=c1');
  const layoutBefore = reads('/api/cellar-layout?cellar=c1');

  fireEvent.click(within(notice).getByRole('button', { name: 'common.undo' }));

  expect(await screen.findByText('bottleNotice.restored:{"name":"Château Margaux 2015"}')).toBeInTheDocument();
  expect(api.mock.calls.filter(([u]) => u === '/api/bottles/b1/restore')).toHaveLength(1);
  await waitFor(() => expect(slotPuts()).toHaveLength(1));
  expect(JSON.parse(slotPuts()[0][1].body)).toEqual({ bottleId: 'b1', expectOccupant: null });
  await waitFor(() => expect(screen.queryByTestId('journal-prompt')).not.toBeInTheDocument());
  // Put back: nothing to read again — and never the layout (it may hold unsaved edits).
  expect(reads('/api/racks?cellar=c1')).toBe(racksBefore);
  expect(reads('/api/cellar-layout?cellar=c1')).toBe(layoutBefore);
});

test('a slot taken meanwhile: the bottle stays unplaced and only the racks are read again', async () => {
  setup();
  renderRoom();
  const notice = await drinkThenNotice();
  putResponse = () => refused(409, { error: 'This slot has changed since — check the rack and try again.' });
  const racksBefore = reads('/api/racks?cellar=c1');
  const layoutBefore = reads('/api/cellar-layout?cellar=c1');

  fireEvent.click(within(notice).getByRole('button', { name: 'common.undo' }));

  expect(await screen.findByText('bottleNotice.restored:{"name":"Château Margaux 2015"}')).toBeInTheDocument();
  await waitFor(() => expect(reads('/api/racks?cellar=c1')).toBe(racksBefore + 1));
  expect(reads('/api/cellar-layout?cellar=c1')).toBe(layoutBefore);
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('a refused take-out keeps the dialog open and says why', async () => {
  setup();
  renderRoom();
  const dialog = await openDrinkDialog();
  consumeResponse = refused(400, { error: 'This bottle has already left the cellar.' });
  fireEvent.click(within(dialog).getByRole('button', { name: 'common.confirm' }));

  expect(await screen.findByText('This bottle has already left the cellar.')).toBeInTheDocument();
  expect(screen.getByRole('dialog', { name: 'bottleDetail.removeBottleTitle' })).toBeInTheDocument();
  expect(screen.queryByTestId('journal-prompt')).not.toBeInTheDocument();
});

test('"Just a glass" from an open bottle pours one and shows the bottle; a refused one says why and stays', async () => {
  setup(bottle({ openedAt: '2026-10-10T18:00:00.000Z', preservationMethod: 'coravin' }));
  const first = renderRoom();
  fireEvent.click(within(await openDrinkDialog()).getByRole('button', { name: /openBottle\.partialOption/ }));
  expect(await screen.findByText('bottle-page')).toBeInTheDocument();
  expect(api.mock.calls.filter(([u]) => u === '/api/bottles/b1/pour')).toHaveLength(1);
  first.unmount();

  setup(bottle({ openedAt: '2026-10-10T18:00:00.000Z', preservationMethod: 'coravin' }));
  pourResponse = refused(400, { error: 'This bottle is already finished.' });
  renderRoom();
  fireEvent.click(within(await openDrinkDialog()).getByRole('button', { name: /openBottle\.partialOption/ }));
  expect(await screen.findByText('This bottle is already finished.')).toBeInTheDocument();
  expect(screen.queryByText('bottle-page')).not.toBeInTheDocument();
});
