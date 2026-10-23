/**
 * Drink-window emails: on by default for new accounts, at most one a week.
 *
 * WHY THIS TEST EXISTS:
 * The digest used to go out on every day a bottle changed stage. A new member
 * whose wines get their drink windows over the first days would have had an
 * email almost daily — fine for the few who opted in, not for an email that is
 * now on by default. It must be weekly at most, gather everything announced
 * since the last one, wait out an account's first week, and the change of
 * default must never switch an older account on.
 */
process.env.JWT_SECRET = 'test-secret';

jest.mock('./mailgun', () => ({ sendDrinkWindowDigest: jest.fn(async () => {}), EMAIL_VERIFICATION_ENABLED: true }));
jest.mock('./notifications', () => ({ createNotification: jest.fn() }));

const User = require('../models/User');
const Cellar = require('../models/Cellar');
const Bottle = require('../models/Bottle');
const { sendDrinkWindowDigest } = require('./mailgun');
const { maybeSendDrinkWindowEmail, storeDrinkWindowDefaultsOff, EMAIL_GAP_MS } = require('./drinkWindowNotifier');

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-11-10T06:00:00Z');
const daysAgo = (n) => new Date(NOW.getTime() - n * DAY);

const member = (o = {}) => ({
  _id: 'u1', email: 'a@example.com', username: 'anna', displayName: null, emailVerified: true, emailOptOutAt: null,
  preferences: { notifications: { drinkWindow: { enabled: true, email: true, push: true } } },
  createdAt: daysAgo(60), drinkWindowEmailedAt: null, ...o,
});
const chain = (value) => { const q = { populate: () => q, lean: () => Promise.resolve(value) }; return q; };
const bottle = (wd, vintage, stored, name = `Wine ${wd}`) => ({ wineDefinition: { _id: wd, name }, vintage, drinkWindowNotifiedStatus: stored });

afterEach(() => { jest.restoreAllMocks(); jest.clearAllMocks(); });

describe('maybeSendDrinkWindowEmail', () => {
  function stub(bottles) {
    jest.spyOn(Cellar, 'distinct').mockResolvedValue(['c1']);
    const find = jest.spyOn(Bottle, 'find').mockReturnValue(chain(bottles));
    const stamp = jest.spyOn(User, 'updateOne').mockResolvedValue({});
    return { find, stamp };
  }

  test('gathers what was announced in the last week into one email and stamps it', async () => {
    const { find, stamp } = stub([
      bottle('w1', 2015, 'peak'), bottle('w1', 2015, 'peak'), // two bottles, one line
      bottle('w2', 2009, 'late'), // announced as "declining"
      bottle('w3', 2012, 'ending'),
      { wineDefinition: null, vintage: 2018, drinkWindowNotifiedStatus: 'peak' }, // no wine: skipped
    ]);

    expect(await maybeSendDrinkWindowEmail(member(), NOW)).toBe(3);

    const filter = find.mock.calls[0][0];
    expect(filter.drinkWindowNotifiedAt).toEqual({ $gt: daysAgo(7) });
    expect(filter.cellar).toEqual({ $in: ['c1'] });
    expect(filter.drinkWindowNotifiedStatus).toEqual({ $in: ['peak', 'ending', 'late', 'declining'] });
    const [to, name, lines, id] = sendDrinkWindowDigest.mock.calls[0];
    expect([to, name, id]).toEqual(['a@example.com', 'anna', 'u1']);
    expect(lines.map((l) => [l.name, l.vintage, l.status])).toEqual([
      ['Wine w2', 2009, 'declining'], ['Wine w3', 2012, 'ending'], ['Wine w1', 2015, 'peak'],
    ]);
    expect(stamp).toHaveBeenCalledWith({ _id: 'u1' }, { $set: { drinkWindowEmailedAt: NOW } });
  });

  test('no second email within a week of the last one', async () => {
    const { find } = stub([bottle('w1', 2015, 'peak')]);
    expect(await maybeSendDrinkWindowEmail(member({ drinkWindowEmailedAt: daysAgo(6) }), NOW)).toBe(0);
    expect(find).not.toHaveBeenCalled();
    expect(sendDrinkWindowDigest).not.toHaveBeenCalled();
  });

  test('a week after the last one, it covers everything since then', async () => {
    const { find } = stub([bottle('w1', 2015, 'peak')]);
    const last = new Date(NOW.getTime() - EMAIL_GAP_MS - 60 * 1000);
    expect(await maybeSendDrinkWindowEmail(member({ drinkWindowEmailedAt: last }), NOW)).toBe(1);
    expect(find.mock.calls[0][0].drinkWindowNotifiedAt).toEqual({ $gt: daysAgo(7) });
  });

  test("nothing in an account's first week — the new-member email already says what is ready", async () => {
    const { find } = stub([bottle('w1', 2015, 'peak')]);
    expect(await maybeSendDrinkWindowEmail(member({ createdAt: daysAgo(3) }), NOW)).toBe(0);
    expect(find).not.toHaveBeenCalled();
    // …and its first one covers the whole first week
    await maybeSendDrinkWindowEmail(member({ createdAt: daysAgo(8) }), NOW);
    expect(find.mock.calls[0][0].drinkWindowNotifiedAt).toEqual({ $gt: daysAgo(7) });
  });

  test('nothing announced: no email and no stamp', async () => {
    const { stamp } = stub([]);
    expect(await maybeSendDrinkWindowEmail(member(), NOW)).toBe(0);
    expect(sendDrinkWindowDigest).not.toHaveBeenCalled();
    expect(stamp).not.toHaveBeenCalled();
  });

  test('switched off, unsubscribed or unverified: nothing is even looked up', async () => {
    const { find } = stub([bottle('w1', 2015, 'peak')]);
    const off = member();
    off.preferences.notifications.drinkWindow.email = false;
    for (const u of [off, member({ emailOptOutAt: daysAgo(30) }), member({ emailVerified: false })]) {
      expect(await maybeSendDrinkWindowEmail(u, NOW)).toBe(0);
    }
    expect(find).not.toHaveBeenCalled();
  });
});

describe('defaults', () => {
  test('a new account gets drink-window email and push on', () => {
    const u = new User({ username: 'newbie', email: 'n@example.com', password: 'x' });
    expect(u.preferences.notifications.drinkWindow.toObject ? u.preferences.notifications.drinkWindow.toObject() : u.preferences.notifications.drinkWindow)
      .toMatchObject({ enabled: true, email: true, push: true });
  });

  test('the boot step stores off where an older account has nothing stored, and leaves a legacy "false" alone', async () => {
    const many = jest.spyOn(User, 'updateMany').mockResolvedValueOnce({ modifiedCount: 4 }).mockResolvedValueOnce({ modifiedCount: 2 });

    expect(await storeDrinkWindowDefaultsOff()).toBe(6);

    expect(many).toHaveBeenNthCalledWith(1,
      { 'preferences.notifications.drinkWindow.email': { $exists: false }, 'preferences.notifications.drinkWindow': { $not: { $type: 'bool' } } },
      { $set: { 'preferences.notifications.drinkWindow.email': false } });
    expect(many).toHaveBeenNthCalledWith(2,
      { 'preferences.notifications.drinkWindow.push': { $exists: false }, 'preferences.notifications.drinkWindow': { $not: { $type: 'bool' } } },
      { $set: { 'preferences.notifications.drinkWindow.push': false } });
  });
});
