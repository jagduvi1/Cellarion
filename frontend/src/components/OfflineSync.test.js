import { render, act } from '@testing-library/react';
import OfflineSync, { changesOfflineCopy } from './OfflineSync';

// The device's offline copy used to be rebuilt 4 s after ANY write, marking a
// notification read included (scaling audit 2026-09-25, item 11). Only writes
// that change what the copy holds (cellars, bottles, racks, photos) refresh it
// now, and a write the event doesn't name (the offline queue's own sends)
// still counts as a change.

const refreshSnapshot = vi.fn(async () => true);
vi.mock('../utils/offlineSnapshot', () => ({
  getOfflineStatus: () => ({ savedAt: new Date().toISOString() }), // fresh: no refresh on start
  primeOfflineStatus: vi.fn(async () => {}),
  refreshSnapshot: (...args) => refreshSnapshot(...args),
}));
vi.mock('../utils/offlineQueue', () => ({
  flushQueue: vi.fn(async () => 0),
  getQueueStatus: () => ({ pending: 0 }),
  refreshQueueStatus: vi.fn(async () => {}),
  QUEUE_CHANGED_EVENT: 'cellarion-queue-changed',
}));
vi.mock('../utils/offlineMode', () => ({
  isOfflineModeEnabled: () => true,
  OFFLINE_MODE_EVENT: 'cellarion-offline-mode',
}));
vi.mock('../contexts/AuthContext', () => ({
  API_MUTATION_EVENT: 'cellarion-api-mutation',
  useAuth: () => ({
    user: { id: 'u1' }, token: 't', offlineSession: false,
    apiFetch: vi.fn(), getSessionGeneration: () => 1,
  }),
}));

describe('changesOfflineCopy', () => {
  test.each([
    '/api/bottles', '/api/bottles/b1/consume', '/api/cellars/c1', '/api/cellars',
    '/api/racks/r1/slots/3', '/api/images/upload', 'https://cellarion.app/api/bottles/b1',
    '/api/bottles/b1?x=1',
  ])('%s changes the copy', (url) => expect(changesOfflineCopy(url)).toBe(true));

  test.each([
    '/api/notifications/n1/read', '/api/notifications/read-all', '/api/users/preferences',
    '/api/support', '/api/discussions/d1/replies', '/api/journal', '/api/bottles-archive',
  ])('%s does not', (url) => expect(changesOfflineCopy(url)).toBe(false));

  test('a write the event does not name counts as a change', () => {
    expect(changesOfflineCopy(undefined)).toBe(true);
    expect(changesOfflineCopy('')).toBe(true);
  });
});

describe('refreshing after a write', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    refreshSnapshot.mockClear();
  });
  afterEach(() => vi.useRealTimers());

  const write = (url) => window.dispatchEvent(new CustomEvent('cellarion-api-mutation', { detail: { url } }));
  const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(5000); });

  test('marking a notification read leaves the copy alone', async () => {
    render(<OfflineSync />);
    await settle();
    write('/api/notifications/n1/read');
    await settle();
    expect(refreshSnapshot).not.toHaveBeenCalled();
  });

  test('a bottle change refreshes it once, a few seconds later', async () => {
    render(<OfflineSync />);
    await settle();
    write('/api/bottles/b1/consume');
    write('/api/racks/r1/slots/2');
    await settle();
    expect(refreshSnapshot).toHaveBeenCalledTimes(1);
  });

  test("the offline queue's own sends (an unnamed event) still refresh it", async () => {
    render(<OfflineSync />);
    await settle();
    window.dispatchEvent(new Event('cellarion-api-mutation'));
    await settle();
    expect(refreshSnapshot).toHaveBeenCalledTimes(1);
  });
});
