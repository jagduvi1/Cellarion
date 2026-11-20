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

  // The offline copy holds the racks, and its 304 check reads this version
  // (routes/offline): a placement it can't see would keep a device's rack
  // view stale. Racks don't change statistics, so no stats_changed push; they
  // send racks_changed, to the actor and to the cellar's owner.
  test.each(['rack.slot_assign', 'rack.slot_move', 'rack.slot_clear', 'rack.create', 'rack.delete'])(
    '%s moves the version of the actor and the cellar owner and sends racks_changed, never a stats push',
    async (action) => {
      const cellarId = 'b'.repeat(24);
      // Ids of their own per action: a user who just heard of a rack change is not told again at once.
      const member = `dv-rack-member-${action}`;
      const ownerId = `dv-rack-owner-${action}`;
      Cellar.findById.mockReturnValue({ select: () => ({ lean: () => Promise.resolve({ user: ownerId }) }) });
      const actor = getDataVersion(member);
      const owner = getDataVersion(ownerId);
      logAudit(reqFor(member), action, { type: 'rack', id: 'r1', cellarId }, {});
      await new Promise(r => setImmediate(r)); // the owner lookup is fire-and-forget
      expect(getDataVersion(member)).not.toBe(actor);
      expect(getDataVersion(ownerId)).not.toBe(owner);
      expect(eventBus.emit).not.toHaveBeenCalledWith(expect.anything(), 'stats_changed', expect.anything());
      expect(eventBus.emit).toHaveBeenCalledWith(member, 'racks_changed', { reason: action });
      expect(eventBus.emit).toHaveBeenCalledWith(ownerId, 'racks_changed', { reason: action });
    },
  );
});

describe('racks_changed during a racking session', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());
  const sent = (userId) => eventBus.emit.mock.calls.filter(([u, e]) => u === userId && e === 'racks_changed');

  test('the first change is told at once, the rest at most once per quiet window, and the last one always', () => {
    const user = 'rack-session';
    for (let i = 0; i < 40; i++) logAudit(reqFor(user), 'rack.slot_assign', { type: 'rack' }, {});
    logAudit(reqFor(user), 'rack.slot_clear', { type: 'rack' }, {});
    expect(sent(user)).toHaveLength(1);

    jest.advanceTimersByTime(30000);
    expect(sent(user)).toHaveLength(2);
    expect(sent(user)[1][2]).toEqual({ reason: 'rack.slot_clear' });

    // Nothing more happened: silence, and no timer left behind.
    jest.advanceTimersByTime(30000);
    expect(sent(user)).toHaveLength(2);
    expect(jest.getTimerCount()).toBe(0);

    // A change after the quiet window is told at once again.
    logAudit(reqFor(user), 'rack.slot_move', { type: 'rack' }, {});
    expect(sent(user)).toHaveLength(3);
  });

  test('one member in a session does not delay the first change of another', () => {
    logAudit(reqFor('rack-a'), 'rack.slot_assign', { type: 'rack' }, {});
    logAudit(reqFor('rack-b'), 'rack.slot_assign', { type: 'rack' }, {});
    expect(sent('rack-a')).toHaveLength(1);
    expect(sent('rack-b')).toHaveLength(1);
  });
});

describe('who made the change', () => {
  const AuditLog = require('../models/AuditLog');

  test('a request that came with an API token is stamped on the row; a signed-in session is not', () => {
    const tokenId = 'a'.repeat(24);
    logAudit({ ...reqFor('u1'), apiToken: { id: tokenId, scopes: ['write'] } }, 'bottle.move.out', { type: 'bottle' }, {});
    expect(AuditLog.create.mock.calls[0][0].actor).toMatchObject({ userId: 'u1', tokenId });

    logAudit(reqFor('u1'), 'bottle.move.out', { type: 'bottle' }, {});
    expect(AuditLog.create.mock.calls[1][0].actor).not.toHaveProperty('tokenId');
  });

  test('a token id that is not a well-formed id is left off, so the row is still written', () => {
    for (const id of ['not-an-object-id', '', 12345, { $ne: null }]) {
      AuditLog.create.mockClear();
      logAudit({ ...reqFor('u1'), apiToken: { id, scopes: ['write'] } }, 'bottle.move.out', { type: 'bottle' }, {});
      expect(AuditLog.create).toHaveBeenCalledTimes(1);
      expect(AuditLog.create.mock.calls[0][0].actor).not.toHaveProperty('tokenId');
    }
  });
});
