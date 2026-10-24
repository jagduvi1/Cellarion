import { render, screen, fireEvent, act } from '@testing-library/react';
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
