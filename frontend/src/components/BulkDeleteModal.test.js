import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../api/bottles', () => ({
  bulkDeleteBottles: vi.fn(),
  restoreRecentlyDeleted: vi.fn(),
}));

// `t` keeps a stable identity across renders; vars are appended so plural and
// interpolation calls stay observable.
vi.mock('react-i18next', () => {
  const t = (key, a, b) => {
    const vars = b && typeof b === 'object' ? b : (a && typeof a === 'object' ? a : undefined);
    return vars ? `${key}:${JSON.stringify(vars)}` : key;
  };
  return { useTranslation: () => ({ t, i18n: { language: 'en' } }) };
});

const { apiFetch } = vi.hoisted(() => ({ apiFetch: () => {} }));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ apiFetch }),
}));

const { bulkDeleteBottles, restoreRecentlyDeleted } = await import('../api/bottles');
const { default: BulkDeleteModal, TYPE_TO_CONFIRM_FROM, TRASH_DAYS } = await import('./BulkDeleteModal');

const ids = (n) => Array.from({ length: n }, (_, i) => `b${i + 1}`);
const deleteButton = (n) => screen.getByRole('button', { name: `bulk.deleteSubmit:{"count":${n}}` });

beforeEach(() => vi.clearAllMocks());

describe('BulkDeleteModal', () => {
  test('a small batch: names what goes, promises Recently deleted, deletes on the red button', async () => {
    bulkDeleteBottles.mockResolvedValue({ ok: true, json: async () => ({ deleted: 3, skipped: [], batchId: 'batch1', purgeAt: '2026-11-11T08:00:00.000Z' }) });
    const onDone = vi.fn();
    render(
      <BulkDeleteModal
        bottleIds={ids(3)}
        cellarId="c1"
        summary={[{ key: 'a', label: 'Azelia Barolo 2016', count: 2 }, { key: 'b', label: 'Gaja Barbaresco 2015', count: 1 }]}
        rackedCount={1}
        onClose={() => {}}
        onDone={onDone}
      />,
    );

    expect(screen.getByText('bulk.deleteTitle:{"count":3}')).toBeTruthy();
    expect(screen.getByText('Azelia Barolo 2016')).toBeTruthy();
    expect(screen.getByText(`bulk.deleteIntro:{"days":${TRASH_DAYS}}`)).toBeTruthy();
    expect(screen.getByText('bulk.deleteRacked:{"count":1}')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull(); // below the type-to-confirm threshold

    const btn = deleteButton(3);
    expect(btn.className).toContain('btn-danger');
    fireEvent.click(btn);

    await waitFor(() => expect(bulkDeleteBottles).toHaveBeenCalledWith(apiFetch, ['b1', 'b2', 'b3']));
    expect(await screen.findByText(/^bulk\.deleteDoneInfo:\{"count":3,"date":/)).toBeTruthy();
    expect(screen.getByText('bulk.deleteWhere')).toBeTruthy();
  });

  test(`from ${TYPE_TO_CONFIRM_FROM} bottles the count must be typed before the button works`, async () => {
    const n = TYPE_TO_CONFIRM_FROM + 2;
    bulkDeleteBottles.mockResolvedValue({ ok: true, json: async () => ({ deleted: n, skipped: [], batchId: 'batch1', purgeAt: '2026-11-11T08:00:00.000Z' }) });
    render(<BulkDeleteModal bottleIds={ids(n)} cellarId="c1" onClose={() => {}} onDone={() => {}} />);

    const btn = deleteButton(n);
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(bulkDeleteBottles).not.toHaveBeenCalled();

    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: String(n - 1) } });
    expect(deleteButton(n).disabled).toBe(true);
    fireEvent.change(input, { target: { value: ` ${n} ` } });
    expect(deleteButton(n).disabled).toBe(false);

    fireEvent.click(deleteButton(n));
    await waitFor(() => expect(bulkDeleteBottles).toHaveBeenCalledTimes(1));
  });

  test('Undo brings the whole batch back', async () => {
    bulkDeleteBottles.mockResolvedValue({ ok: true, json: async () => ({ deleted: 2, skipped: [], batchId: 'batch1', purgeAt: '2026-11-11T08:00:00.000Z' }) });
    restoreRecentlyDeleted.mockResolvedValue({ ok: true, json: async () => ({ restored: 2, restoredIds: ['b1', 'b2'], skipped: [] }) });
    render(<BulkDeleteModal bottleIds={ids(2)} cellarId="c1" onClose={() => {}} onDone={() => {}} />);

    fireEvent.click(deleteButton(2));
    fireEvent.click(await screen.findByRole('button', { name: 'bulk.deleteUndo' }));

    await waitFor(() => expect(restoreRecentlyDeleted).toHaveBeenCalledWith(apiFetch, 'c1', { batchId: 'batch1' }));
    expect(await screen.findByText('trash.restoredInfo:{"count":2}')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'bulk.deleteUndo' })).toBeNull();
  });

  test('a refused delete shows the error and keeps the dialog', async () => {
    bulkDeleteBottles.mockResolvedValue({ ok: false, json: async () => ({ error: 'At most 500 bottles per request' }) });
    render(<BulkDeleteModal bottleIds={ids(2)} cellarId="c1" onClose={() => {}} onDone={() => {}} />);
    fireEvent.click(deleteButton(2));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText('At most 500 bottles per request')).toBeTruthy();
    expect(deleteButton(2)).toBeTruthy();
  });

  test('a long summary names the first wines and counts the rest', () => {
    const summary = Array.from({ length: 7 }, (_, i) => ({ key: `k${i}`, label: `Wine ${i}`, count: 1 }));
    render(<BulkDeleteModal bottleIds={ids(7)} cellarId="c1" summary={summary} onClose={() => {}} onDone={() => {}} />);
    expect(screen.getByText('Wine 4')).toBeTruthy();
    expect(screen.queryByText('Wine 5')).toBeNull();
    expect(screen.getByText('bulk.deleteMoreWines:{"count":2}')).toBeTruthy();
  });
});
