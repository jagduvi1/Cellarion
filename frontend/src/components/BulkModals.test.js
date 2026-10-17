import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../api/bottles', () => ({
  bulkUpdateBottles: vi.fn(),
  bulkConsumeBottles: vi.fn(),
  restoreBottle: vi.fn(),
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

const { bulkUpdateBottles, bulkConsumeBottles, restoreBottle } = await import('../api/bottles');
const { getWineLists, getWineList, addBottlesToWineList } = await import('../api/wineLists');
const BulkPurchaseModal = (await import('./BulkPurchaseModal')).default;
const BulkConsumeModal = (await import('./BulkConsumeModal')).default;
const BulkReserveModal = (await import('./BulkReserveModal')).default;
const BulkAddToListModal = (await import('./BulkAddToListModal')).default;
const BulkDrinkWindowModal = (await import('./BulkDrinkWindowModal')).default;

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
  test('one reason and one date for the whole selection; reserved bottles are left alone, then offered', async () => {
    bulkConsumeBottles
      .mockResolvedValueOnce(okResult({ done: 2, skipped: [{ id: 'b3', reason: 'not_active' }, { id: 'b4', reason: 'reserved' }] }))
      .mockResolvedValueOnce(okResult({ done: 1, skipped: [] }));
    const { container } = render(<BulkConsumeModal bottleIds={['b1', 'b2', 'b3', 'b4']} onClose={() => {}} onDone={() => {}} />);

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'gifted' } });
    fireEvent.change(container.querySelector('input[type="date"]'), { target: { value: '2026-08-30' } });
    fireEvent.click(screen.getByText('bulk.consumeSubmit:{"count":4}'));

    await waitFor(() => expect(bulkConsumeBottles).toHaveBeenCalledWith(apiFetch, ['b1', 'b2', 'b3', 'b4'], {
      reason: 'gifted', note: undefined, consumedAt: '2026-08-30', includeReserved: false,
    }));
    expect(await screen.findByText('bulk.doneInfo:{"count":2}')).toBeTruthy();
    expect(screen.getByText('bulk.skippedInfo:{"count":1}')).toBeTruthy();        // the consumed one
    expect(screen.getByText('bulk.reservedSkipped:{"count":1}')).toBeTruthy();   // the reserved one, offered

    fireEvent.click(screen.getByText('bulk.consumeReservedToo'));
    await waitFor(() => expect(bulkConsumeBottles).toHaveBeenLastCalledWith(apiFetch, ['b4'], {
      reason: 'gifted', note: undefined, consumedAt: '2026-08-30', includeReserved: true,
    }));
    expect(await screen.findByText('bulk.doneInfo:{"count":3}')).toBeTruthy();
    expect(screen.queryByText('bulk.consumeReservedToo')).toBeNull();
  });

  // The cellar list's "Mark as drunk" and the pick list's "Mark picked as
  // drunk" both end here: the whole batch can be put back, as one drink can.
  test('Undo puts every bottle the batch took out back — the reserved ones taken out after too', async () => {
    bulkConsumeBottles
      .mockResolvedValueOnce(okResult({ done: 2, doneIds: ['b1', 'b2'], skipped: [{ id: 'b3', reason: 'reserved' }] }))
      .mockResolvedValueOnce(okResult({ done: 1, doneIds: ['b3'], skipped: [] }));
    restoreBottle.mockResolvedValue(okResult({ bottle: {} }));
    const onDone = vi.fn();
    render(<BulkConsumeModal bottleIds={['b1', 'b2', 'b3']} onClose={() => {}} onDone={onDone} />);

    fireEvent.click(screen.getByText('bulk.consumeSubmit:{"count":3}'));
    fireEvent.click(await screen.findByText('bulk.consumeReservedToo'));
    expect(await screen.findByText('bulk.doneInfo:{"count":3}')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'common.undo' }));

    expect(await screen.findByText('trash.restoredInfo:{"count":3}')).toBeTruthy();
    expect(restoreBottle.mock.calls.map(([, id]) => id)).toEqual(['b1', 'b2', 'b3']);
    expect(screen.getByText('trash.restoredTitle')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'common.undo' })).toBeNull();
    fireEvent.click(screen.getByText('bulk.close'));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  test('a bottle that cannot come back is counted with the reason, never reported as back', async () => {
    bulkConsumeBottles.mockResolvedValueOnce(okResult({ done: 3, doneIds: ['b1', 'b2', 'b3'], skipped: [] }));
    restoreBottle
      .mockResolvedValueOnce(okResult({ bottle: {} }))
      .mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({ error: 'Bottle is already active' }) })
      .mockResolvedValueOnce(okResult({ bottle: {} }));
    render(<BulkConsumeModal bottleIds={['b1', 'b2', 'b3']} onClose={() => {}} onDone={() => {}} />);

    fireEvent.click(screen.getByText('bulk.consumeSubmit:{"count":3}'));
    fireEvent.click(await screen.findByRole('button', { name: 'common.undo' }));

    expect(await screen.findByText('trash.restoredInfo:{"count":2}')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe('bulk.consumeUndoFailed:{"count":1} Bottle is already active');
  });

  test('a rate limit stops the run: the bottles not tried yet count as not back', async () => {
    bulkConsumeBottles.mockResolvedValueOnce(okResult({ done: 3, doneIds: ['b1', 'b2', 'b3'], skipped: [] }));
    restoreBottle
      .mockResolvedValueOnce(okResult({ bottle: {} }))
      .mockResolvedValueOnce({ ok: false, status: 429, json: async () => ({ error: 'Too many write requests' }) });
    render(<BulkConsumeModal bottleIds={['b1', 'b2', 'b3']} onClose={() => {}} onDone={() => {}} />);

    fireEvent.click(screen.getByText('bulk.consumeSubmit:{"count":3}'));
    fireEvent.click(await screen.findByRole('button', { name: 'common.undo' }));

    expect(await screen.findByText('trash.restoredInfo:{"count":1}')).toBeTruthy();
    expect(restoreBottle).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('alert').textContent).toMatch(/^bulk\.consumeUndoFailed:\{"count":2\} errors\.rateLimited/);
  });

  test('nothing taken out, nothing to undo', async () => {
    bulkConsumeBottles.mockResolvedValueOnce(okResult({ done: 0, doneIds: [], skipped: [{ id: 'b1', reason: 'not_active' }] }));
    render(<BulkConsumeModal bottleIds={['b1']} onClose={() => {}} onDone={() => {}} />);

    fireEvent.click(screen.getByText('bulk.consumeSubmit:{"count":1}'));
    expect(await screen.findByText('bulk.doneInfo:{"count":0}')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'common.undo' })).toBeNull();
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

describe('BulkDrinkWindowModal', () => {
  test('sends only the filled-in years as integers and shows the outcome', async () => {
    bulkUpdateBottles.mockResolvedValue(okResult({ done: 3, skipped: [{ id: 'b3', reason: 'invalid' }] }));
    const onDone = vi.fn();
    const { container } = render(<BulkDrinkWindowModal bottleIds={['b1', 'b2', 'b3']} onClose={() => {}} onDone={onDone} />);
    expect(screen.getByText('bulk.windowTitle:{"count":3}')).toBeTruthy();
    const inputs = container.querySelectorAll('input[type="number"]');
    fireEvent.change(inputs[0], { target: { value: '2028' } });
    fireEvent.change(inputs[1], { target: { value: '2040' } });
    fireEvent.click(screen.getByText('bulk.windowSubmit'));
    await waitFor(() => expect(bulkUpdateBottles).toHaveBeenCalledWith(apiFetch, ['b1', 'b2', 'b3'], { drinkFrom: 2028, drinkTo: 2040 }));
    expect(await screen.findByText('bulk.doneInfo:{"count":3}')).toBeTruthy();
    expect(screen.getByText('bulk.windowSkippedInfo:{"count":1}')).toBeTruthy();
    fireEvent.click(screen.getByText('bulk.close'));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  test('refuses an empty form and a peak outside the window before calling the API', async () => {
    const { container } = render(<BulkDrinkWindowModal bottleIds={['b1']} onClose={() => {}} onDone={() => {}} />);
    fireEvent.click(screen.getByText('bulk.windowSubmit'));
    expect(await screen.findByText('bulk.windowNeedsSomething')).toBeTruthy();
    const inputs = container.querySelectorAll('input[type="number"]');
    fireEvent.change(inputs[0], { target: { value: '2030' } });
    fireEvent.change(inputs[2], { target: { value: '2028' } });
    fireEvent.click(screen.getByText('bulk.windowSubmit'));
    expect(await screen.findByText('addBottle.peakBeforeWindow')).toBeTruthy();
    expect(bulkUpdateBottles).not.toHaveBeenCalled();
  });

  test('clear mode nulls all four years', async () => {
    bulkUpdateBottles.mockResolvedValue(okResult({ done: 2, skipped: [] }));
    render(<BulkDrinkWindowModal bottleIds={['b1', 'b2']} onClose={() => {}} onDone={() => {}} />);
    fireEvent.click(screen.getByLabelText('bulk.windowClearMode'));
    fireEvent.click(screen.getByText('bulk.windowClearSubmit'));
    await waitFor(() => expect(bulkUpdateBottles).toHaveBeenCalledWith(apiFetch, ['b1', 'b2'], { drinkFrom: null, drinkTo: null, peakFrom: null, peakUntil: null }));
  });
});
