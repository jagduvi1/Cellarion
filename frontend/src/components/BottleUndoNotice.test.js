import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import BottleUndoNotice from './BottleUndoNotice';

// After the bottle page takes a bottle away, the list says so with the way
// back right there: a drunk bottle is restored as active, a bottle "added by
// mistake" comes back out of Recently deleted.

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k, fallback, opts) => String(typeof fallback === 'string' ? fallback : k)
      .replace('{{name}}', opts?.name).replace('{{days}}', opts?.days),
  }),
}));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ apiFetch: vi.fn() }) }));
vi.mock('../api/bottles', () => ({ restoreBottle: vi.fn(), restoreRecentlyDeleted: vi.fn() }));

const { restoreBottle, restoreRecentlyDeleted } = await import('../api/bottles');
const json = (status, body) => ({ ok: status < 400, status, json: async () => body });

beforeEach(() => vi.clearAllMocks());

test('a drunk bottle can be put back with one tap', async () => {
  restoreBottle.mockResolvedValue(json(200, { bottle: {} }));
  const onUndone = vi.fn();
  render(<BottleUndoNotice notice={{ kind: 'consumed', reason: 'drank', bottleId: 'b1', name: 'Barolo 2016' }} cellarId="c1" onUndone={onUndone} onDismiss={() => {}} />);

  expect(screen.getByRole('status')).toHaveTextContent('“Barolo 2016” is marked as drunk.');
  fireEvent.click(screen.getByText('Undo'));

  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('is back in the cellar'));
  expect(restoreBottle).toHaveBeenCalledWith(expect.any(Function), 'b1');
  expect(onUndone).toHaveBeenCalledTimes(1);
  expect(screen.queryByText('Undo')).not.toBeInTheDocument();
});

test('a bottle added by mistake comes back out of Recently deleted', async () => {
  restoreRecentlyDeleted.mockResolvedValue(json(200, { restored: 1 }));
  render(<BottleUndoNotice notice={{ kind: 'deleted', bottleId: 'b1', batchId: 'batch9', name: 'Barolo 2016' }} cellarId="c1" onDismiss={() => {}} />);

  expect(screen.getByRole('status')).toHaveTextContent('moved to Recently deleted. You can bring it back for 30 days.');
  fireEvent.click(screen.getByText('Undo'));

  await waitFor(() => expect(restoreRecentlyDeleted).toHaveBeenCalledWith(expect.any(Function), 'c1', { batchId: 'batch9' }));
});

test('a refused undo says why and can be tried again', async () => {
  restoreBottle.mockResolvedValue(json(409, { error: 'Restore window has passed' }));
  render(<BottleUndoNotice notice={{ kind: 'consumed', reason: 'gifted', bottleId: 'b1', name: 'Barolo 2016' }} cellarId="c1" onDismiss={() => {}} />);

  expect(screen.getByRole('status')).toHaveTextContent('is taken out of the cellar');
  fireEvent.click(screen.getByText('Undo'));

  expect(await screen.findByRole('alert')).toHaveTextContent('Restore window has passed');
  expect(screen.getByText('Undo')).not.toBeDisabled();
});

test('a restore that brought nothing back says why instead of "it is back"', async () => {
  restoreRecentlyDeleted.mockResolvedValue(json(200, { restored: 0, skipped: [{ id: 'b1', reason: 'wine_gone' }] }));
  render(<BottleUndoNotice notice={{ kind: 'deleted', bottleId: 'b1', batchId: 'batch9', name: 'Barolo 2016' }} cellarId="c1" onDismiss={() => {}} />);

  fireEvent.click(screen.getByText('Undo'));

  expect(await screen.findByRole('alert')).toHaveTextContent('trash.skippedWineGone');
  expect(screen.getByRole('status')).not.toHaveTextContent('is back in the cellar');
});

test('already back (restored elsewhere meanwhile) counts as undone', async () => {
  restoreRecentlyDeleted.mockResolvedValue(json(200, { restored: 0, skipped: [{ id: 'b1', reason: 'exists' }] }));
  render(<BottleUndoNotice notice={{ kind: 'deleted', bottleId: 'b1', batchId: 'batch9', name: 'Barolo 2016' }} cellarId="c1" onDismiss={() => {}} />);

  fireEvent.click(screen.getByText('Undo'));
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('is back in the cellar'));
});
