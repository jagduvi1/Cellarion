import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../api/bottles', () => ({
  bulkUpdateBottles: vi.fn(),
  bulkConsumeBottles: vi.fn(),
}));
vi.mock('../api/wineLists', () => ({
  getWineLists: vi.fn(),
  getWineList: vi.fn(),
  createWineList: vi.fn(),
  addBottlesToWineList: vi.fn(),
}));

// Stable `t` (see AddMoreBottlesModal.test.js); vars are appended so plural /
// interpolation calls stay observable.
vi.mock('react-i18next', () => {
  const t = (key, a, b) => {
    const vars = b && typeof b === 'object' ? b : (a && typeof a === 'object' ? a : undefined);
    return vars ? `${key}:${JSON.stringify(vars)}` : key;
  };
  return { useTranslation: () => ({ t }) };
});

const { apiFetch } = vi.hoisted(() => ({ apiFetch: () => {} }));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ apiFetch, user: { preferences: { currency: 'SEK' } } }),
}));

const { bulkUpdateBottles, bulkConsumeBottles } = await import('../api/bottles');
const { getWineLists, getWineList, addBottlesToWineList } = await import('../api/wineLists');
const BulkPurchaseModal = (await import('./BulkPurchaseModal')).default;
const BulkConsumeModal = (await import('./BulkConsumeModal')).default;
const BulkReserveModal = (await import('./BulkReserveModal')).default;
const BulkAddToListModal = (await import('./BulkAddToListModal')).default;

const okResult = (data) => ({ ok: true, json: async () => data });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('BulkPurchaseModal', () => {
  test('sends only the filled-in fields, with the price in the user\'s currency, and shows the outcome', async () => {
    bulkUpdateBottles.mockResolvedValue(okResult({ done: 2, skipped: [] }));
    const onDone = vi.fn();
    const { container } = render(<BulkPurchaseModal bottleIds={['b1', 'b2']} onClose={() => {}} onDone={onDone} />);

    expect(screen.getByText('bulk.purchaseTitle:{"count":2}')).toBeTruthy();
    const submit = screen.getByText('bulk.purchaseSubmit');
    expect(submit.closest('button').disabled).toBe(true); // nothing filled in yet

    fireEvent.change(container.querySelector('input[type="date"]'), { target: { value: '2026-09-01' } });
    fireEvent.change(container.querySelector('input[type="number"]'), { target: { value: '120' } });
    fireEvent.click(submit);

    await waitFor(() => expect(bulkUpdateBottles).toHaveBeenCalledWith(apiFetch, ['b1', 'b2'], {
      purchaseDate: '2026-09-01', price: 120, currency: 'SEK',
    }));
    expect(await screen.findByText('bulk.doneInfo:{"count":2}')).toBeTruthy();
    fireEvent.click(screen.getByText('bulk.close'));
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});

describe('BulkConsumeModal', () => {
  test('one reason and one date for the whole selection; skipped bottles are reported', async () => {
    bulkConsumeBottles.mockResolvedValue(okResult({ done: 2, skipped: [{ id: 'b3', reason: 'not_active' }] }));
    const { container } = render(<BulkConsumeModal bottleIds={['b1', 'b2', 'b3']} onClose={() => {}} onDone={() => {}} />);

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'gifted' } });
    fireEvent.change(container.querySelector('input[type="date"]'), { target: { value: '2026-08-30' } });
    fireEvent.click(screen.getByText('bulk.consumeSubmit:{"count":3}'));

    await waitFor(() => expect(bulkConsumeBottles).toHaveBeenCalledWith(apiFetch, ['b1', 'b2', 'b3'], {
      reason: 'gifted', note: undefined, consumedAt: '2026-08-30',
    }));
    expect(await screen.findByText('bulk.doneInfo:{"count":2}')).toBeTruthy();
    expect(screen.getByText('bulk.skippedInfo:{"count":1}')).toBeTruthy();
  });
});

describe('BulkReserveModal', () => {
  test('reserve mode sends the note and the year; clear mode sends nulls', async () => {
    bulkUpdateBottles.mockResolvedValue(okResult({ done: 1, skipped: [] }));
    const { unmount } = render(<BulkReserveModal bottleIds={['b1']} onClose={() => {}} onDone={() => {}} />);

    fireEvent.change(screen.getByPlaceholderText('bottleDetail.reservedForPlaceholder'), { target: { value: 'Anna' } });
    fireEvent.change(screen.getByPlaceholderText('bottleDetail.reservedUntilPlaceholder'), { target: { value: '2030' } });
    fireEvent.click(screen.getByText('bulk.reserveSubmit'));
    await waitFor(() => expect(bulkUpdateBottles).toHaveBeenCalledWith(apiFetch, ['b1'], { reservedFor: 'Anna', reservedUntil: 2030 }));
    unmount();

    render(<BulkReserveModal bottleIds={['b1']} onClose={() => {}} onDone={() => {}} />);
    fireEvent.click(screen.getByLabelText('bulk.clearMode'));
    fireEvent.click(screen.getByText('bulk.clearSubmit'));
    await waitFor(() => expect(bulkUpdateBottles).toHaveBeenLastCalledWith(apiFetch, ['b1'], { reservedFor: null, reservedUntil: null }));
  });

  test('reserve mode with nothing filled in is refused locally', async () => {
    render(<BulkReserveModal bottleIds={['b1']} onClose={() => {}} onDone={() => {}} />);
    fireEvent.click(screen.getByText('bulk.reserveSubmit'));
    expect(await screen.findByRole('alert')).toHaveTextContent('bulk.reserveNeedsSomething');
    expect(bulkUpdateBottles).not.toHaveBeenCalled();
  });
});

describe('BulkAddToListModal', () => {
  test('offers the cellar\'s lists, adds in one request, and names the list in the outcome', async () => {
    getWineLists.mockResolvedValue({ json: async () => [{ _id: 'l1', name: 'Dinner menu', structureMode: 'auto' }] });
    addBottlesToWineList.mockResolvedValue(okResult({ added: 1, skipped: [{ id: 'b2', reason: 'already_on_list' }], list: { _id: 'l1', name: 'Dinner menu' } }));
    render(<BulkAddToListModal bottleIds={['b1', 'b2']} cellarId="c1" onClose={() => {}} onDone={() => {}} />);

    const select = await screen.findByRole('combobox');
    fireEvent.change(select, { target: { value: 'l1' } });
    fireEvent.click(screen.getByText('bulk.listSubmit'));

    await waitFor(() => expect(addBottlesToWineList).toHaveBeenCalledWith(apiFetch, 'l1', ['b1', 'b2'], undefined));
    expect(getWineList).not.toHaveBeenCalled(); // auto list: no section lookup
    expect(await screen.findByText('bulk.doneInfo:{"count":1}')).toBeTruthy();
    expect(screen.getByText('bulk.listSkippedInfo:{"count":1}')).toBeTruthy();
    expect(screen.getByText('Dinner menu')).toBeTruthy();
  });
});
