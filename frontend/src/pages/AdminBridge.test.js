import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import AdminBridge from './AdminBridge';

/**
 * Admin → Registry Bridge.
 *
 * Pins the parse path (both payloads are Responses, both are checked), the
 * join the page shows (owner, install, spend, distinct wines, the readers
 * table with its over-alert rows), the revoked-keys fold, and the revoke
 * flow: a reason of at least three characters is required before the
 * confirm button does anything, the reason is what gets sent, and the page
 * reloads afterwards.
 */

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, opts) => {
      if (opts && opts.count !== undefined) return `${key}:${opts.count}`;
      if (opts && opts.name !== undefined) return `${key}:${opts.name}`;
      return key;
    },
  }),
}));

const apiFetch = vi.fn();
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ apiFetch }) }));

const getKeys = vi.fn();
const getReaders = vi.fn();
const revoke = vi.fn();
vi.mock('../api/admin', () => ({
  adminGetBridgeKeys: (...a) => getKeys(...a),
  adminGetBridgeReaders: (...a) => getReaders(...a),
  adminRevokeBridgeKey: (...a) => revoke(...a),
}));

const jsonRes = (body, ok = true) => ({ ok, json: () => Promise.resolve(body) });

const K1 = '64c000000000000000000001';
const K2 = '64c000000000000000000002';
const KEYS = {
  days: 7,
  today: '2026-09-08',
  caps: { searches: 600, fetches: 300, changeChecks: 1, contributions: 50 },
  alertDistinct: 1000,
  totals: { active: 1, revoked: 1, usedInPeriod: 1, searches: 40, fetches: 12, contributions: 1 },
  keys: [
    {
      id: K1, name: 'Home NAS', prefix: 'cbr_12345678', instanceHost: 'cellar.example.org',
      owner: { id: 'u1', username: 'nasowner', email: 'nas@example.org' },
      createdAt: '2026-09-01T00:00:00Z', lastUsedAt: '2026-09-08T10:00:00Z', termsVersion: '2026-09',
      importWindow: { active: false, until: null }, revokedAt: null, revokedBy: null, revokedReason: null,
      today: { searches: 5, fetches: 2, changeChecks: 0, contributions: 0, distinct: 2 },
      period: { searches: 40, fetches: 12, changeChecks: 2, contributions: 1, reads: 30, distinctMax: 12, activeDays: 3 },
    },
    {
      id: K2, name: 'Old box', prefix: 'cbr_87654321', instanceHost: null,
      owner: { id: 'u1', username: 'nasowner', email: 'nas@example.org' },
      createdAt: '2026-08-01T00:00:00Z', lastUsedAt: null, termsVersion: '2026-09',
      importWindow: { active: false, until: null }, revokedAt: '2026-09-07T00:00:00Z', revokedBy: 'johan', revokedReason: 'Read 4000 wines in a day',
      today: { searches: 0, fetches: 0, changeChecks: 0, contributions: 0, distinct: 0 },
      period: { searches: 0, fetches: 0, changeChecks: 0, contributions: 0, reads: 0, distinctMax: 0, activeDays: 0 },
    },
  ],
};
const READERS = {
  days: 7,
  today: '2026-09-08',
  thresholds: { anonymousDailyDistinct: 300, memberAlertDistinct: 1000 },
  readers: [
    { readerKey: 'ip:203.0.113.9', kind: 'ip', label: null, owner: null, keyId: null, revoked: false, reads: 900, distinctMax: 301, distinctSum: 301, distinctToday: 0, days: 1, blockedDays: 1, overAlert: true },
    { readerKey: `key:${K1}`, kind: 'key', label: 'Home NAS (cellar.example.org)', owner: 'nasowner', keyId: K1, revoked: false, reads: 30, distinctMax: 12, distinctSum: 20, distinctToday: 2, days: 3, blockedDays: 0, overAlert: false },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  getKeys.mockResolvedValue(jsonRes(KEYS));
  getReaders.mockResolvedValue(jsonRes(READERS));
  revoke.mockResolvedValue(jsonRes({ message: 'Bridge key revoked', id: K1 }));
});

test('renders keys with owner, install and spend, and the readers with the over-alert row', async () => {
  render(<AdminBridge />);
  expect(await screen.findByText('Home NAS')).toBeInTheDocument();
  expect(getKeys).toHaveBeenCalledWith(apiFetch, 7);
  expect(getReaders).toHaveBeenCalledWith(apiFetch, 7);

  // The owner shows in the keys table and again under the key's readers row.
  expect(screen.getAllByText('nasowner').length).toBeGreaterThanOrEqual(1);
  expect(screen.getByText('nas@example.org')).toBeInTheDocument();
  expect(screen.getByText(/· cellar\.example\.org/)).toBeInTheDocument();
  expect(screen.getByText('adminBridge.distinctMax:12')).toBeInTheDocument();
  expect(screen.getByText('adminBridge.statusActive')).toBeInTheDocument();

  // Readers: the address stays an address, the key is named, the flagged row is marked.
  expect(screen.getByText('ip:203.0.113.9')).toBeInTheDocument();
  expect(screen.getByText('Home NAS (cellar.example.org)')).toBeInTheDocument();
  expect(screen.getByText('adminBridge.overAlert')).toBeInTheDocument();
  expect(screen.getByText('ip:203.0.113.9').closest('tr')).toHaveClass('over-alert');
  expect(screen.getByText('Home NAS (cellar.example.org)').closest('tr')).not.toHaveClass('over-alert');

  // Stat cards carry the totals.
  expect(screen.getByText('adminBridge.activeKeys').previousSibling).toHaveTextContent('1');
  expect(screen.getByText('adminBridge.fetches').previousSibling).toHaveTextContent('12');
});

test('revoked keys are folded away until asked for, then show who and why', async () => {
  render(<AdminBridge />);
  await screen.findByText('Home NAS');
  expect(screen.queryByText('Old box')).toBeNull();
  fireEvent.click(screen.getByText('adminBridge.showRevoked:1'));
  expect(screen.getByText('Old box')).toBeInTheDocument();
  expect(screen.getByText('Read 4000 wines in a day')).toBeInTheDocument();
  expect(screen.getByText(/adminBridge.revokedBy:johan/)).toBeInTheDocument();
  expect(screen.getByText('adminBridge.statusRevoked')).toBeInTheDocument();
  // A revoked key has no revoke button; the active one does.
  expect(screen.getAllByText('adminBridge.revoke')).toHaveLength(1);
  fireEvent.click(screen.getByText('adminBridge.hideRevoked'));
  expect(screen.queryByText('Old box')).toBeNull();
});

test('revoking asks for a reason, sends it, and reloads', async () => {
  render(<AdminBridge />);
  await screen.findByText('Home NAS');
  fireEvent.click(screen.getByText('adminBridge.revoke'));
  expect(await screen.findByText('adminBridge.revokeTitle')).toBeInTheDocument();
  expect(screen.getByText('adminBridge.revokeConfirm:Home NAS')).toBeInTheDocument();

  const confirm = document.querySelector('.modal-actions .btn-danger');
  expect(confirm).toBeDisabled();
  fireEvent.change(screen.getByLabelText('adminBridge.reasonLabel'), { target: { value: 'no' } });
  expect(confirm).toBeDisabled();
  fireEvent.change(screen.getByLabelText('adminBridge.reasonLabel'), { target: { value: '  Read 4000 wines in a day  ' } });
  expect(confirm).not.toBeDisabled();

  await act(async () => { fireEvent.click(confirm); });
  await waitFor(() => expect(revoke).toHaveBeenCalledWith(apiFetch, K1, 'Read 4000 wines in a day'));
  await waitFor(() => expect(getKeys).toHaveBeenCalledTimes(2));
  expect(screen.queryByText('adminBridge.revokeTitle')).toBeNull();
});

test('a refused revocation is shown in the dialog and nothing reloads', async () => {
  revoke.mockResolvedValue(jsonRes({ error: 'This key is already revoked', code: 'already_revoked' }, false));
  render(<AdminBridge />);
  await screen.findByText('Home NAS');
  fireEvent.click(screen.getByText('adminBridge.revoke'));
  fireEvent.change(await screen.findByLabelText('adminBridge.reasonLabel'), { target: { value: 'because' } });
  await act(async () => { fireEvent.click(document.querySelector('.modal-actions .btn-danger')); });
  expect(await screen.findByText('This key is already revoked')).toBeInTheDocument();
  expect(screen.getByText('adminBridge.revokeTitle')).toBeInTheDocument();
  expect(getKeys).toHaveBeenCalledTimes(1);
});

test('a failed load is reported instead of crashing on an empty payload', async () => {
  getKeys.mockResolvedValue(jsonRes({ error: 'Failed to load bridge keys' }, false));
  render(<AdminBridge />);
  expect(await screen.findByText('Failed to load bridge keys')).toBeInTheDocument();
  expect(screen.queryByText('adminBridge.keysTitle')).toBeNull();
});

test('changing the window refetches both tables with it', async () => {
  render(<AdminBridge />);
  await screen.findByText('Home NAS');
  fireEvent.click(screen.getByText('adminBridge.lastNDays:30'));
  await waitFor(() => expect(getKeys).toHaveBeenLastCalledWith(apiFetch, 30));
  expect(getReaders).toHaveBeenLastCalledWith(apiFetch, 30);
});
