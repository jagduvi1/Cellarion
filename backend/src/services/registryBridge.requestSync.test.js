/**
 * Registry Bridge — forwarded wine requests come back answered.
 *
 * Pins: a forwarded request keeps the id the registry gave it; the hourly sync
 * asks only about pending ones that have such an id; an approved one copies
 * the wine and completes through the SAME service an admin resolve uses
 * (wineRequestOps), a declined one completes as declined with the registry's
 * reason, a still-pending one is only stamped as checked; a copy that fails
 * leaves the request pending for the next run; an unreachable registry
 * changes nothing; the bridge off is a no-op.
 */
jest.mock('../models/WineDefinition', () => ({ findOne: jest.fn(), find: jest.fn(), countDocuments: jest.fn(), updateOne: jest.fn() }));
jest.mock('../models/WineVintageProfile', () => ({}));
jest.mock('../models/RegistryDataKey', () => ({}));
jest.mock('../models/RegistryDataValue', () => ({}));
jest.mock('../models/SiteConfig', () => ({ findOne: jest.fn() }));
jest.mock('../models/WineRequest', () => ({ find: jest.fn(), updateOne: jest.fn().mockResolvedValue({}) }));
jest.mock('./registryBridgeClient', () => ({
  isEnabled: jest.fn(() => true),
  forwardRequest: jest.fn(),
  requestStatuses: jest.fn(),
}));
jest.mock('./wineRequestOps', () => ({
  completeRequestResolve: jest.fn().mockResolvedValue({ backfilledCount: 2 }),
  completeRequestReject: jest.fn().mockResolvedValue({ bottlesDetached: 0 }),
}));
jest.mock('./audit', () => ({ logAudit: jest.fn() }));

const WineRequest = require('../models/WineRequest');
const client = require('./registryBridgeClient');
const { completeRequestResolve, completeRequestReject } = require('./wineRequestOps');
const { logAudit } = require('./audit');
const bridge = require('./registryBridge');

const R1 = 'a'.repeat(24); const R2 = 'b'.repeat(24); const R3 = 'c'.repeat(24);
const W1 = 'f'.repeat(24);
const local = (id, remote) => ({ _id: `local-${id}`, user: 'u1', wineName: `Wine ${id}`, registryRequestId: remote, status: 'pending' });
const findChain = (rows) => ({ sort: () => ({ limit: () => Promise.resolve(rows) }) });

beforeEach(() => {
  jest.clearAllMocks();
  client.isEnabled.mockReturnValue(true);
});

describe('forwardAndTrackRequest', () => {
  test('keeps the id the registry gives the forwarded request', async () => {
    client.forwardRequest.mockResolvedValue({ ok: true, status: 201, body: { request: { id: R1, status: 'pending' } } });
    await bridge.forwardAndTrackRequest({ _id: 'local-1', wineName: 'X', sourceUrl: 'https://x.example', image: null });
    expect(WineRequest.updateOne).toHaveBeenCalledWith({ _id: 'local-1' }, { $set: { registryRequestId: R1 } });
  });

  test('a refused or unreachable forward stores nothing and never throws', async () => {
    client.forwardRequest.mockResolvedValue({ ok: false, status: 0, code: 'network' });
    await expect(bridge.forwardAndTrackRequest({ _id: 'local-1', wineName: 'X', sourceUrl: 'https://x.example' })).resolves.toBeTruthy();
    client.forwardRequest.mockRejectedValue(new Error('boom'));
    await expect(bridge.forwardAndTrackRequest({ _id: 'local-1', wineName: 'X', sourceUrl: 'https://x.example' })).resolves.toBeNull();
    expect(WineRequest.updateOne).not.toHaveBeenCalled();
  });
});

describe('syncForwardedRequests', () => {
  test('approved → wine copied and the request completed like an admin resolve; declined → reason passed on; pending → stamped', async () => {
    const rows = [local(1, R1), local(2, R2), local(3, R3)];
    WineRequest.find.mockReturnValue(findChain(rows));
    client.requestStatuses.mockResolvedValue([
      { id: R1, status: 'resolved', notes: 'Added as Domaine X — Y', wine: { id: W1, name: 'Y', producer: 'Domaine X' } },
      { id: R2, status: 'rejected', notes: 'Not a wine (a cider).' },
      { id: R3, status: 'pending' },
    ]);
    const adopted = { _id: 'localWine1', name: 'Y', producer: 'Domaine X' };
    const adopt = jest.fn().mockResolvedValue({ ok: true, wine: adopted });
    const now = new Date('2026-10-09T12:00:00Z');

    const out = await bridge.syncForwardedRequests({ now, adopt });

    // Only pending, forwarded (string id) new-wine requests are asked about.
    expect(WineRequest.find).toHaveBeenCalledWith({ status: 'pending', requestType: 'new_wine', registryRequestId: { $type: 'string' } });
    expect(client.requestStatuses).toHaveBeenCalledWith([R1, R2, R3]);
    expect(adopt).toHaveBeenCalledWith(W1, 'u1');
    expect(completeRequestResolve).toHaveBeenCalledWith(rows[0], adopted, { resolvedBy: null, adminNotes: 'Added as Domaine X — Y' });
    expect(completeRequestReject).toHaveBeenCalledWith(rows[1], { resolvedBy: null, adminNotes: 'Not a wine (a cider).' });
    expect(WineRequest.updateOne).toHaveBeenCalledWith({ _id: 'local-3' }, { $set: { registryCheckedAt: now } });
    expect(logAudit).toHaveBeenCalledWith(null, 'wineRequest.resolve', expect.objectContaining({ id: 'local-1' }), expect.objectContaining({ via: 'bridge' }));
    expect(out).toEqual({ checked: 3, resolved: 1, rejected: 1, failures: 0 });
  });

  test('a wine that cannot be copied leaves the request pending for the next run', async () => {
    WineRequest.find.mockReturnValue(findChain([local(1, R1)]));
    client.requestStatuses.mockResolvedValue([{ id: R1, status: 'resolved', wine: { id: W1 } }]);
    const out = await bridge.syncForwardedRequests({ adopt: jest.fn().mockResolvedValue({ ok: false, code: 'unavailable' }) });
    expect(completeRequestResolve).not.toHaveBeenCalled();
    expect(out.failures).toBe(1);
  });

  test('a decline without a note still tells the requester where it was decided', async () => {
    WineRequest.find.mockReturnValue(findChain([local(1, R1)]));
    client.requestStatuses.mockResolvedValue([{ id: R1, status: 'rejected', notes: null }]);
    await bridge.syncForwardedRequests({ adopt: jest.fn() });
    expect(completeRequestReject.mock.calls[0][1].adminNotes).toMatch(/shared registry/);
  });

  test('registry unreachable: nothing changes', async () => {
    WineRequest.find.mockReturnValue(findChain([local(1, R1)]));
    client.requestStatuses.mockResolvedValue(null);
    const out = await bridge.syncForwardedRequests({ adopt: jest.fn() });
    expect(out.failed).toBe(true);
    expect(completeRequestResolve).not.toHaveBeenCalled();
    expect(WineRequest.updateOne).not.toHaveBeenCalled();
  });

  test('bridge off: a no-op', async () => {
    client.isEnabled.mockReturnValue(false);
    expect(await bridge.syncForwardedRequests()).toEqual({ skipped: 'disabled' });
    expect(WineRequest.find).not.toHaveBeenCalled();
  });
});
