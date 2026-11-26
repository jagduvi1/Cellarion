import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../api/bottles', () => ({
  moveBottle: vi.fn(),
  bulkMoveBottles: vi.fn(),
}));
vi.mock('../api/cellars', () => ({
  listCellars: vi.fn(),
}));

// `t` must keep a stable identity across renders (see AddMoreBottlesModal.test.js).
// Vars are appended so plural/interpolation calls stay observable.
vi.mock('react-i18next', () => {
  const t = (key, a, b) => {
    const vars = b && typeof b === 'object' ? b : (a && typeof a === 'object' ? a : undefined);
    return vars ? `${key}:${JSON.stringify(vars)}` : key;
  };
  return { useTranslation: () => ({ t }) };
});

const { apiFetch } = vi.hoisted(() => ({ apiFetch: () => {} }));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ apiFetch }),
}));

const { moveBottle, bulkMoveBottles } = await import('../api/bottles');
const { listCellars } = await import('../api/cellars');
const MoveBottleModal = (await import('./MoveBottleModal')).default;

// The user's own cellars (owner u1), one a friend shares with them as editor
// and one shared as viewer.
const CELLARS = [
  { _id: 'c1', name: 'Storage', user: 'u1', userRole: 'owner' },
  { _id: 'c2', name: 'Home', user: 'u1', userRole: 'owner' },
  { _id: 'c3', name: 'Shared with me', user: 'friend', userRole: 'editor' },
  { _id: 'c4', name: 'Only to look at', user: 'friend', userRole: 'viewer' },
];
const SHARED_OPTION = 'moveBottle.sharedOption:{"name":"Shared with me"}';

beforeEach(() => {
  vi.clearAllMocks();
  listCellars.mockResolvedValue({ json: async () => ({ cellars: CELLARS }) });
});

describe('MoveBottleModal', () => {
  test('bulk mode: offers the OTHER cellars the user owns or edits, sends every id in one request, and reports what was skipped', async () => {
    bulkMoveBottles.mockResolvedValue({
      ok: true,
      json: async () => ({ moved: 2, skipped: [{ id: 'b3', reason: 'not_active' }] }),
    });
    const onMoved = vi.fn();
    render(<MoveBottleModal bottleIds={['b1', 'b2', 'b3']} currentCellarId="c1" onClose={() => {}} onMoved={onMoved} />);

    expect(await screen.findByText('moveBottle.titleMany:{"count":3}')).toBeTruthy();
    const select = await screen.findByRole('combobox');
    expect(screen.getByRole('option', { name: 'Home' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'Storage' })).toBeNull();        // the current cellar
    expect(screen.getByRole('option', { name: SHARED_OPTION })).toBeTruthy();    // edited: offered, marked shared
    expect(screen.queryByRole('option', { name: /Only to look at/ })).toBeNull(); // viewed only

    fireEvent.change(select, { target: { value: 'c2' } });
    fireEvent.click(screen.getByText('moveBottle.moveManyButton:{"count":3}'));

    await waitFor(() => expect(bulkMoveBottles).toHaveBeenCalledWith(apiFetch, ['b1', 'b2', 'b3'], 'c2'));
    expect(await screen.findByText('moveBottle.movedManyInfo:{"count":2,"cellar":"Home"}')).toBeTruthy();
    expect(screen.getByText('moveBottle.skippedInfo:{"count":1}')).toBeTruthy();
    expect(moveBottle).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('moveBottle.backToCellar'));
    expect(onMoved).toHaveBeenCalledTimes(1);
  });

  test('single mode is unchanged: one moveBottle call, single-bottle wording', async () => {
    moveBottle.mockResolvedValue({ ok: true, json: async () => ({ bottle: { _id: 'b1' } }) });
    render(<MoveBottleModal bottleId="b1" currentCellarId="c1" onClose={() => {}} onMoved={() => {}} />);

    expect(await screen.findByText('moveBottle.title')).toBeTruthy();
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'c2' } });
    fireEvent.click(screen.getByText('moveBottle.moveButton'));

    await waitFor(() => expect(moveBottle).toHaveBeenCalledWith(apiFetch, 'b1', 'c2'));
    expect(await screen.findByText('moveBottle.movedInfo:{"cellar":"Home"}')).toBeTruthy();
    expect(bulkMoveBottles).not.toHaveBeenCalled();
  });

  test('moving into a cellar someone else owns says the bottles become theirs', async () => {
    render(<MoveBottleModal bottleIds={['b1', 'b2']} currentCellarId="c1" onClose={() => {}} onMoved={() => {}} />);
    const select = await screen.findByRole('combobox');

    fireEvent.change(select, { target: { value: 'c2' } }); // own → own: nothing changes hands
    expect(screen.queryByRole('status')).toBeNull();

    fireEvent.change(select, { target: { value: 'c3' } });
    expect(screen.getByRole('status')).toHaveTextContent('moveBottle.becomesOwners:{"count":2}');
  });

  test('moving out of a shared cellar into an own one says the bottle becomes yours', async () => {
    render(<MoveBottleModal bottleId="b1" currentCellarId="c3" onClose={() => {}} onMoved={() => {}} />);
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'c2' } });
    expect(screen.getByRole('status')).toHaveTextContent('moveBottle.becomesYours:{"count":1}');
  });

  test('a server error is shown and the modal stays open', async () => {
    bulkMoveBottles.mockResolvedValue({ ok: false, json: async () => ({ error: 'Destination cellar not found' }) });
    render(<MoveBottleModal bottleIds={['b1']} currentCellarId="c1" onClose={() => {}} onMoved={() => {}} />);

    fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'c2' } });
    fireEvent.click(screen.getByText('moveBottle.moveManyButton:{"count":1}'));

    expect(await screen.findByRole('alert')).toHaveTextContent('Destination cellar not found');
    expect(screen.getByText('moveBottle.titleMany:{"count":1}')).toBeTruthy();
  });
});
