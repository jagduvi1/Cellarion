import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

// The 3D room's empty-slot picker lists the cellar's unplaced bottles, as the
// racks page does. A load that fails says so and offers Retry — "no unplaced
// bottles" would read as a cellar with nothing left to place. While typing,
// only the latest search may fill the list. The drawing is beside the point
// (three.js): the scene is a stand-in with one empty slot to click.

vi.mock('react-i18next', () => {
  const t = (key, a, b) => {
    const vars = b && typeof b === 'object' ? b : (a && typeof a === 'object' ? a : undefined);
    if (typeof a === 'string' && !vars) return key;
    return vars ? `${key}:${JSON.stringify(vars)}` : key;
  };
  return { useTranslation: () => ({ t, i18n: { language: 'en-GB' } }) };
});
vi.mock('@react-three/fiber', () => ({ Canvas: ({ children }) => <div data-testid="room-canvas">{children}</div> }));
vi.mock('../components/room/RoomScene', () => ({
  default: ({ onEmptySlotClick }) => (onEmptySlotClick
    ? <button type="button" onClick={() => onEmptySlotClick('r1', 1)}>empty-slot</button>
    : null),
}));
vi.mock('../components/CellarNav', () => ({ default: () => null }));
vi.mock('../components/WineImage', () => ({ default: () => null }));

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
let picker; // term → what the picker's request for it answers
const setup = () => {
  picker = { '': () => listed(bottle('b1', 'Château Margaux')) };
  api = vi.fn(async (url) => {
    if (url === '/api/cellars/c1') return ok({ cellar: { _id: 'c1', name: 'Home', userRole: 'owner' } });
    if (url === '/api/racks?cellar=c1') return ok({ racks: [rack()] });
    if (url === '/api/cellar-layout?cellar=c1') return ok({ layout: null });
    const term = Object.keys(picker).find((k) => url === pickerUrl(k));
    if (term !== undefined) return picker[term]();
    return ok({});
  });
  auth = { apiFetch: api, user: { id: 'u1', preferences: { ratingScale: '5' } } };
};
const pickerCalls = (term) => api.mock.calls.filter(([u]) => u === pickerUrl(term)).length;

const renderRoom = () => render(
  <MemoryRouter initialEntries={['/cellars/c1/room']}>
    <Routes>
      <Route path="/cellars/:id/room" element={<CellarRoom />} />
    </Routes>
  </MemoryRouter>,
);
const { default: CellarRoom } = await import('./CellarRoom');

const openPicker = async () => {
  fireEvent.click(await screen.findByRole('button', { name: 'empty-slot' }));
  return screen.getByPlaceholderText('racks.searchWines').closest('.room-bottle-panel');
};

test('a failed load says so, not "no unplaced bottles"; Retry loads again', async () => {
  setup();
  picker[''] = () => Promise.reject(new TypeError('Failed to fetch'));
  renderRoom();
  const panel = await openPicker();

  expect(await within(panel).findByText('racks.unplacedLoadFailed')).toBeInTheDocument();
  expect(within(panel).queryByText('racks.noUnplacedBottles')).not.toBeInTheDocument();

  picker[''] = () => listed(bottle('b1', 'Château Margaux'));
  fireEvent.click(within(panel).getByRole('button', { name: 'common.retry' }));

  expect(await within(panel).findByText('Château Margaux')).toBeInTheDocument();
  expect(within(panel).queryByText('racks.unplacedLoadFailed')).not.toBeInTheDocument();
  expect(pickerCalls('')).toBe(2);
});

test('a refused load says so too, and Retry repeats the current search', async () => {
  setup();
  picker.chablis = () => refused(503, { error: 'Service unavailable' });
  renderRoom();
  const panel = await openPicker();
  await within(panel).findByText('Château Margaux');

  fireEvent.change(within(panel).getByPlaceholderText('racks.searchWines'), { target: { value: 'chablis' } });

  expect(await within(panel).findByText('racks.unplacedLoadFailed')).toBeInTheDocument();
  expect(within(panel).queryByText('racks.noUnplacedBottles')).not.toBeInTheDocument();

  picker.chablis = () => listed(bottle('b2', 'Chablis Premier Cru'));
  fireEvent.click(within(panel).getByRole('button', { name: 'common.retry' }));

  expect(await within(panel).findByText('Chablis Premier Cru')).toBeInTheDocument();
  expect(pickerCalls('chablis')).toBe(2);
});

test('an empty answer still says there is nothing to place', async () => {
  setup();
  picker[''] = () => listed();
  renderRoom();
  const panel = await openPicker();

  expect(await within(panel).findByText('racks.noUnplacedBottles')).toBeInTheDocument();
  expect(within(panel).queryByRole('button', { name: 'common.retry' })).not.toBeInTheDocument();
});

test('only the latest search fills the list: an older answer arriving late is dropped', async () => {
  setup();
  const cha = deferred();
  const chablis = deferred();
  picker.cha = () => cha.promise;
  picker.chablis = () => chablis.promise;
  renderRoom();
  const panel = await openPicker();
  await within(panel).findByText('Château Margaux');
  const input = within(panel).getByPlaceholderText('racks.searchWines');

  fireEvent.change(input, { target: { value: 'cha' } });
  await waitFor(() => expect(pickerCalls('cha')).toBe(1));
  fireEvent.change(input, { target: { value: 'chablis' } });
  await waitFor(() => expect(pickerCalls('chablis')).toBe(1));

  // The older search answers first: the list keeps waiting for the latest.
  cha.resolve(listed(bottle('b3', 'Chardonnay'), bottle('b2', 'Chablis Premier Cru')));
  await new Promise((r) => setTimeout(r, 20));
  expect(within(panel).getByText('…')).toBeInTheDocument();
  expect(within(panel).queryByText('Chardonnay')).not.toBeInTheDocument();

  chablis.resolve(listed(bottle('b2', 'Chablis Premier Cru')));
  expect(await within(panel).findByText('Chablis Premier Cru')).toBeInTheDocument();
  expect(within(panel).queryByText('…')).not.toBeInTheDocument();
  expect(within(panel).queryByText('Chardonnay')).not.toBeInTheDocument();
});
