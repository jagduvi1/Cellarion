/**
 * services/apiDeprecationNotices: the owner of a token that still calls a
 * deprecated route is told, once on its first such call and again before the
 * sunset, and never twice: every notice is claimed on the token before it
 * goes. These pin the decisions (what is written when, who is told, what the
 * notice says); apiDeprecationNotices.mongo.test.js runs the claims against a
 * real MongoDB.
 */
jest.mock('../models/ApiToken', () => ({
  db: { readyState: 1 },
  updateOne: jest.fn(),
  updateMany: jest.fn(),
  find: jest.fn(),
  findOne: jest.fn(),
  findOneAndUpdate: jest.fn(),
}));
jest.mock('../models/User', () => ({ findById: jest.fn(), find: jest.fn() }));
jest.mock('./notifications', () => ({ createNotification: jest.fn(async () => [{}]) }));
jest.mock('./mailgun', () => ({ sendApiDeprecationEmail: jest.fn(async () => {}), EMAIL_VERIFICATION_ENABLED: true }));
jest.mock('./audit', () => ({ logAudit: jest.fn() }));

const ApiToken = require('../models/ApiToken');
const User = require('../models/User');
const { createNotification } = require('./notifications');
const { sendApiDeprecationEmail } = require('./mailgun');
const { logAudit } = require('./audit');
const { SUNSET } = require('../config/apiDeprecations');
const {
  markTokenDeprecatedUse,
  runDeprecationReminders,
  deprecatedUseView,
  dueReminder,
  REMINDER_DAYS,
} = require('./apiDeprecationNotices');

const DAY = 24 * 60 * 60 * 1000;
const MIN = 60 * 1000;
// Well before either reminder.
const NOW = new Date(SUNSET.getTime() - 200 * DAY);
const ROUTE = 'GET /api/cellars/:id';
const OID = '66f0a1b2c3d4e5f6a7b8c902';

/** A Mongoose query: chainable, resolving to `result`. */
const query = (result) => {
  const q = { select: () => q, limit: () => q, sort: () => q, lean: () => Promise.resolve(result) };
  return q;
};
const req = (baseUrl = '/api/cellars', path = '/:id') => ({ method: 'GET', baseUrl, route: { path }, path: `/${OID}` });
const ok = { statusCode: 200 };
const owner = (over = {}) => ({ _id: 'u1', email: 'anna@example.com', emailVerified: true, username: 'anna', ...over });
const marked = (over = {}) => ({ sunset: SUNSET, firstAt: NOW, lastAt: NOW, routes: [ROUTE], notifiedAt: NOW, ...over });

beforeEach(() => {
  jest.clearAllMocks();
  ApiToken.updateOne.mockResolvedValue({ matchedCount: 1 });
  ApiToken.updateMany.mockResolvedValue({ modifiedCount: 0 });
  User.findById.mockReturnValue(query(owner()));
  // notifyFirstUse reads the token's owner before it claims the notice.
  ApiToken.findOne.mockReturnValue(query({ _id: 'tok1', user: 'u1' }));
});

describe('markTokenDeprecatedUse', () => {
  test('the owner is read before the notice is claimed: a failed read leaves it for the next call', async () => {
    ApiToken.findOneAndUpdate.mockReturnValue(query({ _id: 'tok1', user: 'u1', name: 'Home Assistant', deprecatedUse: marked() }));
    User.findById.mockImplementation(() => { throw new Error('primary stepped down'); });
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    await markTokenDeprecatedUse({ _id: 'tok1', user: 'u1', origin: 'personal' }, req(), ok, NOW);
    expect(ApiToken.findOneAndUpdate).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
    err.mockRestore();
  });

  test('the first answered call marks the token under the route Express matched, and its owner is told once', async () => {
    const token = { _id: 'tok1', user: 'u1', name: 'Home Assistant', origin: 'personal' };
    ApiToken.findOneAndUpdate.mockReturnValue(query({ _id: 'tok1', user: 'u1', name: 'Home Assistant', deprecatedUse: marked() }));

    await markTokenDeprecatedUse(token, req(), ok, NOW);

    expect(ApiToken.updateOne).toHaveBeenCalledTimes(1);
    const [filter, update] = ApiToken.updateOne.mock.calls[0];
    expect(filter).toEqual({ _id: 'tok1', revokedAt: null, origin: { $ne: 'oauth' }, 'deprecatedUse.sunset': { $ne: SUNSET } });
    expect(update).toEqual({ $set: { deprecatedUse: { sunset: SUNSET, firstAt: NOW, lastAt: NOW, routes: [ROUTE] } } });
    // The key is the declared route, never the requested path.
    expect(JSON.stringify(ApiToken.updateOne.mock.calls)).not.toContain(OID);

    // The claim: only an active personal token whose notice has not gone out.
    const [claim, stamp] = ApiToken.findOneAndUpdate.mock.calls[0];
    expect(claim).toEqual({ _id: 'tok1', revokedAt: null, origin: { $ne: 'oauth' }, 'deprecatedUse.sunset': SUNSET, 'deprecatedUse.notifiedAt': null });
    expect(stamp).toEqual({ $set: { 'deprecatedUse.notifiedAt': NOW } });

    expect(createNotification).toHaveBeenCalledTimes(1);
    const [userId, type, title, message, link] = createNotification.mock.calls[0];
    expect([userId, type, link]).toEqual(['u1', 'api_deprecation', '/settings#api-tokens']);
    expect(title).toContain('"Home Assistant"');
    expect(message).toContain(ROUTE);
    expect(message).toContain('1 May 2027');
    expect(message).toContain('GET /api/inventory');

    expect(sendApiDeprecationEmail).toHaveBeenCalledWith('anna@example.com', 'anna', expect.objectContaining({
      tokenName: 'Home Assistant', routes: [ROUTE], sunset: SUNSET, reminderDays: REMINDER_DAYS,
    }));
    expect(sendApiDeprecationEmail.mock.calls[0][2].daysLeft).toBeUndefined();
    expect(logAudit).toHaveBeenCalledWith(null, 'token.deprecation_notice', { type: 'user', id: 'u1' },
      { tokenId: 'tok1', notice: 'first', routes: [ROUTE], emailed: true });
  });

  test('a polling token: a known route is written at most once an hour, a new one at once, and no second notice', async () => {
    const token = (lastAt) => ({ _id: 'tok1', user: 'u1', name: 'HA', deprecatedUse: marked({ lastAt }) });

    await markTokenDeprecatedUse(token(new Date(NOW.getTime() - 10 * MIN)), req(), ok, NOW);
    expect(ApiToken.updateOne).not.toHaveBeenCalled();

    await markTokenDeprecatedUse(token(new Date(NOW.getTime() - 61 * MIN)), req(), ok, NOW);
    expect(ApiToken.updateOne).toHaveBeenCalledTimes(1);
    expect(ApiToken.updateOne.mock.calls[0]).toEqual([
      { _id: 'tok1', revokedAt: null, origin: { $ne: 'oauth' }, 'deprecatedUse.sunset': SUNSET },
      { $set: { 'deprecatedUse.lastAt': NOW }, $addToSet: { 'deprecatedUse.routes': ROUTE } },
    ]);

    ApiToken.updateOne.mockClear();
    await markTokenDeprecatedUse(token(new Date(NOW.getTime() - 10 * MIN)), req('/api/stats', '/value-history'), ok, NOW);
    expect(ApiToken.updateOne).toHaveBeenCalledTimes(1);
    expect(ApiToken.updateOne.mock.calls[0][1].$addToSet).toEqual({ 'deprecatedUse.routes': 'GET /api/stats/value-history' });

    // Notified already: never claimed again, nothing sent.
    expect(ApiToken.findOneAndUpdate).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
    expect(sendApiDeprecationEmail).not.toHaveBeenCalled();
  });

  test('two first calls at once: the second adds its route to the record, and only the claim that wins sends', async () => {
    ApiToken.updateOne.mockResolvedValueOnce({ matchedCount: 0 }).mockResolvedValueOnce({ matchedCount: 1 });
    ApiToken.findOneAndUpdate.mockReturnValue(query(null)); // the other request claimed it

    await markTokenDeprecatedUse({ _id: 'tok1', user: 'u1', name: 'HA' }, req('/api/stats', '/value-history'), ok, NOW);

    expect(ApiToken.updateOne).toHaveBeenCalledTimes(2);
    expect(ApiToken.updateOne.mock.calls[1][0]['deprecatedUse.sunset']).toBe(SUNSET);
    expect(ApiToken.updateOne.mock.calls[1][1].$addToSet).toEqual({ 'deprecatedUse.routes': 'GET /api/stats/value-history' });
    expect(ApiToken.findOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(createNotification).not.toHaveBeenCalled();
    expect(sendApiDeprecationEmail).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  test('an OAuth token, a failed answer, an unmatched path and anything from the sunset on are never marked', async () => {
    const token = { _id: 'tok1', user: 'u1', name: 'HA' };
    await markTokenDeprecatedUse({ ...token, origin: 'oauth' }, req(), ok, NOW);
    await markTokenDeprecatedUse(token, req(), { statusCode: 404 }, NOW);
    await markTokenDeprecatedUse(token, { method: 'GET', baseUrl: '/api/cellars', path: '/made-up' }, ok, NOW);
    await markTokenDeprecatedUse(token, req(), ok, SUNSET);
    expect(ApiToken.updateOne).not.toHaveBeenCalled();
    expect(ApiToken.findOneAndUpdate).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
  });

  test('a token revoked meanwhile: every write and the claim require it active, so nothing is sent', async () => {
    ApiToken.updateOne.mockResolvedValue({ matchedCount: 0 });
    ApiToken.findOneAndUpdate.mockReturnValue(query(null));
    await markTokenDeprecatedUse({ _id: 'tok1', user: 'u1', name: 'HA' }, req(), ok, NOW);
    for (const [filter] of ApiToken.updateOne.mock.calls) expect(filter.revokedAt).toBeNull();
    expect(ApiToken.findOneAndUpdate.mock.calls[0][0].revokedAt).toBeNull();
    expect(createNotification).not.toHaveBeenCalled();
    expect(sendApiDeprecationEmail).not.toHaveBeenCalled();
  });

  test('a record from an earlier sunset starts over, and its owner is told about this one', async () => {
    const old = { sunset: new Date('2026-01-01T00:00:00Z'), routes: ['GET /api/old'], lastAt: NOW, notifiedAt: new Date('2025-10-01T00:00:00Z'), reminders: [{ daysBefore: 30, at: new Date('2025-12-02T00:00:00Z') }] };
    ApiToken.findOneAndUpdate.mockReturnValue(query({ _id: 'tok1', user: 'u1', name: 'HA', deprecatedUse: marked() }));

    await markTokenDeprecatedUse({ _id: 'tok1', user: 'u1', name: 'HA', deprecatedUse: old }, req(), ok, NOW);

    expect(ApiToken.updateOne.mock.calls[0][1]).toEqual({ $set: { deprecatedUse: { sunset: SUNSET, firstAt: NOW, lastAt: NOW, routes: [ROUTE] } } });
    expect(ApiToken.findOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(createNotification).toHaveBeenCalledTimes(1);
  });

  test('the email respects an opt-out of all email and needs a verified address; the bell tells everyone', async () => {
    ApiToken.findOneAndUpdate.mockReturnValue(query({ _id: 'tok1', user: 'u1', name: 'HA', deprecatedUse: marked() }));

    User.findById.mockReturnValue(query(owner({ emailOptOutAt: new Date() })));
    await markTokenDeprecatedUse({ _id: 'tok1', user: 'u1', name: 'HA' }, req(), ok, NOW);
    expect(sendApiDeprecationEmail).not.toHaveBeenCalled();
    expect(createNotification).toHaveBeenCalledTimes(1);

    jest.clearAllMocks();
    ApiToken.updateOne.mockResolvedValue({ matchedCount: 1 });
    ApiToken.findOneAndUpdate.mockReturnValue(query({ _id: 'tok1', user: 'u1', name: 'HA', deprecatedUse: marked() }));
    User.findById.mockReturnValue(query(owner()));
    await markTokenDeprecatedUse({ _id: 'tok1', user: 'u1', name: 'HA' }, req(), ok, NOW);
    expect(sendApiDeprecationEmail).toHaveBeenCalledTimes(1);
    expect(sendApiDeprecationEmail.mock.calls[0][2].recipientId).toBe('u1');

    jest.clearAllMocks();
    ApiToken.updateOne.mockResolvedValue({ matchedCount: 1 });
    ApiToken.findOneAndUpdate.mockReturnValue(query({ _id: 'tok1', user: 'u1', name: 'HA', deprecatedUse: marked() }));
    User.findById.mockReturnValue(query(owner({ emailVerified: false })));
    await markTokenDeprecatedUse({ _id: 'tok1', user: 'u1', name: 'HA' }, req(), ok, NOW);
    expect(sendApiDeprecationEmail).not.toHaveBeenCalled();
    expect(createNotification).toHaveBeenCalledTimes(1); // the bell still has it
    expect(logAudit.mock.calls[0][3].emailed).toBe(false);
  });

  test('a failing email costs only the email: the notice stays in the app, nothing throws', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    ApiToken.findOneAndUpdate.mockReturnValue(query({ _id: 'tok1', user: 'u1', name: 'HA', deprecatedUse: marked() }));
    sendApiDeprecationEmail.mockRejectedValueOnce(new Error('mailgun down'));

    await expect(markTokenDeprecatedUse({ _id: 'tok1', user: 'u1', name: 'HA' }, req(), ok, NOW)).resolves.toBeUndefined();
    expect(createNotification).toHaveBeenCalledTimes(1);
    expect(logAudit.mock.calls[0][3]).toMatchObject({ notice: 'first', emailed: false });
    console.error.mockRestore();
  });

  test('an account pending deletion is not told', async () => {
    ApiToken.findOneAndUpdate.mockReturnValue(query({ _id: 'tok1', user: 'u1', name: 'HA', deprecatedUse: marked() }));
    User.findById.mockReturnValue(query(owner({ deletionScheduledFor: new Date() })));
    await markTokenDeprecatedUse({ _id: 'tok1', user: 'u1', name: 'HA' }, req(), ok, NOW);
    expect(createNotification).not.toHaveBeenCalled();
    expect(sendApiDeprecationEmail).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  test('a database error is logged, never thrown into the answered request', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    ApiToken.updateOne.mockRejectedValueOnce(new Error('connection reset'));
    await expect(markTokenDeprecatedUse({ _id: 'tok1', user: 'u1', name: 'HA' }, req(), ok, NOW)).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalled();
    console.error.mockRestore();
  });
});

describe('runDeprecationReminders', () => {
  const before = (days, extraMs = 60 * MIN) => new Date(SUNSET.getTime() - days * DAY + extraMs);

  test('the reminder due is the latest of REMINDER_DAYS whose day has come', () => {
    expect(REMINDER_DAYS).toEqual([90, 30]);
    expect(dueReminder(before(91))).toBeNull();
    expect(dueReminder(before(90, 0)).days).toBe(90);
    expect(dueReminder(before(31)).days).toBe(90);
    expect(dueReminder(before(30, 0)).days).toBe(30);
    expect(dueReminder(before(1)).days).toBe(30);
  });

  test('more than 90 days out nothing is due, and nothing is read', async () => {
    const r = await runDeprecationReminders(before(120));
    expect(r).toMatchObject({ due: null, sent: 0 });
    expect(ApiToken.find).not.toHaveBeenCalled();
  });

  test('from the sunset on nothing is sent; the daily run only clears the markers', async () => {
    ApiToken.updateMany.mockResolvedValue({ modifiedCount: 3 });
    for (const now of [SUNSET, new Date(SUNSET.getTime() + 5 * DAY)]) {
      const r = await runDeprecationReminders(now);
      expect(r).toEqual({ cleared: 3, due: null, sent: 0, emailed: 0 });
    }
    expect(ApiToken.updateMany).toHaveBeenCalledWith({ 'deprecatedUse.sunset': { $lte: SUNSET } }, { $unset: { deprecatedUse: 1 } });
    expect(ApiToken.find).not.toHaveBeenCalled();
    expect(ApiToken.findOneAndUpdate).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
  });

  test('90 days out: tokens still in use are claimed, then their owners told; a lost claim sends nothing', async () => {
    const now = before(90);
    ApiToken.find.mockReturnValue(query([{ _id: 't1', user: 'u1' }, { _id: 't2', user: 'u2' }, { _id: 't3', user: 'u3' }]));
    User.find.mockReturnValue(query([
      owner({ _id: 'u1' }),
      owner({ _id: 'u2', deletionScheduledFor: new Date() }),
      owner({ _id: 'u3', email: 'carl@example.com', username: 'carl' }),
    ]));
    ApiToken.findOneAndUpdate.mockImplementation((filter) => query(filter._id === 't1'
      ? { _id: 't1', user: 'u1', name: 'HA', deprecatedUse: marked({ lastAt: new Date(now.getTime() - 2 * DAY) }) }
      : null)); // t3: another run (another process) sent it

    const r = await runDeprecationReminders(now);

    expect(r).toEqual({ cleared: 0, due: 90, sent: 1, emailed: 1 });
    // Who is a candidate: active personal tokens of this sunset, used in the
    // last 30 days, first told before this reminder's day and outside the
    // gap, without this reminder yet and no other notice within the gap.
    const [filter] = ApiToken.find.mock.calls[0];
    expect(filter).toMatchObject({
      revokedAt: null,
      origin: { $ne: 'oauth' },
      'deprecatedUse.sunset': SUNSET,
      'deprecatedUse.lastAt': { $gte: new Date(now.getTime() - 30 * DAY) },
      'deprecatedUse.reminders.daysBefore': { $ne: 90 },
      'deprecatedUse.reminders.at': { $not: { $gt: new Date(now.getTime() - 7 * DAY) } },
    });
    expect(filter['deprecatedUse.notifiedAt'].$lt.getTime())
      .toBe(Math.min(SUNSET.getTime() - 90 * DAY, now.getTime() - 7 * DAY));

    // u2 is pending deletion: not even claimed, so a cancelled deletion keeps it.
    expect(ApiToken.findOneAndUpdate.mock.calls.map(([f]) => f._id)).toEqual(['t1', 't3']);
    expect(ApiToken.findOneAndUpdate.mock.calls[0]).toEqual([
      { _id: 't1', revokedAt: null, origin: { $ne: 'oauth' }, 'deprecatedUse.sunset': SUNSET, 'deprecatedUse.reminders.daysBefore': { $ne: 90 } },
      { $push: { 'deprecatedUse.reminders': { daysBefore: 90, at: now } } },
      { new: true },
    ]);

    expect(createNotification).toHaveBeenCalledTimes(1);
    expect(createNotification.mock.calls[0][2]).toMatch(/^Reminder: /);
    expect(createNotification.mock.calls[0][3]).toContain('in 90 days');
    expect(sendApiDeprecationEmail).toHaveBeenCalledWith('anna@example.com', 'anna', expect.objectContaining({ daysLeft: 90, routes: [ROUTE] }));
    expect(sendApiDeprecationEmail.mock.calls[0][2].reminderDays).toBeUndefined();
    expect(logAudit).toHaveBeenCalledWith(null, 'token.deprecation_notice', { type: 'user', id: 'u1' },
      { tokenId: 't1', notice: 'reminder_90d', routes: [ROUTE], emailed: true });
  });

  test('30 days out the 30-day reminder is claimed', async () => {
    const now = before(30);
    ApiToken.find.mockReturnValue(query([{ _id: 't1', user: 'u1' }]));
    User.find.mockReturnValue(query([owner()]));
    ApiToken.findOneAndUpdate.mockReturnValue(query({ _id: 't1', user: 'u1', name: 'HA', deprecatedUse: marked() }));

    const r = await runDeprecationReminders(now);

    expect(r).toMatchObject({ due: 30, sent: 1 });
    expect(ApiToken.find.mock.calls[0][0]['deprecatedUse.reminders.daysBefore']).toEqual({ $ne: 30 });
    expect(ApiToken.findOneAndUpdate.mock.calls[0][1]).toEqual({ $push: { 'deprecatedUse.reminders': { daysBefore: 30, at: now } } });
    expect(logAudit.mock.calls[0][3].notice).toBe('reminder_30d');
  });
});

describe('deprecatedUseView (Settings → API tokens)', () => {
  test('a recent use under the current sunset is shown; nothing else is', () => {
    expect(deprecatedUseView(marked(), NOW)).toEqual({ routes: [ROUTE], firstAt: NOW, lastAt: NOW, sunset: SUNSET });
    expect(deprecatedUseView(undefined, NOW)).toBeNull();
    expect(deprecatedUseView({}, NOW)).toBeNull();
    expect(deprecatedUseView(marked({ sunset: new Date('2026-01-01T00:00:00Z') }), NOW)).toBeNull();
    expect(deprecatedUseView(marked(), new Date(NOW.getTime() + 31 * DAY))).toBeNull(); // moved on
    expect(deprecatedUseView(marked({ lastAt: new Date(SUNSET.getTime() - DAY) }), SUNSET)).toBeNull();
  });
});
