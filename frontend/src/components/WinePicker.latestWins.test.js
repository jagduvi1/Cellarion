import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

// The journal's wine picker searches as the member types. Searches overlap on
// a slow network: only the latest one may fill the dropdown, and a search that
// answers after a wine was picked must not reopen it.

vi.mock('../api/wines', () => ({ identifyWineByText: vi.fn() }));
const apiFetch = vi.fn();
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ apiFetch: (...a) => apiFetch(...a) }) }));
vi.mock('react-i18next', () => {
  const t = (key, fallback) => (typeof fallback === 'string' ? fallback : key);
  return { useTranslation: () => ({ t }) };
});

const WinePicker = (await import('./WinePicker')).default;

const jsonRes = (body) => ({ ok: true, json: async () => body });
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};
const winesRes = (...wines) => jsonRes({ bottles: [], consumed: [], wines });

const BAROLO = { _id: 'w1', name: 'Barolo', producer: 'Example Estate' };
const BARBARESCO = { _id: 'w2', name: 'Barbaresco', producer: 'Example Estate' };
const BARBERA = { _id: 'w3', name: 'Barbera', producer: 'Example Estate' };

beforeEach(() => { vi.clearAllMocks(); });

const type = (q) => fireEvent.change(screen.getByRole('textbox'), { target: { value: q } });
const searchCalls = () => apiFetch.mock.calls.filter(([url]) => url.startsWith('/api/journal/wine-search'));

function setup() {
  const onChange = vi.fn();
  render(<WinePicker value={{ bottle: null, wine: null, wineName: '' }} onChange={onChange} />);
  return { onChange };
}

test('an earlier search that answers last does not replace the later one', async () => {
  const first = deferred();
  const second = deferred();
  apiFetch.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  setup();
  type('barolo');
  await waitFor(() => expect(searchCalls()).toHaveLength(1));
  type('barbaresco');
  await waitFor(() => expect(searchCalls()).toHaveLength(2));

  await act(async () => { second.resolve(winesRes(BARBARESCO)); });
  expect(await screen.findByText('Barbaresco')).toBeInTheDocument();

  await act(async () => { first.resolve(winesRes(BAROLO)); });
  expect(screen.queryByText('Barolo')).toBeNull();
  expect(screen.getByText('Barbaresco')).toBeInTheDocument();
});

test('"Searching..." stays until the latest search answers', async () => {
  const second = deferred();
  const third = deferred();
  apiFetch
    .mockResolvedValueOnce(winesRes(BARBERA))
    .mockReturnValueOnce(second.promise)
    .mockReturnValueOnce(third.promise);
  setup();
  type('barb');
  expect(await screen.findByText('Barbera')).toBeInTheDocument();
  type('barbar');
  await waitFor(() => expect(searchCalls()).toHaveLength(2));
  type('barbaresco');
  await waitFor(() => expect(searchCalls()).toHaveLength(3));
  expect(screen.getByText('Searching...')).toBeInTheDocument();

  await act(async () => { second.resolve(winesRes(BAROLO)); });
  expect(screen.queryByText('Barolo')).toBeNull();
  expect(screen.getByText('Searching...')).toBeInTheDocument();

  await act(async () => { third.resolve(winesRes(BARBARESCO)); });
  expect(await screen.findByText('Barbaresco')).toBeInTheDocument();
  expect(screen.queryByText('Searching...')).toBeNull();
});

test('a search that answers after a wine was picked does not reopen the dropdown', async () => {
  const late = deferred();
  apiFetch
    .mockResolvedValueOnce(winesRes(BARBERA))
    .mockReturnValueOnce(late.promise);
  const { onChange } = setup();
  type('barb');
  expect(await screen.findByText('Barbera')).toBeInTheDocument();
  type('barbaresco');
  await waitFor(() => expect(searchCalls()).toHaveLength(2));

  // Picked from the results still on screen while the newer search runs.
  fireEvent.click(screen.getByText('Barbera'));
  expect(onChange).toHaveBeenLastCalledWith({ bottle: null, wine: 'w3', wineName: 'Example Estate Barbera', vintage: '' });

  await act(async () => { late.resolve(winesRes(BARBARESCO)); });
  expect(screen.queryByText('Barbaresco')).toBeNull();
  expect(screen.getByRole('textbox')).toHaveValue('Barbera');
  expect(onChange).toHaveBeenLastCalledWith({ bottle: null, wine: 'w3', wineName: 'Example Estate Barbera', vintage: '' });
});
