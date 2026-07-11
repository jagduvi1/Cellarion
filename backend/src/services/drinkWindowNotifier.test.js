// Model / side-effect mocks so processUser can be exercised without MongoDB.
// These are hoisted above the require below; shouldSendDigestEmail is pure and
// unaffected (its tests pass emailVerificationEnabled explicitly).
jest.mock('../models/Cellar', () => ({ distinct: jest.fn() }));
jest.mock('../models/Bottle', () => ({ find: jest.fn(), updateOne: jest.fn(), bulkWrite: jest.fn() }));
jest.mock('../models/WineVintageProfile', () => ({ find: jest.fn() }));
jest.mock('./notifications', () => ({ createNotification: jest.fn().mockResolvedValue(undefined) }));
jest.mock('./mailgun', () => ({ sendDrinkWindowDigest: jest.fn().mockResolvedValue(undefined), EMAIL_VERIFICATION_ENABLED: false }));

const { shouldSendDigestEmail, processUser } = require('./drinkWindowNotifier');
const Cellar = require('../models/Cellar');
const Bottle = require('../models/Bottle');
const WineVintageProfile = require('../models/WineVintageProfile');
const { createNotification } = require('./notifications');

/**
 * Regression coverage for the "silently dead digest" bug: the email opt-in
 * lives at preferences.notifications.drinkWindow.email, NOT a top-level
 * notifications.email flag. Reading the wrong leaf made the predicate
 * undefined for every user, so the digest never sent.
 */
describe('shouldSendDigestEmail', () => {
  const verified = (drinkWindowEmail) => ({
    emailVerified: true,
    preferences: { notifications: { drinkWindow: { enabled: true, email: drinkWindowEmail } } },
  });

  it('returns true when opted in at drinkWindow.email, verified, and channel enabled', () => {
    expect(shouldSendDigestEmail(verified(true), true)).toBe(true);
  });

  it('returns false when the user has not opted in (drinkWindow.email false)', () => {
    expect(shouldSendDigestEmail(verified(false), true)).toBe(false);
  });

  it('returns false when the (non-existent) legacy top-level notifications.email is set but drinkWindow.email is not', () => {
    // This is the exact shape the old buggy code read — must NOT trigger a send.
    const user = { emailVerified: true, preferences: { notifications: { email: true } } };
    expect(shouldSendDigestEmail(user, true)).toBe(false);
  });

  it('returns false when the email channel is not configured (emailVerificationEnabled false)', () => {
    expect(shouldSendDigestEmail(verified(true), false)).toBe(false);
  });

  it('returns false when the email is not verified', () => {
    const user = { emailVerified: false, preferences: { notifications: { drinkWindow: { email: true } } } };
    expect(shouldSendDigestEmail(user, true)).toBe(false);
  });

  it('is null-safe for missing preferences / user', () => {
    expect(shouldSendDigestEmail(undefined, true)).toBe(false);
    expect(shouldSendDigestEmail({}, true)).toBe(false);
    expect(shouldSendDigestEmail({ emailVerified: true }, true)).toBe(false);
    expect(shouldSendDigestEmail({ emailVerified: true, preferences: { notifications: {} } }, true)).toBe(false);
  });
});

/**
 * BUG 4 regression: the widened bottle query admits personal-window bottles that
 * have NO wineDefinition (their wine request isn't approved yet). Their wdId is
 * undefined, so the dedup key `undefined:vintage:status` merged every such bottle
 * into ONE bogus "Unknown wine" notification with a dead search link. They must
 * be skipped (no stable wine identity to notify about) while matched-wine bottles
 * are unaffected.
 */
describe('processUser — definition-less personal-window bottles (BUG 4)', () => {
  beforeAll(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-06-15T00:00:00Z'));
  });
  afterAll(() => jest.useRealTimers());

  beforeEach(() => {
    jest.clearAllMocks();
    Cellar.distinct.mockResolvedValue(['cellar1']);
    Bottle.updateOne.mockResolvedValue({});
    Bottle.bulkWrite.mockResolvedValue({});
    // No reviewed sommelier profiles — every classification here is personal.
    WineVintageProfile.find.mockReturnValue({ lean: () => Promise.resolve([]) });
  });

  const mockBottles = (bottles) => {
    Bottle.find.mockReturnValue({ populate: () => ({ lean: () => Promise.resolve(bottles) }) });
  };

  test('two definition-less bottles of the same vintage do NOT merge into an "Unknown wine" alert', async () => {
    // Both are in-window (2020–2030, current year 2026 → peak) but carry no wine
    // definition. A real matched-wine bottle sits alongside them.
    mockBottles([
      { _id: 'b1', cellar: 'cellar1', vintage: '2019', drinkFrom: 2020, drinkTo: 2030, wineDefinition: null },
      { _id: 'b2', cellar: 'cellar1', vintage: '2019', drinkFrom: 2020, drinkTo: 2030, wineDefinition: null },
      { _id: 'b3', cellar: 'cellar1', vintage: '2018', drinkFrom: 2020, drinkTo: 2030, wineDefinition: { _id: 'wd1', name: 'Real Wine' } },
    ]);

    const count = await processUser({ _id: 'u1' }, false);

    // Only the matched-wine bottle produced a notification.
    expect(count).toBe(1);
    expect(createNotification).toHaveBeenCalledTimes(1);
    const [, , title, message] = createNotification.mock.calls[0];
    expect(`${title} ${message}`).toContain('Real Wine');
    // The bug's tell-tale: never an "Unknown wine" line.
    for (const call of createNotification.mock.calls) {
      expect(`${call[2]} ${call[3]}`).not.toContain('Unknown wine');
    }
    // The definition-less bottles are never even marked (no seed/update for them).
    // Transition marks go through Bottle.bulkWrite (transitionOps); older direct
    // updateOne calls are collected too so the assertion is path-agnostic.
    const markedIds = [
      ...Bottle.updateOne.mock.calls.map((c) => c[0]._id),
      ...Bottle.bulkWrite.mock.calls.flatMap((c) => c[0].map((op) => op.updateOne.filter._id)),
    ];
    expect(markedIds).not.toContain('b1');
    expect(markedIds).not.toContain('b2');
    expect(markedIds).toContain('b3');
  });

  test('a lone definition-less personal-window bottle yields no notification', async () => {
    mockBottles([
      { _id: 'b1', cellar: 'cellar1', vintage: 'NV', drinkFrom: 2020, drinkTo: 2030, wineDefinition: null },
    ]);
    const count = await processUser({ _id: 'u1' }, false);
    expect(count).toBe(0);
    expect(createNotification).not.toHaveBeenCalled();
  });

  test('after a window reset (marker null), a matched-wine bottle fires cleanly', async () => {
    // Mirrors BUG 1's downstream effect: a bottle whose marker was cleared by an
    // edit re-fires on the next run.
    mockBottles([
      { _id: 'b3', cellar: 'cellar1', vintage: '2018', drinkFrom: 2020, drinkTo: 2030,
        drinkWindowNotifiedStatus: null, wineDefinition: { _id: 'wd1', name: 'Real Wine' } },
    ]);
    const count = await processUser({ _id: 'u1' }, false);
    expect(count).toBe(1);
    expect(createNotification).toHaveBeenCalledTimes(1);
  });
});
