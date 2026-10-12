import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../api/bottles', () => ({
  getRecentlyDeleted: vi.fn(),
  restoreRecentlyDeleted: vi.fn(),
}));

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

const { getRecentlyDeleted, restoreRecentlyDeleted } = await import('../api/bottles');
const RecentlyDeletedModal = (await import('./RecentlyDeletedModal')).default;

const inDays = (d) => new Date(Date.now() + d * 86400000).toISOString();
const row = (id, batchId, name, extra = {}) => ({
  id, batchId, deletedAt: '2026-10-12T08:00:00.000Z', purgeAt: inDays(29.5),
  label: { name, producer: 'Azelia', vintage: '2016', bottleSize: '750ml', status: 'active', ...extra },
});
const listResponse = (items) => ({ ok: true, json: async () => ({ items, retentionDays: 30 }) });

beforeEach(() => vi.clearAllMocks());

describe('RecentlyDeletedModal', () => {
  test('groups bottles by the delete they came from, with the days left', async () => {
    getRecentlyDeleted.mockResolvedValue(listResponse([
      row('t1', 'batchA', 'Barolo'),
      row('t2', 'batchA', 'Barolo Bricco Fiasco', { bottleSize: '1500ml' }),
      row('t3', 'batchB', 'Barbaresco'),
    ]));
    render(<RecentlyDeletedModal cellarId="c1" onClose={() => {}} />);

    expect(await screen.findByText('Azelia Barolo 2016')).toBeTruthy(); // 750ml is not repeated
    expect(screen.getByText('Azelia Barolo Bricco Fiasco 2016 1500ml')).toBeTruthy();
    expect(getRecentlyDeleted).toHaveBeenCalledWith(apiFetch, 'c1');
    expect(screen.getAllByText('trash.daysLeft:{"count":30}')).toHaveLength(2);
    // "Restore all" only where a delete holds more than one bottle.
    expect(screen.getAllByRole('button', { name: /^trash\.restoreAll/ })).toHaveLength(1);
  });

  test('Restore all brings a batch back, reloads, and tells the page on close', async () => {
    getRecentlyDeleted
      .mockResolvedValueOnce(listResponse([row('t1', 'batchA', 'Barolo'), row('t2', 'batchA', 'Barolo')]))
      .mockResolvedValueOnce(listResponse([]));
    restoreRecentlyDeleted.mockResolvedValue({ ok: true, json: async () => ({ restored: 2, restoredIds: ['b1', 'b2'], skipped: [] }) });
    const onClose = vi.fn();
    render(<RecentlyDeletedModal cellarId="c1" onClose={onClose} />);

    fireEvent.click(await screen.findByRole('button', { name: 'trash.restoreAll:{"count":2}' }));
    await waitFor(() => expect(restoreRecentlyDeleted).toHaveBeenCalledWith(apiFetch, 'c1', { ids: undefined, batchId: 'batchA' }));
    expect(await screen.findByText('trash.restoredInfo:{"count":2}')).toBeTruthy();
    expect(await screen.findByText('trash.empty')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'bulk.close' }));
    expect(onClose).toHaveBeenCalledWith(true);
  });

  test('one bottle restores on its own; a bottle that cannot come back says why', async () => {
    getRecentlyDeleted.mockResolvedValue(listResponse([row('t1', 'batchA', 'Barolo')]));
    restoreRecentlyDeleted.mockResolvedValue({ ok: true, json: async () => ({ restored: 0, restoredIds: [], skipped: [{ id: 't1', reason: 'wine_gone' }] }) });
    const onClose = vi.fn();
    render(<RecentlyDeletedModal cellarId="c1" onClose={onClose} />);

    // Each Restore button names its wine for screen readers.
    fireEvent.click(await screen.findByRole('button', { name: 'trash.restoreAria:{"name":"Azelia Barolo 2016"}' }));
    await waitFor(() => expect(restoreRecentlyDeleted).toHaveBeenCalledWith(apiFetch, 'c1', { ids: ['t1'], batchId: undefined }));
    expect(await screen.findByText('trash.skippedWineGone:{"count":1}')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'bulk.close' }));
    expect(onClose).toHaveBeenCalledWith(false); // nothing came back: no refresh needed
  });

  test('a long batch shows the first rows and the rest on request', async () => {
    getRecentlyDeleted.mockResolvedValue(listResponse(Array.from({ length: 11 }, (_, i) => row(`t${i}`, 'batchA', `Wine ${i}`))));
    render(<RecentlyDeletedModal cellarId="c1" onClose={() => {}} />);
    expect(await screen.findByText('Azelia Wine 7 2016')).toBeTruthy();
    expect(screen.queryByText('Azelia Wine 8 2016')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'trash.showAll:{"count":11}' }));
    expect(screen.getByText('Azelia Wine 10 2016')).toBeTruthy();
  });

  test('an empty trash says so', async () => {
    getRecentlyDeleted.mockResolvedValue(listResponse([]));
    render(<RecentlyDeletedModal cellarId="c1" onClose={() => {}} />);
    expect(await screen.findByText('trash.empty')).toBeTruthy();
  });
});
