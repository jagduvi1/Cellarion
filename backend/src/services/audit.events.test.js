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

  test('without req.cellar the owner is resolved from cellarId — but only when streams exist', async () => {
    const cellarId = 'a'.repeat(24);
    // No streams anywhere → no lookup at all
    logAudit(reqFor('member1'), 'cellar.restore', { type: 'cellar', cellarId }, {});
    expect(Cellar.findById).not.toHaveBeenCalled();

    // Streams exist → owner resolved and nudged
    eventBus.streamCounts.mockReturnValue({ total: 1, users: 1 });
    Cellar.findById.mockReturnValue({ select: () => ({ lean: () => Promise.resolve({ user: 'owner1' }) }) });
    logAudit(reqFor('admin1'), 'cellar.restore', { type: 'cellar', cellarId }, {});
    await new Promise(r => setImmediate(r)); // let the fire-and-forget lookup settle
    expect(eventBus.emit).toHaveBeenCalledWith('owner1', 'stats_changed', { reason: 'cellar.restore' });
  });

  test('a cellarId that is not a plain 24-hex id never reaches the query', () => {
    eventBus.streamCounts.mockReturnValue({ total: 1, users: 1 });
    logAudit(reqFor('u1'), 'cellar.restore', { type: 'cellar', cellarId: { $ne: null } }, {});
    logAudit(reqFor('u1'), 'cellar.restore', { type: 'cellar', cellarId: 'not-an-objectid' }, {});
    expect(Cellar.findById).not.toHaveBeenCalled();
  });
});
