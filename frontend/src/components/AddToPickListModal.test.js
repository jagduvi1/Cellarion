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
