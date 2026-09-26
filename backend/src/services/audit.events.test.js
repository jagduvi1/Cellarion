/**
 * Audit → SSE nudge hook (docs/ha-push-events.md §1).
 *
 * WHY THIS TEST EXISTS:
 * logAudit doubles as the stats_changed emitter — every bottle./cellar. action
 * with a user actor must nudge that user's event streams, and NOTHING else may
 * (auth events, admin taxonomy work, system jobs). If the prefix filter drifts,
 * either Home Assistant stops updating (missed prefix) or every login pushes a
 * pointless refresh (over-broad prefix).
 */

jest.mock('../models/AuditLog', () => ({ create: jest.fn().mockResolvedValue({}) }));
jest.mock('./eventBus', () => ({ emit: jest.fn(), streamCounts: jest.fn(() => ({ total: 0, users: 0 })) }));
jest.mock('../models/Cellar', () => ({ findById: jest.fn() }));

const eventBus = require('./eventBus');
const Cellar = require('../models/Cellar');
const { logAudit } = require('./audit');
const { getDataVersion } = require('./dataVersion');

beforeEach(() => jest.clearAllMocks());

const reqFor = (userId) => ({ user: { id: userId, roles: ['user'] }, headers: {} });

describe('logAudit → eventBus.emit', () => {
  test.each([
    'bottle.add', 'bottle.update', 'bottle.consume', 'bottle.delete',
    'bottle.move.out', 'bottle.undo', 'bottle.import',
    'cellar.create', 'cellar.update', 'cellar.delete', 'cellar.import',
    'cellar.share.add',
  ])('%s emits stats_changed to the acting user', (action) => {
    logAudit(reqFor('u1'), action, { type: 'bottle' }, {});
    expect(eventBus.emit).toHaveBeenCalledWith('u1', 'stats_changed', { reason: action });
  });

  test.each([
    'auth.login.success', 'auth.change_password', 'user.profile.update',
    'wishlist.add', 'token.created', 'admin.wine.update', 'chat.query',
    'system.rate_limit_exceeded',
  ])('%s does NOT emit', (action) => {
    logAudit(reqFor('u1'), action, {}, {});
    expect(eventBus.emit).not.toHaveBeenCalled();
  });

  test('system-actor events (req = null) never emit, even for matching actions', () => {
    logAudit(null, 'cellar.retention_purge', {}, {});
    expect(eventBus.emit).not.toHaveBeenCalled();
  });
});

describe('shared-cellar owner nudge', () => {
  test('a member mutation also nudges the cellar OWNER (req.cellar fast path)', () => {
    const req = { ...reqFor('member1'), cellar: { user: 'owner1' } };
    logAudit(req, 'bottle.consume', { type: 'bottle', cellarId: 'c1' }, {});
    expect(eventBus.emit).toHaveBeenCalledWith('member1', 'stats_changed', { reason: 'bottle.consume' });
    expect(eventBus.emit).toHaveBeenCalledWith('owner1', 'stats_changed', { reason: 'bottle.consume' });
  });

  test('the owner acting in their own cellar is nudged exactly once', () => {
    const req = { ...reqFor('owner1'), cellar: { user: 'owner1' } };
    logAudit(req, 'bottle.add', { type: 'bottle', cellarId: 'c1' }, {});
    expect(eventBus.emit).toHaveBeenCalledTimes(1);
  });

  test('without req.cellar the owner is resolved from cellarId — even with no stream open', async () => {
    // The owner's read caches (data version, MCP caches) must move whether or
    // not anyone is connected; until 2026-09 this lookup ran only with streams.
    const cellarId = 'a'.repeat(24);
    Cellar.findById.mockReturnValue({ select: () => ({ lean: () => Promise.resolve({ user: 'owner1' }) }) });
    const before = getDataVersion('owner1');
    logAudit(reqFor('admin1'), 'cellar.restore', { type: 'cellar', cellarId }, {});
    await new Promise(r => setImmediate(r)); // let the fire-and-forget lookup settle
    expect(Cellar.findById).toHaveBeenCalledWith(cellarId);
    expect(eventBus.emit).toHaveBeenCalledWith('owner1', 'stats_changed', { reason: 'cellar.restore' });
    expect(getDataVersion('owner1')).not.toBe(before);
  });

  test('a cellarId that is not a plain 24-hex id never reaches the query', () => {
    eventBus.streamCounts.mockReturnValue({ total: 1, users: 1 });
    logAudit(reqFor('u1'), 'cellar.restore', { type: 'cellar', cellarId: { $ne: null } }, {});
    logAudit(reqFor('u1'), 'cellar.restore', { type: 'cellar', cellarId: 'not-an-objectid' }, {});
    expect(Cellar.findById).not.toHaveBeenCalled();
  });
});

describe('logAudit → data version (services/dataVersion, the REST read caches)', () => {
  test('a bottle./cellar. change moves the acting user\'s version', () => {
    const before = getDataVersion('dv-actor');
    logAudit(reqFor('dv-actor'), 'bottle.consume', { type: 'bottle' }, {});
    expect(getDataVersion('dv-actor')).not.toBe(before);
  });

  test('other actions and system events leave it alone', () => {
    const before = getDataVersion('dv-quiet');
    logAudit(reqFor('dv-quiet'), 'auth.login.success', {}, {});
    logAudit(reqFor('dv-quiet'), 'wishlist.add', {}, {});
    logAudit(null, 'cellar.retention_purge', {}, {});
    expect(getDataVersion('dv-quiet')).toBe(before);
  });

  test('a member\'s change moves the cellar owner\'s version too', () => {
    const member = getDataVersion('dv-member');
    const owner = getDataVersion('dv-owner');
    logAudit({ ...reqFor('dv-member'), cellar: { user: 'dv-owner' } }, 'bottle.update', { type: 'bottle', cellarId: 'c1' }, {});
    expect(getDataVersion('dv-member')).not.toBe(member);
    expect(getDataVersion('dv-owner')).not.toBe(owner);
  });
});
