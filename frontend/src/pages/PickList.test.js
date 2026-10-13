/**
 * Pick list page (early access, flag pickLists; forum request 2026-10-13).
 * Pinned: bottles grouped by cellar → rack in the server's walking order with
 * their slot; ticks are batched into one request per direction (the write
 * limiter counts requests); "Mark picked as drunk" hands the picked bottles
 * to the bulk consume dialog; bottles no longer in the cellar and unavailable
 * ones sit apart and can be cleared.
 */
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

const { apiFetchMock } = vi.hoisted(() => ({ apiFetchMock: vi.fn() }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback, vars) => {
      if (fallback && typeof fallback === 'object') return String(fallback.defaultValue ?? key);
      return typeof fallback === 'string' ? fallback.replace(/\{\{(\w+)\}\}/g, (_, k) => vars?.[k] ?? '') : key;
    },
  }),
}));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ apiFetch: apiFetchMock, user: { preferences: {} } }) }));
vi.mock('react-router-dom', () => ({
  useParams: () => ({ id: 'pl1' }),
  useNavigate: () => vi.fn(),
  Link: ({ children, to, ...rest }) => <a href={to} {...rest}>{children}</a>,
}));
vi.mock('../components/BetaBadge', () => ({ default: () => null }));
vi.mock('../components/BulkConsumeModal', () => ({
  default: ({ bottleIds }) => <div data-testid="consume">{bottleIds.join(',')}</div>,
}));

const PickList = (await import('./PickList')).default;

const json = (body, ok = true) => ({ ok, json: async () => body });
const ITEMS = [
  { bottleId: 'b1', state: 'in_cellar', pickedAt: null, wine: { producer: 'Brezza', name: 'Barolo' }, vintage: '2018', bottleSize: '750ml', cellar: { id: 'c1', name: 'Home' }, rack: { rackId: 'r1', rackName: 'Fridge', rackGroup: 'Kitchen', position: 3, inRoom: false } },
  { bottleId: 'b2', state: 'in_cellar', pickedAt: '2026-10-13T10:00:00Z', wine: { producer: 'Brezza', name: 'Barolo' }, vintage: '2019', bottleSize: '1500ml', cellar: { id: 'c1', name: 'Home' }, rack: { rackId: 'r1', rackName: 'Fridge', rackGroup: 'Kitchen', position: 9, inRoom: false } },
  { bottleId: 'b3', state: 'in_cellar', pickedAt: null, wine: { producer: 'Pieropan', name: 'Soave' }, vintage: '2023', bottleSize: '750ml', cellar: { id: 'c1', name: 'Home' }, rack: null, location: 'Box by the door' },
  { bottleId: 'b4', state: 'drunk', pickedAt: null, wine: { producer: 'X', name: 'Gone' }, vintage: '2015', bottleSize: '750ml', cellar: { id: 'c1', name: 'Home' }, rack: null },
  { bottleId: 'b5', state: 'unavailable', pickedAt: null },
];
const LIST = { id: 'pl1', name: 'Saturday dinner', count: 5, picked: 1, items: ITEMS };

let posts;
beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  posts = [];
  apiFetchMock.mockImplementation(async (url, opts) => {
    if (opts?.method === 'POST') { posts.push({ url, body: JSON.parse(opts.body) }); return json({ list: LIST }); }
    return json({ list: LIST });
  });
});

const renderPage = async () => {
  render(<PickList />);
  await screen.findByText('Saturday dinner');
};

test('groups by rack in walking order, with each bottle\'s slot; unplaced bottles show where they are', async () => {
  await renderPage();
  const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
  expect(headings.slice(0, 2)).toEqual(['Fridge (Kitchen)', 'Not in a rack']);
  // The slot links to the rack view with this bottle highlighted.
  expect(screen.getByRole('link', { name: 'slot 3' })).toHaveAttribute('href', '/cellars/c1/racks?highlight=b1');
  expect(screen.getByText(/^Brezza — Barolo · 2019 · 1.5 L/)).toBeInTheDocument();
  expect(screen.getByText('Box by the door')).toBeInTheDocument();
  expect(screen.getByText('No longer in the cellar')).toBeInTheDocument();
  expect(screen.getByText(/1 bottle\(s\) on this list are no longer available/)).toBeInTheDocument();
});

test('ticks are sent in one batch per direction, not one request per bottle', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  await act(async () => { render(<PickList />); });
  await act(async () => { await Promise.resolve(); });
  fireEvent.click(screen.getByLabelText('Picked: Brezza — Barolo · 2018'));
  fireEvent.click(screen.getByLabelText('Picked: Pieropan — Soave · 2023'));
  fireEvent.click(screen.getByLabelText(/^Picked: Brezza — Barolo · 2019 · 1.5 L/)); // untick
  expect(posts).toHaveLength(0); // nothing sent yet
  await act(async () => { vi.advanceTimersByTime(800); });
  vi.useRealTimers();
  await waitFor(() => expect(posts).toHaveLength(2));
  expect(posts).toEqual([
    { url: '/api/pick-lists/pl1/picked', body: { bottleIds: ['b1', 'b3'], picked: true } },
    { url: '/api/pick-lists/pl1/picked', body: { bottleIds: ['b2'], picked: false } },
  ]);
});

test('"Mark picked as drunk" hands only the picked bottles still in the cellar to the consume dialog', async () => {
  await renderPage();
  fireEvent.click(screen.getByRole('button', { name: 'Mark 1 picked as drunk' }));
  expect(await screen.findByTestId('consume')).toHaveTextContent('b2');
});

// Release audit 2026-10-13: a reload in between wiped a tick not yet sent, and
// the reload wiped the error it was meant to explain.
test('a reload keeps a tick that is not sent yet', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  await act(async () => { render(<PickList />); });
  await act(async () => { await Promise.resolve(); });
  fireEvent.click(screen.getByLabelText('Picked: Brezza — Barolo · 2018'));
  // Removing another bottle reloads the list before the tick is sent.
  await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: 'Remove from the list' })[2]); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(screen.getByLabelText('Picked: Brezza — Barolo · 2018')).toBeChecked();
  await act(async () => { vi.advanceTimersByTime(800); });
  vi.useRealTimers();
  await waitFor(() => expect(posts.some((p) => p.url.endsWith('/picked') && p.body.picked === true && p.body.bottleIds.includes('b1'))).toBe(true));
});

test('a failed removal says so after the list reloads', async () => {
  apiFetchMock.mockImplementation(async (url, opts) => {
    if (opts?.method === 'POST') throw new Error('offline');
    return json({ list: LIST });
  });
  await renderPage();
  fireEvent.click(screen.getByRole('button', { name: 'Remove these from the list' }));
  expect(await screen.findByText('Could not remove that from the list.')).toBeInTheDocument();
});

test('bottles no longer in the cellar, and unavailable ones, can be cleared from the list', async () => {
  await renderPage();
  fireEvent.click(screen.getByRole('button', { name: 'Remove these from the list' }));
  fireEvent.click(screen.getByRole('button', { name: 'Remove them from the list' }));
  await waitFor(() => expect(posts.filter((p) => p.url.endsWith('/items/remove'))).toHaveLength(2));
  expect(posts.map((p) => p.body.bottleIds)).toEqual([['b4'], ['b5']]);
});
