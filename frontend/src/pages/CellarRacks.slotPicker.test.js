import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';

// An empty slot's picker lists the cellar's unplaced bottles. A load that
// fails says so and offers Retry — "no unplaced bottles" would read as a
// cellar with nothing left to place. While typing, only the latest search
// may fill the list: an older answer arriving late is dropped.

vi.mock('react-i18next', () => {
  const t = (key, a, b) => {
    const vars = b && typeof b === 'object' ? b : (a && typeof a === 'object' ? a : undefined);
    return vars ? `${key}:${JSON.stringify(vars)}` : key;
  };
  return { useTranslation: () => ({ t, i18n: { language: 'en-GB' } }) };
});
vi.mock('../components/CellarNav', () => ({ default: () => null }));
vi.mock('../components/WineImage', () => ({ default: () => null }));
// The drawn rack is beside the point here: one button per position, wired to
// the page's own slot handler.
vi.mock('../components/racks/RackRenderer', () => ({
  default: ({ rack, onSlotClick }) => (
    <div>
      {Array.from({ length: rack.rows * rack.cols }, (_, i) => i + 1).map((p) => {
        const s = rack.slots.find((x) => x.position === p);
        return (
          <button key={p} type="button" onClick={() => onSlotClick(p, s || null)}>
            {`slot-${p}`}
          </button>
        );
      })}
    </div>
  ),
}));

let auth;
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => auth }));

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const refused = (status, body) => ({ ok: false, status, json: async () => body });
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

const bottle = (id, name) => ({
  _id: id, vintage: '2015', status: 'active',
  wineDefinition: { _id: `w-${id}`, name, producer: name, type: 'red' },
});
const listed = (...items) => ok({ bottles: { items } });
const rack = () => ({
  _id: 'r1', name: 'Left wall', type: 'grid', rows: 1, cols: 2, cellar: 'c1',
  slots: [], zones: [], disabledPositions: [],
});

// The picker's request for a search term (empty = the first list).
const pickerUrl = (term) => {
  const params = new URLSearchParams({ limit: '30' });
  if (term) params.set('search', term);
  params.set('excludePlaced', '1');
  return `/api/cellars/c1?${params.toString()}`;
};

let api;
let picker; // term → what the picker's request for it answers (a value or a function)
const setup = () => {
  picker = { '': () => listed(bottle('b1', 'Château Margaux')) };
  api = vi.fn(async (url) => {
    if (url === '/api/cellars/c1') return ok({ cellar: { _id: 'c1', name: 'Home', userRole: 'owner' } });
    if (url === '/api/racks?cellar=c1') return ok({ racks: [rack()] });
    const term = Object.keys(picker).find((k) => url === pickerUrl(k));
    if (term !== undefined) return picker[term]();
    return ok({});
  });
  auth = { apiFetch: api, user: { id: 'u1', preferences: { ratingScale: '5' } } };
};
const pickerCalls = (term) => api.mock.calls.filter(([u]) => u === pickerUrl(term)).length;

const renderPage = () => render(
  <MemoryRouter initialEntries={['/cellars/c1/racks']}>
    <Routes>
      <Route path="/cellars/:id/racks" element={<CellarRacks />} />
    </Routes>
  </MemoryRouter>,
);
const { default: CellarRacks } = await import('./CellarRacks');

const openPicker = async () => {
  fireEvent.click(await screen.findByRole('button', { name: 'slot-1' }));
  return screen.getByRole('dialog');
};

test('a failed load says so, not "no unplaced bottles"; Retry loads again', async () => {
  setup();
  picker[''] = () => Promise.reject(new TypeError('Failed to fetch'));
  renderPage();
  const popup = await openPicker();

  expect(await within(popup).findByText('racks.unplacedLoadFailed')).toBeInTheDocument();
  expect(within(popup).queryByText('racks.noUnplacedBottles')).not.toBeInTheDocument();

  picker[''] = () => listed(bottle('b1', 'Château Margaux'));
  fireEvent.click(within(popup).getByRole('button', { name: 'common.retry' }));

  expect(await within(popup).findByText('Château Margaux')).toBeInTheDocument();
  expect(within(popup).queryByText('racks.unplacedLoadFailed')).not.toBeInTheDocument();
  expect(pickerCalls('')).toBe(2);
});

test('a refused load says so too, and Retry repeats the current search', async () => {
  setup();
  picker.chablis = () => refused(503, { error: 'Service unavailable' });
  renderPage();
  const popup = await openPicker();
  await within(popup).findByText('Château Margaux');

  fireEvent.change(within(popup).getByRole('textbox'), { target: { value: 'chablis' } });

  expect(await within(popup).findByText('racks.unplacedLoadFailed')).toBeInTheDocument();
  expect(within(popup).queryByText('racks.noUnplacedBottles')).not.toBeInTheDocument();
  expect(within(popup).queryByText('Château Margaux')).not.toBeInTheDocument();

  picker.chablis = () => listed(bottle('b2', 'Chablis Premier Cru'));
  fireEvent.click(within(popup).getByRole('button', { name: 'common.retry' }));

  expect(await within(popup).findByText('Chablis Premier Cru')).toBeInTheDocument();
  expect(pickerCalls('chablis')).toBe(2);
});

test('an empty answer still says there is nothing to place', async () => {
  setup();
  picker[''] = () => listed();
  renderPage();
  const popup = await openPicker();

  expect(await within(popup).findByText('racks.noUnplacedBottles')).toBeInTheDocument();
  expect(within(popup).queryByRole('button', { name: 'common.retry' })).not.toBeInTheDocument();
});

test('only the latest search fills the list: an older answer arriving late is dropped', async () => {
  setup();
  const cha = deferred();
  const chablis = deferred();
  picker.cha = () => cha.promise;
  picker.chablis = () => chablis.promise;
  renderPage();
  const popup = await openPicker();
  await within(popup).findByText('Château Margaux');
  const input = within(popup).getByRole('textbox');

  fireEvent.change(input, { target: { value: 'cha' } });
  await waitFor(() => expect(pickerCalls('cha')).toBe(1));
  fireEvent.change(input, { target: { value: 'chablis' } });
  await waitFor(() => expect(pickerCalls('chablis')).toBe(1));

  // The older search answers first: the list keeps waiting for the latest.
  cha.resolve(listed(bottle('b3', 'Chardonnay'), bottle('b2', 'Chablis Premier Cru')));
  await new Promise((r) => setTimeout(r, 20));
  expect(within(popup).getByText('…')).toBeInTheDocument();
  expect(within(popup).queryByText('Chardonnay')).not.toBeInTheDocument();

  chablis.resolve(listed(bottle('b2', 'Chablis Premier Cru')));
  expect(await within(popup).findByText('Chablis Premier Cru')).toBeInTheDocument();
  expect(within(popup).queryByText('…')).not.toBeInTheDocument();
  expect(within(popup).queryByText('Chardonnay')).not.toBeInTheDocument();
});

test('an older search answering after the latest one does not replace its list', async () => {
  setup();
  const cha = deferred();
  picker.cha = () => cha.promise;
  picker.chablis = () => listed(bottle('b2', 'Chablis Premier Cru'));
  renderPage();
  const popup = await openPicker();
  await within(popup).findByText('Château Margaux');
  const input = within(popup).getByRole('textbox');

  fireEvent.change(input, { target: { value: 'cha' } });
  await waitFor(() => expect(pickerCalls('cha')).toBe(1));
  fireEvent.change(input, { target: { value: 'chablis' } });
  expect(await within(popup).findByText('Chablis Premier Cru')).toBeInTheDocument();

  cha.resolve(listed(bottle('b3', 'Chardonnay'), bottle('b2', 'Chablis Premier Cru')));
  await new Promise((r) => setTimeout(r, 20));
  expect(within(popup).queryByText('Chardonnay')).not.toBeInTheDocument();
  expect(within(popup).getByText('Chablis Premier Cru')).toBeInTheDocument();
});

// Retry gives way to the loading line, so keyboard focus must not go down with
// it (the next Tab would leave the dialog): it moves to the search field. The
// alert is the failure sentence alone, not the button beside it.
test('Retry keeps focus inside the picker, and the alert is the message without the button', async () => {
  setup();
  picker[''] = () => Promise.reject(new TypeError('Failed to fetch'));
  renderPage();
  const popup = await openPicker();
  await within(popup).findByText('racks.unplacedLoadFailed');

  const alert = within(popup).getByRole('alert');
  expect(alert).toHaveTextContent('racks.unplacedLoadFailed');
  const retry = within(popup).getByRole('button', { name: 'common.retry' });
  expect(alert).not.toContainElement(retry);

  const again = deferred();
  picker[''] = () => again.promise;
  retry.focus();
  expect(retry).toHaveFocus();
  fireEvent.click(retry);

  expect(await within(popup).findByText('…')).toBeInTheDocument();
  expect(within(popup).getByRole('textbox')).toHaveFocus();

  again.resolve(listed(bottle('b1', 'Château Margaux')));
  expect(await within(popup).findByText('Château Margaux')).toBeInTheDocument();
  expect(within(popup).getByRole('textbox')).toHaveFocus();
});

// ?rack= focuses the rack by scrolling to it; jsdom has no scrollIntoView.
beforeAll(() => { if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {}; });

// "Add a new bottle here": a bottle that is not in the cellar yet is added
// from the free slot and comes back to it.
const AddBottleStub = () => <pre data-testid="add-state">{JSON.stringify(useLocation().state)}</pre>;
// What the current history entry carries — what Back or a reload comes back to.
const EntryState = () => <pre data-testid="entry-state">{JSON.stringify(useLocation().state)}</pre>;
const entryState = () => JSON.parse(screen.getByTestId('entry-state').textContent);
const renderAt = (entry) => render(
  <MemoryRouter initialEntries={[entry]}>
    <Routes>
      <Route path="/cellars/:id/racks" element={<CellarRacks />} />
      <Route path="/cellars/:id/add-bottle" element={<AddBottleStub />} />
    </Routes>
    <EntryState />
  </MemoryRouter>,
);
const B1 = '6a000000000000000000b009';
const B2 = '6a000000000000000000b00a';
const fromSlot = (placeQueue) => ({ pathname: '/cellars/c1/racks', search: '?rack=r1', state: { placeQueue, placeAt: { rackId: 'r1', position: 2 } } });
const slotWrites = () => api.mock.calls.filter(([u, o]) => u.startsWith('/api/racks/r1/slots/') && o?.method === 'PUT').length;

test('a free slot offers to add a new bottle there; Add Bottle opens with that slot', async () => {
  setup();
  renderAt('/cellars/c1/racks');
  fireEvent.click(await screen.findByRole('button', { name: 'slot-1' }));
  fireEvent.click(screen.getByRole('button', { name: 'racks.addNewHere' }));
  expect(JSON.parse((await screen.findByTestId('add-state')).textContent)).toEqual({ placeAt: { rackId: 'r1', position: 1 } });
});

test('a bottle added from a slot goes into that slot when the rack page opens, only if the server still finds it empty', async () => {
  setup();
  const inner = api.getMockImplementation();
  api.mockImplementation(async (url, opts) => {
    if (url === '/api/racks/r1/slots/2') return ok({ rack: { ...rack(), slots: [{ position: 2, bottle: bottle(B1, 'Opus One') }] } });
    return inner(url, opts);
  });
  renderAt(fromSlot([B1]));

  await waitFor(() => expect(api).toHaveBeenCalledWith('/api/racks/r1/slots/2', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ bottleId: B1, expectOccupant: null }) })));
});

test('a slot filled on the server meanwhile pushes nothing out: the racks are read again and the slot is said to be taken', async () => {
  setup();
  const inner = api.getMockImplementation();
  let racksReads = 0;
  api.mockImplementation(async (url, opts) => {
    if (url === '/api/racks?cellar=c1') {
      racksReads += 1;
      return ok({ racks: [racksReads === 1 ? rack() : { ...rack(), slots: [{ position: 2, bottle: bottle('b7', 'Someone else') }] }] });
    }
    if (url === '/api/racks/r1/slots/2') return refused(409, { error: 'This slot has changed since — check the rack and try again.', code: 'slot_changed' });
    return inner(url, opts);
  });
  renderAt(fromSlot([B1]));

  expect(await screen.findByText(/racks\.placeQueue\.slotTaken/)).toBeInTheDocument();
  expect(api).toHaveBeenCalledWith('/api/racks/r1/slots/2', expect.objectContaining({ body: JSON.stringify({ bottleId: B1, expectOccupant: null }) }));
  await waitFor(() => expect(racksReads).toBe(2));
  // The bottle stays in the queue, to be placed by a tap.
  expect(screen.getByText(/racks\.placeQueue\.progress:\{"placed":0,"total":1\}/)).toBeInTheDocument();
});

test('the slot is decided once: the history entry then keeps only the queue, and a reload places nothing again', async () => {
  setup();
  const inner = api.getMockImplementation();
  const placed = { ...rack(), slots: [{ position: 2, bottle: bottle(B1, 'Opus One') }] };
  let current = rack();
  api.mockImplementation(async (url, opts) => {
    if (url === '/api/racks?cellar=c1') return ok({ racks: [current] });
    if (url === '/api/racks/r1/slots/2') { current = placed; return ok({ rack: placed }); }
    return inner(url, opts);
  });
  const { unmount } = renderAt(fromSlot([B1, B2]));

  await waitFor(() => expect(slotWrites()).toBe(1));
  await waitFor(() => expect(entryState()).toEqual({ placeQueue: [B1, B2] }));
  const kept = entryState();
  unmount();

  renderAt({ pathname: '/cellars/c1/racks', search: '?rack=r1', state: kept });
  expect(await screen.findByText(/racks\.placeQueue\.progress:\{"placed":1,"total":2\}/)).toBeInTheDocument();
  await new Promise((r) => setTimeout(r, 20));
  expect(slotWrites()).toBe(1);
  expect(screen.queryByText(/racks\.placeQueue\.slotTaken/)).not.toBeInTheDocument();
});

// An entry that still carries the slot while its first bottle is in a rack
// (Back or a reload after the placement): that bottle was placed already —
// it must not be called a stranger in its slot, nor be moved back into it.
test.each([
  ['in the slot it was added for', 2],
  ['moved to another slot since', 1],
])('with the first bottle already in a rack (%s), nothing is written and no "slot taken" is said', async (_, position) => {
  setup();
  const inner = api.getMockImplementation();
  api.mockImplementation(async (url, opts) => {
    if (url === '/api/racks?cellar=c1') return ok({ racks: [{ ...rack(), slots: [{ position, bottle: bottle(B1, 'Opus One') }] }] });
    if (url === '/api/racks/r1/slots/2') return ok({ rack: { ...rack(), slots: [{ position: 2, bottle: bottle(B1, 'Opus One') }] } });
    return inner(url, opts);
  });
  renderAt(fromSlot([B1, B2]));

  expect(await screen.findByText(/racks\.placeQueue\.progress:\{"placed":1,"total":2\}/)).toBeInTheDocument();
  await new Promise((r) => setTimeout(r, 20));
  expect(slotWrites()).toBe(0);
  expect(screen.queryByText(/racks\.placeQueue\.slotTaken/)).not.toBeInTheDocument();
  await waitFor(() => expect(entryState()).toEqual({ placeQueue: [B1, B2] }));
});

test('a slot taken meanwhile places nothing and says so', async () => {
  setup();
  const inner = api.getMockImplementation();
  api.mockImplementation(async (url, opts) => {
    if (url === '/api/racks?cellar=c1') return ok({ racks: [{ ...rack(), slots: [{ position: 2, bottle: bottle('b1', 'Château Margaux') }] }] });
    return inner(url, opts);
  });
  renderAt(fromSlot([B1]));

  expect(await screen.findByText(/racks\.placeQueue\.slotTaken/)).toBeInTheDocument();
  expect(api.mock.calls.some(([u]) => u === '/api/racks/r1/slots/2')).toBe(false);
  // Refused is decided too: Back or a reload does not say it again.
  await waitFor(() => expect(entryState()).toEqual({ placeQueue: [B1] }));
});

// ?rack= picks its rack once: a slot change afterwards must not pull the view
// back to it from the rack the member went on to.
test('?rack= selects its rack once; a slot change in another rack keeps that rack in view', async () => {
  setup();
  const inner = api.getMockImplementation();
  api.mockImplementation(async (url, opts) => {
    if (url === '/api/racks?cellar=c1') return ok({ racks: [rack(), { ...rack(), _id: 'r2', name: 'Right wall' }] });
    if (url === '/api/racks/r1/slots/1') return ok({ rack: { ...rack(), slots: [{ position: 1, bottle: bottle('b1', 'Château Margaux') }] } });
    return inner(url, opts);
  });
  renderAt('/cellars/c1/racks?rack=r2');
  const tab = (name) => screen.getByRole('button', { name: new RegExp(name) });
  await waitFor(() => expect(tab('Right wall')).toHaveClass('active'));

  fireEvent.click(tab('Left wall'));
  fireEvent.click(screen.getByRole('button', { name: 'slot-1' }));
  fireEvent.click(await within(screen.getByRole('dialog')).findByText('Château Margaux'));

  await waitFor(() => expect(api).toHaveBeenCalledWith('/api/racks/r1/slots/1', expect.objectContaining({ method: 'PUT' })));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(tab('Left wall')).toHaveClass('active');
  expect(tab('Right wall')).not.toHaveClass('active');
});

test('the demo is not offered "Add a new bottle here": it cannot add bottles', async () => {
  setup();
  auth.user = { ...auth.user, isDemo: true };
  renderAt('/cellars/c1/racks');
  const popup = await openPicker();

  await within(popup).findByText('Château Margaux');
  expect(within(popup).queryByRole('button', { name: 'racks.addNewHere' })).not.toBeInTheDocument();
});
