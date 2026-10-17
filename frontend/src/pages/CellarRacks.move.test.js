import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom';
import { resetBackToCloseForTests } from '../utils/useBackToClose';

// Moving a bottle without dragging: drag & drop is mouse/pen only, so a phone
// moves a bottle with "Move" in its slot popup and a tap on the slot it should
// go to. Within one rack the tap does what a drop does (the same request — an
// occupied slot swaps); in another rack an empty slot takes it.

vi.mock('react-i18next', () => {
  const t = (key, a, b) => {
    const vars = b && typeof b === 'object' ? b : (a && typeof a === 'object' ? a : undefined);
    return vars ? `${key}:${JSON.stringify(vars)}` : key;
  };
  return { useTranslation: () => ({ t, i18n: { language: 'en-GB' } }) };
});
vi.mock('../components/CellarNav', () => ({ default: () => null }));
vi.mock('../components/WineImage', () => ({ default: () => null }));
// The slot Move is early access (flag rackSlotMove); on in these tests unless one turns it off.
let slotMoveOn = true;
vi.mock('../utils/featureFlags', () => ({ useFeature: (key) => key === 'rackSlotMove' && slotMoveOn }));
vi.mock('../components/BetaBadge', () => ({ default: ({ feature }) => <div data-testid="beta-badge">{feature}</div> }));
// The drawn rack is beside the point here: one button per position (empty
// ones too), wired to the page's own slot handler, marked when active; plus
// a stand-in for a drop of slot 3 on slot 4, and the header's delete.
vi.mock('../components/racks/RackRenderer', () => ({
  default: ({ rack, activeRackId, activePosition, onSlotClick, onSlotMove, onDelete }) => (
    <div>
      {Array.from({ length: rack.rows * rack.cols }, (_, i) => i + 1).map((p) => {
        const s = rack.slots.find((x) => x.position === p);
        return (
          <button
            key={p}
            type="button"
            aria-pressed={activeRackId === rack._id && activePosition === p}
            onClick={() => onSlotClick(p, s || null)}
          >
            {`slot-${p}:${s ? s.bottle._id : 'empty'}`}
          </button>
        );
      })}
      {onSlotMove && <button type="button" onClick={() => onSlotMove(3, 4)}>drop-3-on-4</button>}
      <button type="button" onClick={onDelete}>{`delete-${rack._id}`}</button>
    </div>
  ),
}));

let auth;
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => auth }));

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const refused = (status, body) => ({ ok: false, status, json: async () => body });

const bottle = (id, name) => ({
  _id: id, vintage: '2015', status: 'active',
  wineDefinition: { _id: `w-${id}`, name, producer: name, type: 'red' },
});
const b1 = bottle('b1', 'Château Margaux');
const b2 = bottle('b2', 'Barolo');
const rack1 = () => ({
  _id: 'r1', name: 'Left wall', type: 'grid', rows: 2, cols: 2, cellar: 'c1',
  slots: [{ position: 3, bottle: b1 }, { position: 4, bottle: b2 }], zones: [], disabledPositions: [2],
});
const rack2 = () => ({
  _id: 'r2', name: 'Cabinet', type: 'grid', rows: 2, cols: 2, cellar: 'c1',
  slots: [{ position: 1, bottle: bottle('b3', 'Rioja') }], zones: [], disabledPositions: [],
});

// What the server answers: the move endpoint's own move / swap.
const moved = (rack, from, to) => ({
  ...rack,
  slots: rack.slots.map((s) => (s.position === from ? { ...s, position: to } : s.position === to ? { ...s, position: from } : s)),
});

let api;
let moveResponse;
let placeResponse;
let rackReads; // answers for the racks re-reads after the first load, in order
let role;
const setup = ({ userRole = 'owner' } = {}) => {
  moveResponse = null;
  placeResponse = null;
  rackReads = [];
  role = userRole;
  let loaded = false;
  api = vi.fn(async (url, opts = {}) => {
    if (url === '/api/cellars/c1') return ok({ cellar: { _id: 'c1', name: 'Home', userRole: role } });
    if (url === '/api/racks?cellar=c1') {
      if (loaded && rackReads.length) return rackReads.shift();
      loaded = true;
      return ok({ racks: [rack1(), rack2()] });
    }
    if (url === '/api/cellars/c2') return ok({ cellar: { _id: 'c2', name: 'Summer house', userRole: role } });
    if (url === '/api/racks?cellar=c2') {
      return ok({ racks: [{ ...rack2(), _id: 'r9', name: 'Shelf', cellar: 'c2', slots: [] }] });
    }
    if (url === '/api/racks/r1/slots/3/move') {
      return moveResponse || ok({ rack: moved(rack1(), 3, JSON.parse(opts.body).toPosition) });
    }
    if (url === '/api/racks/r2/slots/2' && opts.method === 'PUT') {
      const r = rack2();
      return placeResponse || ok({ rack: { ...r, slots: [...r.slots, { position: 2, bottle: b1 }] } });
    }
    return ok({});
  });
  auth = { apiFetch: api, user: { id: 'u1', preferences: { ratingScale: '5' } } };
};

// Another cellar's racks page, reached without leaving the page component.
function OtherCellar() {
  const navigate = useNavigate();
  return <button type="button" onClick={() => navigate('/cellars/c2/racks')}>other-cellar</button>;
}

const renderPage = () => render(
  <MemoryRouter initialEntries={['/cellars/c1/racks']}>
    <Routes>
      <Route path="/cellars/:id/racks" element={<><CellarRacks /><OtherCellar /></>} />
    </Routes>
  </MemoryRouter>,
);
const { default: CellarRacks } = await import('./CellarRacks');

const slot = (name) => screen.getByRole('button', { name });
const writes = () => api.mock.calls.filter(([, o]) => o && o.method && o.method !== 'GET');
const rackLoads = () => api.mock.calls.filter(([u]) => u === '/api/racks?cellar=c1').length;
const banner = () => screen.queryByText(/racks\.moveMode\.hint/);
const SLOT_CHANGED = { error: 'This slot has changed since — check the rack and try again.', code: 'slot_changed' };

// The phone's Back (useBackToClose) works on window.history, apart from the
// MemoryRouter: each test starts on a plain page entry, and none is left over.
beforeEach(() => {
  resetBackToCloseForTests();
  window.history.replaceState(null, '');
});

// Open slot 3's popup and choose "Move".
const startMove = async () => {
  fireEvent.click(await screen.findByRole('button', { name: 'slot-3:b1' }));
  const popup = screen.getByRole('dialog');
  fireEvent.click(within(popup).getByRole('button', { name: 'racks.moveMode.button' }));
};

test('"Move" closes the popup and shows which bottle is moving; its slot stays marked', async () => {
  setup();
  renderPage();
  await startMove();

  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(banner()).toHaveTextContent('racks.moveMode.hint:{"name":"Château Margaux 2015"}');
  expect(banner()).toHaveTextContent('racks.moveMode.otherRackHint');
  expect(slot('slot-3:b1')).toHaveAttribute('aria-pressed', 'true');
  expect(writes()).toHaveLength(0);
});

test('then a tap on an empty slot: one move request, the bottle shows there, the mode ends', async () => {
  setup();
  renderPage();
  await startMove();
  fireEvent.click(slot('slot-1:empty'));

  expect(await screen.findByRole('button', { name: 'slot-1:b1' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'slot-3:empty' })).toBeInTheDocument();
  const calls = writes();
  expect(calls).toHaveLength(1);
  expect(calls[0][0]).toBe('/api/racks/r1/slots/3/move');
  expect(calls[0][1].method).toBe('POST');
  expect(JSON.parse(calls[0][1].body)).toEqual({ toPosition: 1, expectFrom: 'b1', expectTo: null });
  expect(banner()).not.toBeInTheDocument();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('a tap on a filled slot sends the request a drop sends, and the two bottles swap', async () => {
  setup();
  const dropped = renderPage();
  // The drop first, for comparison.
  fireEvent.click(await screen.findByRole('button', { name: 'drop-3-on-4' }));
  await screen.findByRole('button', { name: 'slot-4:b1' });
  const [dropUrl, dropOpts] = writes()[0];
  dropped.unmount();

  // A fresh page with the bottles back where they were, then the same move by taps.
  setup();
  renderPage();
  await startMove();
  fireEvent.click(slot('slot-4:b2'));

  expect(await screen.findByRole('button', { name: 'slot-4:b1' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'slot-3:b2' })).toBeInTheDocument();
  const calls = writes();
  expect(calls).toHaveLength(1);
  expect(calls[0][0]).toBe(dropUrl);
  expect(calls[0][1].method).toBe(dropOpts.method);
  expect(JSON.parse(dropOpts.body)).toEqual({ toPosition: 4 });
  // The same move, plus what the person saw in both slots.
  expect(JSON.parse(calls[0][1].body)).toEqual({ toPosition: 4, expectFrom: 'b1', expectTo: 'b2' });
});

test('Cancel leaves the mode with no request; the next tap opens the popup again', async () => {
  setup();
  renderPage();
  await startMove();
  fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }));

  expect(banner()).not.toBeInTheDocument();
  expect(slot('slot-3:b1')).toHaveAttribute('aria-pressed', 'false');
  fireEvent.click(slot('slot-1:empty'));
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  expect(writes()).toHaveLength(0);
});

test('a tap on the bottle\'s own slot leaves the mode too', async () => {
  setup();
  renderPage();
  await startMove();
  fireEvent.click(slot('slot-3:b1'));

  expect(banner()).not.toBeInTheDocument();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(writes()).toHaveLength(0);
});

test('a move refused because the rack changed says why, re-reads the racks, and leaves the bottle where it was', async () => {
  setup();
  renderPage();
  await startMove();
  // Meanwhile someone else put a bottle in slot 1.
  const changed = rack1();
  changed.slots.push({ position: 1, bottle: bottle('b5', 'Chablis') });
  rackReads = [ok({ racks: [changed, rack2()] })];
  moveResponse = refused(409, SLOT_CHANGED);
  fireEvent.click(slot('slot-1:empty'));

  expect(await screen.findByRole('alert')).toHaveTextContent(SLOT_CHANGED.error);
  // The page now shows the real layout, so the next try works on it.
  expect(await screen.findByRole('button', { name: 'slot-1:b5' })).toBeInTheDocument();
  expect(rackLoads()).toBe(2);
  expect(slot('slot-3:b1')).toBeInTheDocument();
  expect(writes()).toHaveLength(1);
  // One try, then the mode ends.
  expect(banner()).not.toBeInTheDocument();
});

test('the re-read is quiet: if it fails too, the page stays as it was with the reason in the notice', async () => {
  setup();
  renderPage();
  await startMove();
  rackReads = [refused(500, { error: 'Failed to load racks' })];
  moveResponse = refused(409, SLOT_CHANGED);
  fireEvent.click(slot('slot-1:empty'));

  expect(await screen.findByRole('alert')).toHaveTextContent(SLOT_CHANGED.error);
  await waitFor(() => expect(rackLoads()).toBe(2));
  expect(screen.queryByText('Failed to load racks')).not.toBeInTheDocument();
  expect(slot('slot-3:b1')).toBeInTheDocument();
  expect(slot('slot-1:empty')).toBeInTheDocument();
});

test('a refusal that is not about a changed rack does not re-read', async () => {
  setup();
  renderPage();
  await startMove();
  moveResponse = refused(400, { error: 'Position must be 1–4' });
  fireEvent.click(slot('slot-1:empty'));

  expect(await screen.findByRole('alert')).toHaveTextContent('Position must be 1–4');
  expect(rackLoads()).toBe(1);
  expect(slot('slot-3:b1')).toBeInTheDocument();
});

test('an unusable slot is refused with the reason; the mode stays on', async () => {
  setup();
  renderPage();
  await startMove();
  fireEvent.click(slot('slot-2:empty'));

  expect(await screen.findByRole('alert')).toHaveTextContent('racks.disabledSlotNote');
  expect(banner()).toBeInTheDocument();
  expect(writes()).toHaveLength(0);
});

test('into another rack: its tab, an empty slot — placed there and gone from the old rack', async () => {
  setup();
  renderPage();
  await startMove();
  fireEvent.click(screen.getByRole('button', { name: /^Cabinet/ }));
  expect(banner()).toBeInTheDocument();

  // An occupied slot over there is refused: placing would push that bottle out.
  fireEvent.click(slot('slot-1:b3'));
  expect(await screen.findByRole('alert')).toHaveTextContent('racks.moveMode.otherRackFilled');
  expect(writes()).toHaveLength(0);

  fireEvent.click(slot('slot-2:empty'));
  expect(await screen.findByRole('button', { name: 'slot-2:b1' })).toBeInTheDocument();
  const calls = writes();
  expect(calls).toHaveLength(1);
  expect(calls[0][0]).toBe('/api/racks/r2/slots/2');
  expect(calls[0][1].method).toBe('PUT');
  expect(JSON.parse(calls[0][1].body)).toEqual({ bottleId: 'b1', expectOccupant: null });
  expect(banner()).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: /^Left wall/ }));
  expect(slot('slot-3:empty')).toBeInTheDocument();
  expect(slot('slot-4:b2')).toBeInTheDocument();
});

test('into another rack, refused because its slot was taken meanwhile: the racks are re-read', async () => {
  setup();
  renderPage();
  await startMove();
  fireEvent.click(screen.getByRole('button', { name: /^Cabinet/ }));
  const taken = rack2();
  taken.slots.push({ position: 2, bottle: bottle('b6', 'Sancerre') });
  rackReads = [ok({ racks: [rack1(), taken] })];
  placeResponse = refused(409, SLOT_CHANGED);
  fireEvent.click(slot('slot-2:empty'));

  expect(await screen.findByRole('alert')).toHaveTextContent(SLOT_CHANGED.error);
  expect(await screen.findByRole('button', { name: 'slot-2:b6' })).toBeInTheDocument();
  expect(rackLoads()).toBe(2);
  fireEvent.click(screen.getByRole('button', { name: /^Left wall/ }));
  expect(slot('slot-3:b1')).toBeInTheDocument();
});

test('dragging the moving bottle (mouse/pen) ends the mode — the drop moved it', async () => {
  setup();
  renderPage();
  await startMove();
  fireEvent.click(slot('drop-3-on-4'));

  expect(banner()).not.toBeInTheDocument();
  expect(await screen.findByRole('button', { name: 'slot-4:b1' })).toBeInTheDocument();
  const calls = writes();
  expect(calls).toHaveLength(1);
  // The drop's own request, as before.
  expect(JSON.parse(calls[0][1].body)).toEqual({ toPosition: 4 });
});

test('deleting the rack the bottle is moving from ends the mode', async () => {
  setup();
  renderPage();
  await startMove();
  fireEvent.click(slot('delete-r1'));
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'racks.deleteRack' }));

  await waitFor(() => expect(banner()).not.toBeInTheDocument());
  expect(writes().map(([u, o]) => `${o.method} ${u}`)).toEqual(['DELETE /api/racks/r1']);
  // The remaining rack's slots open their popups again.
  fireEvent.click(await screen.findByRole('button', { name: 'slot-2:empty' }));
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  expect(writes()).toHaveLength(1);
});

test('opening another cellar ends the mode: nothing is sent against its racks', async () => {
  setup();
  renderPage();
  await startMove();
  fireEvent.click(slot('other-cellar'));

  await waitFor(() => expect(api.mock.calls.some(([u]) => u === '/api/racks?cellar=c2')).toBe(true));
  expect(banner()).not.toBeInTheDocument();
  fireEvent.click(await screen.findByRole('button', { name: 'slot-2:empty' }));
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  expect(writes()).toHaveLength(0);
});

test('Escape leaves the mode with no request — but with a pop-up open, Escape is the pop-up\'s', async () => {
  setup();
  renderPage();
  await startMove();

  // A pop-up over the page (the delete confirmation): Escape closes it only.
  fireEvent.click(slot('delete-r1'));
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  fireEvent.keyDown(document, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(banner()).toBeInTheDocument();

  fireEvent.keyDown(document, { key: 'Escape' });
  expect(banner()).not.toBeInTheDocument();
  expect(slot('slot-3:b1')).toHaveAttribute('aria-pressed', 'false');
  expect(writes()).toHaveLength(0);
});

test("the phone's Back leaves the mode and stays on the page", async () => {
  // A page entry the way the router leaves one, so pop-ups add theirs.
  window.history.replaceState({ usr: null, key: 'page', idx: 0 }, '');
  setup();
  renderPage();
  // Two taps are two tasks in a browser; fireEvent's back-to-back clicks are
  // one, which useBackToClose would take for pop-ups opened together.
  const tick = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  fireEvent.click(await screen.findByRole('button', { name: 'slot-3:b1' }));
  await tick();
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'racks.moveMode.button' }));
  await tick();
  expect(banner()).toBeInTheDocument();
  expect(window.history.state.cellarionDialog).toBeTruthy();

  // jsdom moves through history asynchronously, like a browser: wait for the
  // pop, then for the close a task after it.
  await act(async () => {
    const popped = new Promise((r) => window.addEventListener('popstate', r, { once: true }));
    window.history.back();
    await popped;
    await new Promise((r) => setTimeout(r, 10));
  });

  await waitFor(() => expect(banner()).not.toBeInTheDocument());
  await waitFor(() => expect(window.history.state.cellarionDialog).toBeUndefined());
  expect(window.history.state.key).toBe('page');
  expect(slot('slot-3:b1')).toBeInTheDocument();
  expect(writes()).toHaveLength(0);
});

test('a viewer gets no Move', async () => {
  setup({ userRole: 'viewer' });
  renderPage();
  fireEvent.click(await screen.findByRole('button', { name: 'slot-3:b1' }));

  expect(screen.getByRole('dialog')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'racks.moveMode.button' })).not.toBeInTheDocument();
});

// Early access (flag rackSlotMove, Johan 2026-10-17): only members who see
// the feature get the button; the move bar carries the beta strip.
describe('early access', () => {
  afterEach(() => { slotMoveOn = true; });

  test('without it there is no Move; with it the move bar carries the beta strip', async () => {
    slotMoveOn = false;
    setup();
    const { unmount } = renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'slot-3:b1' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'racks.moveMode.button' })).not.toBeInTheDocument();
    unmount();

    slotMoveOn = true;
    setup();
    renderPage();
    await startMove();
    expect(screen.getByTestId('beta-badge')).toHaveTextContent('rackSlotMove');
  });
});
