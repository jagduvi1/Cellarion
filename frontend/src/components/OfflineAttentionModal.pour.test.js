import { render, screen, fireEvent, act, within } from '@testing-library/react';
import OfflineAttentionModal from './OfflineAttentionModal';

// A pour refused because glasses were poured meanwhile can be applied anyway
// (my glass on top of what is poured now); a consume refused because the
// bottle already left the cellar still cannot (it would overwrite that record).
const q = vi.hoisted(() => ({ ops: [] }));
vi.mock('../utils/offlineQueue', () => ({
  listAttention: vi.fn(async () => q.ops),
  resolveAttention: vi.fn(async (id) => { q.ops = q.ops.filter((o) => o.id !== id); }),
}));
import { resolveAttention } from '../utils/offlineQueue';

const refused = (kind, over = {}) => ({
  id: `${kind}-1`, userId: 'u1', kind, status: 'attention', createdAt: '2026-09-24T18:00:00.000Z',
  label: { wine: 'Barolo 2016' }, error: 'refused', code: 'state_changed', httpStatus: 409, body: {}, ...over,
});

beforeEach(() => { vi.clearAllMocks(); });

it('a pour poured over meanwhile offers "Apply anyway" and "Discard"', async () => {
  q.ops = [refused('pour', { body: { ml: 150, expectPours: 1 } })];
  const onClose = vi.fn();
  await act(async () => { render(<OfflineAttentionModal userId="u1" onClose={onClose} />); });
  expect(screen.getByRole('button', { name: 'Discard' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Apply anyway' })); });
  expect(resolveAttention).toHaveBeenCalledWith('pour-1', 'force', 'u1');
  expect(onClose).toHaveBeenCalled();
});

it('a consume of a bottle that already left the cellar still offers only "Discard"', async () => {
  q.ops = [refused('consume', { body: { reason: 'drank', ifActive: true } })];
  await act(async () => { render(<OfflineAttentionModal userId="u1" onClose={vi.fn()} />); });
  expect(screen.getByRole('button', { name: 'Discard' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Apply anyway' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
});

// The pour check exists for a glass that already reached the server, whose
// reply was lost and which was sent again: applying it anyway would list it
// twice. So the refusal is said in the user's language with how to tell, and
// Discard is the suggested (primary) choice for that case only.
const POUR_LINE = 'Glasses were poured from this bottle meanwhile. If this glass is already listed on the bottle, choose Discard.';

it('a refused pour says how to tell in a translated line and suggests "Discard"', async () => {
  q.ops = [refused('pour', { error: 'Glasses were poured from this bottle meanwhile', body: { ml: 150, expectPours: 1 } })];
  await act(async () => { render(<OfflineAttentionModal userId="u1" onClose={vi.fn()} />); });
  const [item] = screen.getAllByRole('listitem');
  expect(item).toHaveTextContent(` — ${POUR_LINE}`);
  const discard = screen.getByRole('button', { name: 'Discard' });
  const apply = screen.getByRole('button', { name: 'Apply anyway' });
  expect(discard).toHaveClass('btn', 'btn-primary', 'btn-small');
  expect(discard).not.toHaveClass('btn-secondary');
  expect(apply).toHaveClass('btn', 'btn-secondary', 'btn-small');
  expect(apply).not.toHaveClass('btn-primary');
  // Same buttons in the same order: only the primary look moved.
  expect(within(item).getAllByRole('button').map((b) => b.textContent)).toEqual(['Apply anyway', 'Discard']);
});

it('every other refused change renders as before: the server line, its own primary button', async () => {
  q.ops = [
    refused('move', { id: 'move-1', code: 'slot_changed', error: 'That slot is no longer free', body: {} }),
    refused('consume', { id: 'consume-1', error: 'This bottle has already left the cellar', body: { reason: 'drank', ifActive: true } }),
    refused('edit', { id: 'edit-1', code: 'field_changed', error: 'Changed meanwhile', body: { notes: 'mine' }, current: { notes: 'theirs' } }),
  ];
  await act(async () => { render(<OfflineAttentionModal userId="u1" onClose={vi.fn()} />); });
  expect(screen.queryByText(/choose Discard/)).toBeNull();
  const [move, consume, edit] = screen.getAllByRole('listitem');

  expect(move).toHaveTextContent(' — That slot is no longer free');
  expect(within(move).getByRole('button', { name: 'Apply anyway' })).toHaveClass('btn-primary');
  expect(within(move).getByRole('button', { name: 'Discard' })).toHaveClass('btn-secondary');

  expect(consume).toHaveTextContent(' — This bottle has already left the cellar');
  expect(within(consume).getAllByRole('button')).toHaveLength(1);
  expect(within(consume).getByRole('button', { name: 'Discard' })).toHaveClass('btn-secondary');

  expect(edit).toHaveTextContent(' — Changed meanwhile');
  expect(within(edit).getByRole('button', { name: 'Keep mine' })).toHaveClass('btn-primary');
  expect(within(edit).getByRole('button', { name: 'Keep theirs' })).toHaveClass('btn-secondary');
});
