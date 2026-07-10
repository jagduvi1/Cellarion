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
jest.mock('./eventBus', () => ({ emit: jest.fn() }));

const eventBus = require('./eventBus');
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
