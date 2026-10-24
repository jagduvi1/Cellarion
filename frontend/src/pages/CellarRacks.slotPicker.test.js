import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

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
vi.mock('../utils/featureFlags', () => ({ useFeature: () => false }));
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
