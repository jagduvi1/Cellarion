import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

// The rack slot's "Drink" opens the one "take out of the cellar" dialog the
// bottle page uses (components/ConsumeModal) — with "Just a glass" on top and
// the reservation warning the racks' own copy never had (usability plan
// 2026-10-14, D2). What happens after it is the racks page's own: the slot
// empties, the journal prompt follows a drunk bottle, a refusal keeps the
// dialog open with the reason in the floating notice.

vi.mock('react-i18next', () => {
  const t = (key, a, b) => {
    const vars = b && typeof b === 'object' ? b : (a && typeof a === 'object' ? a : undefined);
    return vars ? `${key}:${JSON.stringify(vars)}` : key;
  };
  return { useTranslation: () => ({ t, i18n: { language: 'en-GB' } }) };
});
vi.mock('../components/CellarNav', () => ({ default: () => null }));
vi.mock('../components/WineImage', () => ({ default: () => null }));
vi.mock('../components/RatingInput', () => ({ default: () => <div data-testid="rating-input" /> }));
vi.mock('../utils/featureFlags', () => ({ useFeature: () => false }));
// The drawn rack is beside the point here: one button per filled slot, wired
// to the page's own slot handler.
vi.mock('../components/racks/RackRenderer', () => ({
  default: ({ rack, onSlotClick }) => (
    <div>
      {rack.slots.map((s) => (
        <button key={s.position} type="button" onClick={() => onSlotClick(s.position, s)}>
          slot-{s.position}
        </button>
      ))}
    </div>
  ),
}));
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
let openResponse;
// GET /api/racks (first load, and any re-read) and PUT of slot 3 (an Undo
// putting the bottle back).
let racksResponse;
let putResponse;
const setup = (b = bottle()) => {
  consumeResponse = ok({ bottle: { _id: 'b1', status: 'drank' } });
  pourResponse = ok({ bottle: { _id: 'b1' } });
  openResponse = ok({ bottle: { _id: 'b1' } });
  racksResponse = () => ok({ racks: [rackWith(b)] });
  putResponse = () => ok({ rack: rackWith(b) });
  api = vi.fn(async (url, opts) => {
    if (url === '/api/cellars/c1') return ok({ cellar: { _id: 'c1', name: 'Home', userRole: 'owner' } });
    if (url === '/api/racks?cellar=c1') return racksResponse();
    if (url === '/api/racks/r1/slots/3' && opts?.method === 'PUT') return putResponse();
    if (url === '/api/bottles/b1/consume') return consumeResponse;
    if (url === '/api/bottles/b1/pour') return pourResponse;
    if (url === '/api/bottles/b1/open') return openResponse;
    return ok({});
  });
  auth = { apiFetch: api, user: { id: 'u1', preferences: { ratingScale: '5' } } };
};

const renderPage = () => render(
  <MemoryRouter initialEntries={['/cellars/c1/racks']}>
    <Routes>
      <Route path="/cellars/:id/racks" element={<CellarRacks />} />
      <Route path="/cellars/:id/bottles/:bottleId" element={<div>bottle-page</div>} />
    </Routes>
  </MemoryRouter>,
);
const { default: CellarRacks } = await import('./CellarRacks');

const openDrinkDialog = async () => {
  fireEvent.click(await screen.findByText('slot-3'));
  fireEvent.click(screen.getByRole('button', { name: 'racks.remove' }));
  return screen.getByRole('dialog', { name: 'bottleDetail.removeBottleTitle' });
};

test('"Drink" on a slot opens the shared dialog: the wine, "Just a glass", the date, the shared rating', async () => {
  setup();
  renderPage();
  const dialog = await openDrinkDialog();

  // The slot pop-up has closed; the one dialog is the shared one.
  expect(screen.getAllByRole('dialog')).toHaveLength(1);
  expect(within(dialog).getByText('Château Margaux 2015')).toBeInTheDocument();
  expect(within(dialog).getByRole('button', { name: /openBottle\.partialOption/ })).toBeInTheDocument();
  expect(within(dialog).getByLabelText('bulk.consumeDate')).toHaveAttribute('type', 'date');
  expect(within(dialog).getByTestId('rating-input')).toBeInTheDocument();
  expect(within(dialog).getByPlaceholderText('bottleDetail.notePlaceholder')).toBeInTheDocument();
  // Not reserved: no warning.
  expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
});

test('a reserved bottle now shows the reservation warning on the racks page too', async () => {
  setup(bottle({ reservedFor: 'Anna', reservedUntil: 2030 }));
  renderPage();
  const dialog = await openDrinkDialog();

  expect(within(dialog).getByRole('alert')).toHaveTextContent('bottleDetail.consumeReservedWarning');
  expect(within(dialog).getByRole('alert')).toHaveTextContent('bottleDetail.reservedForUntil');
});

test('"Just a glass" on a sealed bottle leaves the dialog for the preservation picker — nothing is taken out', async () => {
  setup();
  renderPage();
  const dialog = await openDrinkDialog();
  fireEvent.click(within(dialog).getByRole('button', { name: /openBottle\.partialOption/ }));

  expect(screen.queryByRole('dialog', { name: 'bottleDetail.removeBottleTitle' })).not.toBeInTheDocument();
  expect(screen.getByText('openBottle.pickerTitle')).toBeInTheDocument();
  expect(api.mock.calls.some(([u]) => u === '/api/bottles/b1/consume')).toBe(false);
});

test('confirming takes the bottle out: one consume request, the slot empties, the journal prompt follows', async () => {
  setup();
  renderPage();
  const dialog = await openDrinkDialog();
  fireEvent.change(within(dialog).getByLabelText('bulk.consumeDate'), { target: { value: '2026-10-01' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'common.confirm' }));

  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'bottleDetail.removeBottleTitle' })).not.toBeInTheDocument());
  const calls = api.mock.calls.filter(([u]) => u === '/api/bottles/b1/consume');
  expect(calls).toHaveLength(1);
  expect(JSON.parse(calls[0][1].body)).toEqual({ reason: 'drank', consumedRatingScale: '5', consumedAt: '2026-10-01' });
  expect(screen.queryByText('slot-3')).not.toBeInTheDocument();
  expect(screen.getByTestId('journal-prompt')).toHaveTextContent('b1');
});

// A member drank a bottle from a slot by mistake and found no way back from
// here: the take-out is now said with Undo, as on the cellar list.
const drinkAndUndo = async () => {
  const dialog = await openDrinkDialog();
  fireEvent.click(within(dialog).getByRole('button', { name: 'common.confirm' }));
  const notice = (await screen.findByText('bottleNotice.drunk:{"name":"Château Margaux 2015"}')).closest('.bottle-undo-notice');
  expect(screen.queryByText('slot-3')).not.toBeInTheDocument();
  return () => fireEvent.click(within(notice).getByRole('button', { name: 'common.undo' }));
};
const racksReads = () => api.mock.calls.filter(([u]) => u === '/api/racks?cellar=c1').length;
const slotPuts = () => api.mock.calls.filter(([u, o]) => u === '/api/racks/r1/slots/3' && o?.method === 'PUT');

test('after a take-out the floating notice offers Undo beside the journal prompt; Undo puts the bottle back in its slot and closes the prompt', async () => {
  setup();
  renderPage();
  const undo = await drinkAndUndo();
  expect(screen.getByTestId('journal-prompt')).toHaveTextContent('b1');
  const before = racksReads();

  undo();

  expect(await screen.findByText('bottleNotice.restored:{"name":"Château Margaux 2015"}')).toBeInTheDocument();
  const restores = api.mock.calls.filter(([u]) => u === '/api/bottles/b1/restore');
  expect(restores).toHaveLength(1);
  expect(restores[0][1]).toMatchObject({ method: 'POST' });
  // Back where it came from — only if the slot is still empty (the server checks).
  expect(await screen.findByText('slot-3')).toBeInTheDocument();
  expect(slotPuts()).toHaveLength(1);
  expect(JSON.parse(slotPuts()[0][1].body)).toEqual({ bottleId: 'b1', expectOccupant: null });
  // It was not drunk after all: no journal prompt for it.
  expect(screen.queryByTestId('journal-prompt')).not.toBeInTheDocument();
  expect(racksReads()).toBe(before);
  expect(screen.queryByRole('button', { name: 'common.undo' })).not.toBeInTheDocument();
});

test('a slot taken meanwhile is left alone: the bottle stays unplaced and the racks are read again', async () => {
  setup();
  renderPage();
  const undo = await drinkAndUndo();
  putResponse = () => refused(409, { error: 'This slot has changed since — check the rack and try again.', code: 'slot_changed' });
  const someoneElse = { ...bottle(), _id: 'b9', wineDefinition: { _id: 'w9', name: 'Other', type: 'white' } };
  racksResponse = () => ok({ racks: [rackWith(someoneElse)] });
  const before = racksReads();

  undo();

  expect(await screen.findByText('bottleNotice.restored:{"name":"Château Margaux 2015"}')).toBeInTheDocument();
  await waitFor(() => expect(racksReads()).toBe(before + 1));
  expect(slotPuts()).toHaveLength(1);
  // No error for it: "back in the cellar" is the whole truth.
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('a re-read that fails after an Undo is said in the floating notice — the page stays', async () => {
  setup();
  renderPage();
  const undo = await drinkAndUndo();
  putResponse = () => refused(409, { error: 'This slot has changed since — check the rack and try again.' });
  racksResponse = () => refused(503, { error: 'Service unavailable' });

  undo();

  expect(await screen.findByRole('alert')).toHaveTextContent('errors.serverUnavailable');
  // Still the racks page (its header, its notice), not the whole-page error.
  expect(screen.getByText('bottleNotice.restored:{"name":"Château Margaux 2015"}')).toBeInTheDocument();
  expect(screen.getAllByText('Home').length).toBeGreaterThan(0);
  expect(document.querySelector('.cellar-racks-page')).toBeInTheDocument();
});

test('a refused Undo says why and keeps the button', async () => {
  setup();
  renderPage();
  const dialog = await openDrinkDialog();
  fireEvent.click(within(dialog).getByRole('button', { name: 'common.confirm' }));
  const notice = (await screen.findByText(/^bottleNotice\.drunk/)).closest('.bottle-undo-notice');
  api.mockImplementationOnce(async () => refused(400, { error: 'Bottle is already active' }));

  fireEvent.click(within(notice).getByRole('button', { name: 'common.undo' }));

  expect(await within(notice).findByText(/Bottle is already active/)).toBeInTheDocument();
  expect(within(notice).getByRole('button', { name: 'common.undo' })).toBeInTheDocument();
});

test('a refused take-out keeps the dialog open and says why in the floating notice', async () => {
  setup();
  renderPage();
  const dialog = await openDrinkDialog();
  consumeResponse = refused(400, { error: 'This bottle has already left the cellar.' });
  fireEvent.click(within(dialog).getByRole('button', { name: 'common.confirm' }));

  expect(await screen.findByText('This bottle has already left the cellar.')).toBeInTheDocument();
  expect(screen.getByRole('dialog', { name: 'bottleDetail.removeBottleTitle' })).toBeInTheDocument();
  expect(screen.getByText('slot-3')).toBeInTheDocument();
  expect(screen.queryByTestId('journal-prompt')).not.toBeInTheDocument();
});

test('"Just a glass" from an open bottle pours one and shows the bottle', async () => {
  setup(bottle({ openedAt: '2026-10-10T18:00:00.000Z', preservationMethod: 'coravin' }));
  renderPage();
  const dialog = await openDrinkDialog();
  fireEvent.click(within(dialog).getByRole('button', { name: /openBottle\.partialOption/ }));

  expect(await screen.findByText('bottle-page')).toBeInTheDocument();
  expect(api.mock.calls.filter(([u]) => u === '/api/bottles/b1/pour')).toHaveLength(1);
});

test('a refused glass says why and stays on the racks page', async () => {
  setup(bottle({ openedAt: '2026-10-10T18:00:00.000Z', preservationMethod: 'coravin' }));
  renderPage();
  const dialog = await openDrinkDialog();
  pourResponse = refused(400, { error: 'This bottle is already finished.' });
  fireEvent.click(within(dialog).getByRole('button', { name: /openBottle\.partialOption/ }));

  expect(await screen.findByText('This bottle is already finished.')).toBeInTheDocument();
  expect(screen.queryByText('bottle-page')).not.toBeInTheDocument();
  expect(screen.getByText('slot-3')).toBeInTheDocument();
});

test('a refused open says why and stays; nothing is poured', async () => {
  setup();
  renderPage();
  const dialog = await openDrinkDialog();
  fireEvent.click(within(dialog).getByRole('button', { name: /openBottle\.partialOption/ }));
  openResponse = refused(403, { error: 'Only editors can open bottles in this cellar.' });
  fireEvent.click(screen.getByText('openBottle.partialConfirmBtn'));

  expect(await screen.findByText('Only editors can open bottles in this cellar.')).toBeInTheDocument();
  expect(screen.queryByText('openBottle.pickerTitle')).not.toBeInTheDocument();
  expect(screen.queryByText('bottle-page')).not.toBeInTheDocument();
  expect(api.mock.calls.some(([u]) => u === '/api/bottles/b1/pour')).toBe(false);
});
