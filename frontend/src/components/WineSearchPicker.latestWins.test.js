import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

// The picker searches as the member types. Searches overlap on a slow
// network, and the one that answers last is not always the one for the text
// in the box: only the latest search may fill the dropdown or stop the spinner.

vi.mock('../api/wines', () => ({ searchWines: vi.fn() }));
// apiFetch keeps one identity, as the real context's does — the search effect
// lists it in its deps.
const apiFetch = vi.fn();
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ apiFetch }) }));
vi.mock('react-i18next', () => {
  const t = (key) => key;
  return { useTranslation: () => ({ t }) };
});

const { searchWines } = await import('../api/wines');
const WineSearchPicker = (await import('./WineSearchPicker')).default;

const jsonRes = (body) => ({ ok: true, status: 200, json: async () => body });
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

const BAROLO = { _id: 'w1', name: 'Barolo', producer: 'Example Estate', type: 'red' };
const BARBARESCO = { _id: 'w2', name: 'Barbaresco', producer: 'Example Estate', type: 'red' };

beforeEach(() => { vi.clearAllMocks(); });

const type = (q) => fireEvent.change(screen.getByRole('combobox'), { target: { value: q } });
const spinner = (container) => container.querySelector('.wine-search-picker__spinner');

// Two searches in flight: the first for "barolo", the second for "barbaresco".
async function twoSearchesInFlight() {
  const first = deferred();
  const second = deferred();
  searchWines.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const view = render(<WineSearchPicker selected={null} onSelect={() => {}} />);
  type('barolo');
  await waitFor(() => expect(searchWines).toHaveBeenCalledTimes(1));
  type('barbaresco');
  await waitFor(() => expect(searchWines).toHaveBeenCalledTimes(2));
  return { ...view, first, second };
}

test('an earlier search that answers last does not replace the later one', async () => {
  const { first, second } = await twoSearchesInFlight();

  await act(async () => { second.resolve(jsonRes({ wines: [BARBARESCO] })); });
  expect(await screen.findByText('Barbaresco')).toBeInTheDocument();

  await act(async () => { first.resolve(jsonRes({ wines: [BAROLO] })); });
  expect(screen.queryByText('Barolo')).toBeNull();
  expect(screen.getByText('Barbaresco')).toBeInTheDocument();
});

test('the spinner stays until the latest search answers', async () => {
  const { container, first, second } = await twoSearchesInFlight();
  expect(spinner(container)).not.toBeNull();

  await act(async () => { first.resolve(jsonRes({ wines: [BAROLO] })); });
  expect(screen.queryByText('Barolo')).toBeNull();
  expect(spinner(container)).not.toBeNull();

  await act(async () => { second.resolve(jsonRes({ wines: [BARBARESCO] })); });
  expect(await screen.findByText('Barbaresco')).toBeInTheDocument();
  expect(spinner(container)).toBeNull();
});

test('a search that answers after the box was emptied opens nothing', async () => {
  const pending = deferred();
  searchWines.mockReturnValueOnce(pending.promise);
  const { container } = render(<WineSearchPicker selected={null} onSelect={() => {}} />);
  type('barolo');
  await waitFor(() => expect(searchWines).toHaveBeenCalledTimes(1));

  type('');
  expect(spinner(container)).toBeNull();
  await act(async () => { pending.resolve(jsonRes({ wines: [BAROLO] })); });
  expect(screen.queryByRole('listbox')).toBeNull();
  expect(screen.queryByText('Barolo')).toBeNull();
});
