// Model / side-effect mocks so processUser can be exercised without MongoDB.
// These are hoisted above the require below; shouldSendDigestEmail is pure and
// unaffected (its tests pass emailVerificationEnabled explicitly).
jest.mock('../models/Cellar', () => ({ distinct: jest.fn() }));
jest.mock('../models/Bottle', () => ({ find: jest.fn(), updateOne: jest.fn(), updateMany: jest.fn(), bulkWrite: jest.fn() }));
jest.mock('../models/WineVintageProfile', () => ({ find: jest.fn() }));
jest.mock('./notifications', () => ({ createNotification: jest.fn().mockResolvedValue(undefined) }));
jest.mock('./mailgun', () => ({ sendDrinkWindowDigest: jest.fn().mockResolvedValue(undefined), EMAIL_VERIFICATION_ENABLED: false }));

const { shouldSendDigestEmail, processUser, processReservations, processArrivals } = require('./drinkWindowNotifier');
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

  // Audit 2026-09-27 M7: "unsubscribe from all Cellarion email" is an objection
  // to email as such — it wins over a per-category opt-in left (or set) on.
  it('returns false when the user objected to all email (emailOptOutAt), even with drinkWindow.email on', () => {
    expect(shouldSendDigestEmail({ ...verified(true), emailOptOutAt: new Date('2026-08-01') }, true)).toBe(false);
    expect(shouldSendDigestEmail({ ...verified(true), emailOptOutAt: null }, true)).toBe(true);
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

/**
 * Audit 2026-08-03 H6 regression: NV bottles with a curated `relative` profile
 * were excluded from the candidate query (vintage: { $ne: 'NV' }), so the cron
 * never even evaluated them — the notification path was structurally dead for
 * the entire NV/Champagne category despite a fully-curated profile.
 */
describe('processUser — NV bottles with relative profiles (H6)', () => {
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
  });

  const mockBottles = (bottles) => {
    Bottle.find.mockReturnValue({ populate: () => ({ lean: () => Promise.resolve(bottles) }) });
  };

  // Peak 2–5 years after purchase; bought 2024 → peak 2026–2029 → 'peak' now.
  const relProfile = {
    wineDefinition: 'wd1', vintage: 'NV', status: 'reviewed', relative: true,
    earlyFrom: 0, earlyUntil: 1, peakFrom: 2, peakUntil: 5,
  };

  test('the candidate query no longer excludes NV wine-definition bottles', async () => {
    mockBottles([]);
    await processUser({ _id: 'u1' }, false);
    const query = Bottle.find.mock.calls[0][0];
    expect(query.$or).toContainEqual({ wineDefinition: { $ne: null } });
    // The old exclusion shape must be gone.
    expect(JSON.stringify(query)).not.toContain('NV');
  });

  test('an NV bottle entering its relative peak window fires a peak notification', async () => {
    WineVintageProfile.find.mockReturnValue({ lean: () => Promise.resolve([relProfile]) });
    mockBottles([
      { _id: 'nv1', cellar: 'cellar1', vintage: 'NV', purchaseDate: '2024-03-01',
        wineDefinition: { _id: 'wd1', name: 'Grande Cuvée' } },
    ]);

    const count = await processUser({ _id: 'u1' }, false);

    expect(count).toBe(1);
    expect(createNotification).toHaveBeenCalledTimes(1);
    const [, type, , message] = createNotification.mock.calls[0];
    expect(type).toBe('drink_window_peak');
    expect(message).toContain('Grande Cuvée');
  });

  test('an NV bottle with NO anchor (no purchaseDate/createdAt) stays unclassified — no alert, no marker', async () => {
    WineVintageProfile.find.mockReturnValue({ lean: () => Promise.resolve([relProfile]) });
    mockBottles([
      { _id: 'nv1', cellar: 'cellar1', vintage: 'NV',
        wineDefinition: { _id: 'wd1', name: 'Grande Cuvée' } },
    ]);

    const count = await processUser({ _id: 'u1' }, false);

    expect(count).toBe(0);
    expect(createNotification).not.toHaveBeenCalled();
    expect(Bottle.bulkWrite).not.toHaveBeenCalled();
  });

  test('first run silently seeds the NV bottle status instead of notifying', async () => {
    WineVintageProfile.find.mockReturnValue({ lean: () => Promise.resolve([relProfile]) });
    mockBottles([
      { _id: 'nv1', cellar: 'cellar1', vintage: 'NV', purchaseDate: '2024-03-01',
        wineDefinition: { _id: 'wd1', name: 'Grande Cuvée' } },
    ]);

    const count = await processUser({ _id: 'u1' }, true);

    expect(count).toBe(0);
    expect(createNotification).not.toHaveBeenCalled();
    const seedOps = Bottle.bulkWrite.mock.calls[0][0];
    expect(seedOps[0].updateOne.filter._id).toBe('nv1');
    expect(seedOps[0].updateOne.update.$set.drinkWindowNotifiedStatus).toBe('peak');
  });
});

/**
 * Reservation ("spoken for") alerts: fire once when reservedUntil arrives
 * (currentYear ≥ reservedUntil), marked via reservationNotifiedAt so the daily
 * cron never repeats the alert. The query itself must exclude already-notified
 * and not-yet-due bottles — that exclusion IS the one-shot mechanism.
 */
describe('processReservations', () => {
  beforeAll(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-06-15T00:00:00Z'));
  });
  afterAll(() => jest.useRealTimers());

  beforeEach(() => {
    jest.clearAllMocks();
    Bottle.updateOne.mockResolvedValue({});
  });

  const mockBottles = (bottles) => {
    Bottle.find.mockReturnValue({ populate: () => ({ lean: () => Promise.resolve(bottles) }) });
  };

  test('queries ONLY due, un-notified, active bottles — the once-only contract lives in the filter', async () => {
    mockBottles([]);
    await processReservations({ _id: 'u1' });
    const q = Bottle.find.mock.calls[0][0];
    expect(q.user).toBe('u1');
    expect(q.reservationNotifiedAt).toBeNull();
    // Due = reservedUntil ≤ current year; $lte on a number never matches a
    // null/missing reservedUntil (type bracketing), so unreserved bottles and
    // reservations without a year are structurally excluded.
    expect(q.reservedUntil).toEqual({ $lte: 2026 });
    expect(q.status.$nin).toContain('drank');
  });

  test('notifies with wine + reservedFor, deep-links the bottle, and stamps the one-shot marker', async () => {
    mockBottles([
      { _id: 'b1', cellar: 'c1', vintage: '2016', reservedFor: "Elias's 18th birthday",
        reservedUntil: 2026, reservationNotifiedAt: null,
        wineDefinition: { _id: 'wd1', name: 'CdP Les Cailloux' } },
    ]);
    const count = await processReservations({ _id: 'u1' });
    expect(count).toBe(1);
    expect(createNotification).toHaveBeenCalledTimes(1);
    const [userId, type, title, message, link, category] = createNotification.mock.calls[0];
    expect(userId).toBe('u1');
    expect(type).toBe('reservation_due');
    expect(title).toMatch(/Reserved bottle/);
    expect(message).toContain('CdP Les Cailloux 2016');
    expect(message).toContain("Elias's 18th birthday");
    expect(message).toContain('2026');
    expect(link).toBe('/cellars/c1/bottles/b1');
    expect(category).toBe('drinkWindow'); // honours the drinkWindow push opt-in
    expect(Bottle.updateOne).toHaveBeenCalledWith(
      { _id: 'b1' },
      { $set: { reservationNotifiedAt: expect.any(Date) } }
    );
  });

  test('a reservation without reservedFor still reads cleanly (no "for undefined")', async () => {
    mockBottles([
      { _id: 'b2', cellar: 'c1', vintage: 'NV', reservedUntil: 2025, reservationNotifiedAt: null,
        wineDefinition: { _id: 'wd2', name: 'Champagne Réserve' } },
    ]);
    await processReservations({ _id: 'u1' });
    const message = createNotification.mock.calls[0][3];
    expect(message).toContain('Champagne Réserve'); // NV vintage → no year suffix
    expect(message).not.toContain('undefined');
    expect(message).not.toMatch(/for\s+until/);
  });

  test('no due bottles → zero notifications, zero marker writes', async () => {
    mockBottles([]);
    const count = await processReservations({ _id: 'u1' });
    expect(count).toBe(0);
    expect(createNotification).not.toHaveBeenCalled();
    expect(Bottle.updateOne).not.toHaveBeenCalled();
  });
});

describe('processArrivals — bottles on order past their expected month', () => {
  beforeAll(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-10-04T08:00:00Z'));
  });
  afterAll(() => jest.useRealTimers());

  beforeEach(() => {
    jest.clearAllMocks();
    Bottle.updateMany.mockResolvedValue({});
    Cellar.distinct.mockResolvedValue(['c1', 'c2']);
  });

  const mockOrdered = (bottles) => {
    Bottle.find.mockReturnValue({ select: () => ({ populate: () => ({ lean: () => Promise.resolve(bottles) }) }) });
  };
  const month = (iso) => new Date(`${iso}-01T12:00:00Z`);

  test('queries only un-notified bottles on order expected before this month began', async () => {
    mockOrdered([]);
    await processArrivals({ _id: 'u1' });
    const q = Bottle.find.mock.calls[0][0];
    expect(q).toMatchObject({ user: 'u1', status: 'ordered', arrivalNotifiedAt: null });
    expect(q.expectedArrival).toEqual({ $lt: new Date('2026-10-01T00:00:00Z') });
  });

  test('one notification per cellar, linking its on-order page; every bottle in it is stamped', async () => {
    mockOrdered([
      { _id: 'b1', cellar: 'c1', vintage: '2023', expectedArrival: month('2026-09'), wineDefinition: { name: 'Léoville Barton' } },
      { _id: 'b2', cellar: 'c1', vintage: '2023', expectedArrival: month('2026-08'), wineDefinition: { name: 'Léoville Barton' } },
      { _id: 'b3', cellar: 'c2', vintage: 'NV', expectedArrival: month('2026-06'), wineDefinition: { name: 'Krug Grande Cuvée' } },
    ]);
    const count = await processArrivals({ _id: 'u1' });
    expect(count).toBe(2);
    const [first, second] = createNotification.mock.calls;
    expect(first[1]).toBe('order_arrival_due');
    expect(first[3]).toContain('2 bottles on order');
    expect(first[4]).toBe('/cellars/c1/on-order');
    expect(first[5]).toBe('drinkWindow');
    expect(second[3]).toContain('Krug Grande Cuvée was expected in June 2026');
    expect(second[4]).toBe('/cellars/c2/on-order');
    expect(Bottle.updateMany).toHaveBeenCalledWith({ _id: { $in: ['b1', 'b2'] } }, { $set: { arrivalNotifiedAt: expect.any(Date) } });
  });

  test('a bottle in a deleted cellar is never announced', async () => {
    Cellar.distinct.mockResolvedValue([]);
    mockOrdered([{ _id: 'b1', cellar: 'gone', vintage: '2023', expectedArrival: month('2026-01'), wineDefinition: { name: 'X' } }]);
    expect(await processArrivals({ _id: 'u1' })).toBe(0);
    expect(createNotification).not.toHaveBeenCalled();
  });
});
