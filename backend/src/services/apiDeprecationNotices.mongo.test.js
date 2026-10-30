/**
 * services/apiDeprecationNotices against a REAL MongoDB. What makes every
 * notice go once is a conditional update on the token, and only Mongo can say
 * that it holds: two first calls at once, two reminder runs at once, a token
 * revoked meanwhile, an OAuth token, a run from the sunset on. And what the
 * owner can see of it: the marker and the notices in the data export, gone
 * with the account.
 *
 * Needs a MongoDB: NOTICES_MONGO_URI, whose database name must start with
 * "cellarion_notices" (it is dropped before and after). CI provides one; a
 * local run without it skips the suite with a notice. Locally, against the
 * dev stack's Mongo:
 *   docker run --rm --network cellarion-main_default \
 *     -e NOTICES_MONGO_URI=mongodb://mongo:27017/cellarion_notices_local \
 *     -v "<repo>/backend:/app" -w /app node:24-alpine \
 *     node node_modules/jest/bin/jest.js src/services/apiDeprecationNotices.mongo.test.js
 */
jest.mock('./mailgun', () => ({ sendApiDeprecationEmail: jest.fn(async () => {}), EMAIL_VERIFICATION_ENABLED: true }));
// userDataRegistry pulls in services/search, whose meilisearch client is
// ESM-only (Jest cannot load it); nothing here searches.
jest.mock('./search', () => ({ removeBottles: jest.fn(), indexDiscussion: jest.fn() }));

const mongoose = require('mongoose');
const ApiToken = require('../models/ApiToken');
const User = require('../models/User');
const Notification = require('../models/Notification');
const AuditLog = require('../models/AuditLog');
const { sendApiDeprecationEmail } = require('./mailgun');
const { SUNSET } = require('../config/apiDeprecations');
const { markTokenDeprecatedUse, runDeprecationReminders } = require('./apiDeprecationNotices');

const URI = process.env.NOTICES_MONGO_URI;
const describeWithMongo = URI ? describe : describe.skip;
if (!URI) {
  if (process.env.CI) throw new Error('CI must set NOTICES_MONGO_URI: the deprecation-notice claims need a MongoDB');
  // eslint-disable-next-line no-console
  console.warn('services/apiDeprecationNotices.mongo.test.js skipped: set NOTICES_MONGO_URI to a cellarion_notices* database to run it');
}

const DAY = 24 * 60 * 60 * 1000;
const MIN = 60 * 1000;
const at = (daysBeforeSunset, hours = 8) => new Date(SUNSET.getTime() - daysBeforeSunset * DAY + hours * 60 * MIN);
const ok = { statusCode: 200 };
const req = (baseUrl, path) => ({ method: 'GET', baseUrl, route: { path }, path: '/x' });
const CELLAR = req('/api/cellars', '/:id');
const HISTORY = req('/api/stats', '/value-history');

function assertTestDb() {
  if (!/^cellarion_notices/.test(mongoose.connection.name || '')) {
    throw new Error(`refusing to drop "${mongoose.connection.name}": the database name must start with cellarion_notices`);
  }
}

let seq = 0;
async function owner(over = {}) {
  seq += 1;
  const doc = { username: `owner${seq}`, email: `owner${seq}@notices.test`, emailVerified: true, roles: ['user'], ...over };
  const { insertedId } = await User.collection.insertOne(doc);
  return { _id: insertedId, ...doc };
}
async function token(user, over = {}) {
  seq += 1;
  return ApiToken.create({ user: user._id, name: `Token ${seq}`, tokenHash: `hash-${seq}`, scopes: ['read'], ...over });
}
const noticesFor = (user) => Notification.countDocuments({ user: user._id, type: 'api_deprecation' });
const fresh = (t) => ApiToken.findById(t._id);
// logAudit writes fire-and-forget: wait until the rows are there.
async function auditRows(user, expected) {
  for (let i = 0; i < 50; i++) {
    const rows = await AuditLog.find({ action: 'token.deprecation_notice', 'resource.id': user._id }).lean();
    if (rows.length >= expected) return rows;
    await new Promise((r) => setTimeout(r, 50));
  }
  return AuditLog.find({ action: 'token.deprecation_notice', 'resource.id': user._id }).lean();
}

describeWithMongo('deprecation notices against MongoDB', () => {
  let registry;
  beforeAll(async () => {
    await mongoose.connect(URI);
    assertTestDb();
    await mongoose.connection.dropDatabase();
    await ApiToken.init();
    // Loads nearly every model; outside the test's own time budget.
    registry = require('./userDataRegistry');
  }, 180000);

  afterAll(async () => {
    if (mongoose.connection.readyState === 1) {
      assertTestDb();
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  });

  beforeEach(() => sendApiDeprecationEmail.mockClear());

  test('two first calls at once: both routes on the token, its owner told once', async () => {
    const anna = await owner();
    const t = await token(anna);
    const now = at(200);
    const doc = await fresh(t); // as each request read it at its start

    await Promise.all([markTokenDeprecatedUse(doc, CELLAR, ok, now), markTokenDeprecatedUse(doc, HISTORY, ok, now)]);

    const marked = (await fresh(t)).deprecatedUse;
    expect([...marked.routes].sort()).toEqual(['GET /api/cellars/:id', 'GET /api/stats/value-history']);
    expect(marked.sunset).toEqual(SUNSET);
    expect(marked.notifiedAt).toEqual(now);
    expect(await noticesFor(anna)).toBe(1);
    expect(sendApiDeprecationEmail).toHaveBeenCalledTimes(1);
    expect(sendApiDeprecationEmail.mock.calls[0][0]).toBe(anna.email);
    const rows = await auditRows(anna, 1);
    expect(rows.map((r) => r.detail.notice)).toEqual(['first']);

    // The integration keeps polling: within the hour nothing is written,
    // after it lastAt moves; the first notice never goes again.
    await markTokenDeprecatedUse(await fresh(t), CELLAR, ok, new Date(now.getTime() + 10 * MIN));
    expect((await fresh(t)).deprecatedUse.lastAt).toEqual(now);
    const later = new Date(now.getTime() + 61 * MIN);
    await markTokenDeprecatedUse(await fresh(t), CELLAR, ok, later);
    expect((await fresh(t)).deprecatedUse.lastAt).toEqual(later);
    expect(await noticesFor(anna)).toBe(1);
    expect(sendApiDeprecationEmail).toHaveBeenCalledTimes(1);
  });

  test('an OAuth token and a token revoked since its request began are never marked or notified', async () => {
    const bea = await owner();
    const oauth = await token(bea, { origin: 'oauth', expiresAt: new Date(Date.now() + DAY) });
    await markTokenDeprecatedUse(await fresh(oauth), CELLAR, ok, at(200));

    const revoked = await token(bea);
    const read = await fresh(revoked);
    await ApiToken.updateOne({ _id: revoked._id }, { $set: { revokedAt: new Date() } });
    await markTokenDeprecatedUse(read, CELLAR, ok, at(200));

    expect((await ApiToken.findById(oauth._id).lean()).deprecatedUse).toBeUndefined();
    expect((await ApiToken.findById(revoked._id).lean()).deprecatedUse).toBeUndefined();
    expect(await noticesFor(bea)).toBe(0);
    expect(sendApiDeprecationEmail).not.toHaveBeenCalled();
  });

  test('reminders 90 and 30 days out go once each, even when two runs race; from the sunset on nothing goes and the marker is cleared', async () => {
    const carl = await owner();
    const t = await token(carl);
    await markTokenDeprecatedUse(await fresh(t), CELLAR, ok, at(150));
    expect(await noticesFor(carl)).toBe(1);
    // Moved on long ago: never reminded.
    const idle = await token(carl);
    await markTokenDeprecatedUse(await fresh(idle), CELLAR, ok, at(150));
    expect(await noticesFor(carl)).toBe(2);
    const stillUsed = (when) => ApiToken.updateOne({ _id: t._id }, { $set: { 'deprecatedUse.lastAt': when } });

    expect((await runDeprecationReminders(at(100))).sent).toBe(0); // nothing due yet

    await stillUsed(at(92));
    const [a, b] = await Promise.all([runDeprecationReminders(at(90)), runDeprecationReminders(at(90))]);
    expect(a.sent + b.sent).toBe(1);
    expect((await runDeprecationReminders(at(89))).sent).toBe(0);
    expect(await noticesFor(carl)).toBe(3);

    await stillUsed(at(31));
    expect((await runDeprecationReminders(at(30))).sent).toBe(1);
    expect((await runDeprecationReminders(at(29))).sent).toBe(0);
    expect(await noticesFor(carl)).toBe(4);

    const reminders = (await ApiToken.findById(t._id).lean()).deprecatedUse.reminders;
    expect(reminders.map((r) => r.daysBefore)).toEqual([90, 30]);
    expect((await ApiToken.findById(idle._id).lean()).deprecatedUse.reminders).toBeUndefined();
    const rows = await auditRows(carl, 4);
    expect(rows.map((r) => r.detail.notice).sort()).toEqual(['first', 'first', 'reminder_30d', 'reminder_90d']);

    await stillUsed(new Date(SUNSET.getTime() - MIN));
    const after = await runDeprecationReminders(new Date(SUNSET.getTime() + 8 * 60 * MIN));
    expect(after).toMatchObject({ due: null, sent: 0 });
    expect(after.cleared).toBeGreaterThanOrEqual(2);
    expect((await ApiToken.findById(t._id).lean()).deprecatedUse).toBeUndefined();
    expect(await noticesFor(carl)).toBe(4);
  });

  test('a reminder waits a week after the first notice, and a token first told after its day skips it', async () => {
    const dana = await owner();
    // First told 32 days out: the 30-day reminder waits until a week has passed.
    const soon = await token(dana);
    await markTokenDeprecatedUse(await fresh(soon), CELLAR, ok, at(32));
    // First told 29 days out: already past the 30-day reminder's day.
    const late = await token(dana);
    await markTokenDeprecatedUse(await fresh(late), CELLAR, ok, at(29));
    expect(await noticesFor(dana)).toBe(2);

    await ApiToken.updateMany({ user: dana._id }, { $set: { 'deprecatedUse.lastAt': at(28) } });
    expect((await runDeprecationReminders(at(28))).sent).toBe(0);
    expect((await runDeprecationReminders(at(24))).sent).toBe(1); // 8 days after `soon` was told
    expect((await ApiToken.findById(soon._id).lean()).deprecatedUse.reminders).toHaveLength(1);
    expect((await ApiToken.findById(late._id).lean()).deprecatedUse.reminders).toBeUndefined();
  });

  test('the owner finds the marker and the notices in the data export, and both go with the account', async () => {
    const eve = await owner();
    const t = await token(eve);
    await markTokenDeprecatedUse(await fresh(t), CELLAR, ok, at(200));
    await auditRows(eve, 1);

    const exported = await registry.buildUserExport(eve._id, eve);
    const [row] = exported.apiTokens;
    expect(row.deprecatedUse).toMatchObject({ sunset: SUNSET, routes: ['GET /api/cellars/:id'], notifiedAt: at(200), reminders: [] });
    expect(exported.activityLog.map((a) => a.action)).toContain('token.deprecation_notice');

    // The erasure entries for the token and the audit log (purgeUserData
    // runs every entry the same way).
    const ctx = { userId: eve._id, userEmail: eve.email };
    for (const name of ['ApiToken', 'AuditLog']) {
      const entry = registry.REGISTRY.find((e) => e.model.modelName === name);
      await Promise.all([].concat(entry.purge(ctx)));
      if (entry.postPurge) await entry.postPurge(ctx);
    }
    expect(await ApiToken.countDocuments({ user: eve._id })).toBe(0);
    expect(await AuditLog.countDocuments({ action: 'token.deprecation_notice', 'resource.id': eve._id })).toBe(0);
  });
});
