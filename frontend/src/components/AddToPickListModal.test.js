/**
 * "Add to a pick list" (early access, flag pickLists): the bottles go on an
 * existing list, or a new one created right here; the done screen counts what
 * was added and skipped and links to the list.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { apiFetchMock } = vi.hoisted(() => ({ apiFetchMock: vi.fn() }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, fallback, vars) => {
      if (fallback && typeof fallback === 'object') return String(fallback.defaultValue ?? key);
      return typeof fallback === 'string' ? fallback.replace(/\{\{(\w+)\}\}/g, (_, k) => vars?.[k] ?? '') : key;
    },
  }),
}));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ apiFetch: apiFetchMock }) }));
vi.mock('react-router-dom', () => ({ Link: ({ children, to }) => <a href={to}>{children}</a> }));

const AddToPickListModal = (await import('./AddToPickListModal')).default;
const json = (body, ok = true) => ({ ok, json: async () => body });

beforeEach(() => vi.clearAllMocks());

test('adds to the chosen existing list and links to it', async () => {
  apiFetchMock.mockImplementation(async (url, opts) => {
    if (!opts) return json({ lists: [{ id: 'pl1', name: 'Saturday dinner', count: 2, picked: 0 }] });
    return json({ list: { id: 'pl1', name: 'Saturday dinner' }, added: 2, skipped: [{ id: 'b3', reason: 'already_on_list' }] });
  });
  render(<AddToPickListModal bottleIds={['b1', 'b2', 'b3']} onClose={vi.fn()} onDone={vi.fn()} />);
  await screen.findByRole('option', { name: 'Saturday dinner' });
  fireEvent.click(screen.getByRole('button', { name: 'Add' }));
  expect(await screen.findByText('Added to the pick list')).toBeInTheDocument();
  const [url, opts] = apiFetchMock.mock.calls[1];
  expect(url).toBe('/api/pick-lists/pl1/items');
  expect(JSON.parse(opts.body)).toEqual({ bottleIds: ['b1', 'b2', 'b3'] });
  expect(screen.getByText('2 bottles added.')).toBeInTheDocument();
  expect(screen.getByText(/1 skipped/)).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Open the pick list' })).toHaveAttribute('href', '/pick-lists/pl1');
});

// Release audit 2026-10-13: a failed fetch silently offered "new list".
test('a failed load of the lists is said, and a new list can still be made', async () => {
  apiFetchMock.mockResolvedValue({ ok: false, json: async () => ({ error: 'nope' }) });
  render(<AddToPickListModal bottleIds={['b1']} onClose={vi.fn()} onDone={vi.fn()} />);
  expect(await screen.findByText('Could not load your pick lists.')).toBeInTheDocument();
  expect(screen.getByPlaceholderText('e.g. Saturday dinner')).toBeInTheDocument();
});

test('with no lists yet, it creates one with the bottles', async () => {
  apiFetchMock.mockImplementation(async (url, opts) => {
    if (!opts) return json({ lists: [] });
    return json({ list: { id: 'pl9', name: 'Drink next' }, added: 1, skipped: [] });
  });
  render(<AddToPickListModal bottleIds={['b1']} onClose={vi.fn()} onDone={vi.fn()} />);
  const name = await screen.findByPlaceholderText('e.g. Saturday dinner');
  expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();
  fireEvent.change(name, { target: { value: 'Drink next' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add' }));
  await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(2));
  const [url, opts] = apiFetchMock.mock.calls[1];
  expect(url).toBe('/api/pick-lists');
  expect(JSON.parse(opts.body)).toEqual({ name: 'Drink next', bottleIds: ['b1'] });
  expect(await screen.findByRole('link', { name: 'Open the pick list' })).toHaveAttribute('href', '/pick-lists/pl9');
});

// Beta feedback 2026-10-14: from the vintage page the bottles of one wine and
// year are offered to choose from, named by their rack slot.
describe('choosing bottles (the vintage page)', () => {
  const CHOICES = [
    { _id: 'b1', rackInfo: { rackName: 'Left wall', position: 3 } },
    { _id: 'b2', rackInfo: { rackName: 'Left wall', position: 7 }, purchaseLocation: 'Systembolaget', price: 380, currency: 'SEK' },
    { _id: 'b3', rackInfo: null },
  ];
  const listsThenAdd = () => apiFetchMock.mockImplementation(async (url, opts) => {
    if (!opts) return json({ lists: [{ id: 'pl1', name: 'Saturday dinner', count: 0, picked: 0 }] });
    return json({ list: { id: 'pl1', name: 'Saturday dinner' }, added: 2, skipped: [] });
  });

  test('the first bottle is ticked; the ones ticked go, in the bottles\' order', async () => {
    listsThenAdd();
    render(<AddToPickListModal choices={CHOICES} onClose={vi.fn()} onDone={vi.fn()} />);
    await screen.findByRole('option', { name: 'Saturday dinner' });
    expect(screen.getByText('Which bottles?')).toBeInTheDocument();
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes.map((b) => b.checked)).toEqual([true, false, false]);
    // Each row is named by where the bottle sits.
    expect(screen.getByText('Left wall · slot 7')).toBeInTheDocument();
    expect(screen.getByText('Systembolaget · 380 SEK')).toBeInTheDocument();
    expect(screen.getByText('Not in a rack')).toBeInTheDocument();

    fireEvent.click(boxes[2]);
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await screen.findByText('Added to the pick list');
    expect(JSON.parse(apiFetchMock.mock.calls[1][1].body)).toEqual({ bottleIds: ['b1', 'b3'] });
  });

  test('nothing ticked: Add is off', async () => {
    listsThenAdd();
    render(<AddToPickListModal choices={CHOICES} onClose={vi.fn()} onDone={vi.fn()} />);
    await screen.findByRole('option', { name: 'Saturday dinner' });
    fireEvent.click(screen.getAllByRole('checkbox')[0]);
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();
    expect(screen.getByText('Choose the bottles to add')).toBeInTheDocument();
  });

  test('one bottle: nothing to choose, it is the one added', async () => {
    listsThenAdd();
    render(<AddToPickListModal choices={[CHOICES[0]]} onClose={vi.fn()} onDone={vi.fn()} />);
    await screen.findByRole('option', { name: 'Saturday dinner' });
    expect(screen.queryByRole('checkbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await screen.findByText('Added to the pick list');
    expect(JSON.parse(apiFetchMock.mock.calls[1][1].body)).toEqual({ bottleIds: ['b1'] });
  });
});
