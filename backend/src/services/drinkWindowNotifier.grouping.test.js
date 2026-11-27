/**
 * services/drinkWindowNotifier: how many notifications one run creates.
 *
 * WHY THIS TEST EXISTS:
 * A bottle the daily check has not seen before counts as having just reached
 * its status, so the morning after an import every matured bottle alerts. One
 * notification per wine filled a new member's bell with hundreds of unread
 * lines. Many wines of one cellar reaching the same status in one run share
 * ONE notification, and a bottle first seen in the last year of its peak is
 * announced once, not as "peak" today and "ending" tomorrow.
 */
jest.mock('../models/Cellar', () => ({ distinct: jest.fn() }));
jest.mock('../models/Bottle', () => ({ find: jest.fn(), updateOne: jest.fn(), updateMany: jest.fn(), bulkWrite: jest.fn() }));
jest.mock('../models/WineVintageProfile', () => ({ find: jest.fn() }));
jest.mock('./notifications', () => ({ createNotification: jest.fn().mockResolvedValue(undefined) }));
jest.mock('./mailgun', () => ({ sendDrinkWindowDigest: jest.fn().mockResolvedValue(undefined), EMAIL_VERIFICATION_ENABLED: false }));

const { processUser } = require('./drinkWindowNotifier');
const Cellar = require('../models/Cellar');
const Bottle = require('../models/Bottle');
const WineVintageProfile = require('../models/WineVintageProfile');
const { createNotification } = require('./notifications');

// Personal windows against 2026: peak (ends 2030), ending (ends 2027), past (ended 2020).
const PEAK = { drinkFrom: 2020, drinkTo: 2030 };
const ENDING = { drinkFrom: 2020, drinkTo: 2027 };
const PAST = { drinkFrom: 2010, drinkTo: 2020 };

let seq = 0;
const bottle = (name, window, extra = {}) => {
  seq += 1;
  return { _id: `b${seq}`, cellar: 'cellar1', vintage: '2015', wineDefinition: { _id: `wd-${name}`, name }, ...window, ...extra };
};
const mockBottles = (bottles) => {
  Bottle.find.mockReturnValue({ populate: () => ({ lean: () => Promise.resolve(bottles) }) });
};
const sent = () => createNotification.mock.calls.map(([, type, title, message, link, category]) => ({ type, title, message, link, category }));
const markedIds = () => Bottle.bulkWrite.mock.calls.flatMap((c) => c[0].map((op) => op.updateOne.filter._id));

beforeAll(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-06-15T00:00:00Z'));
});
afterAll(() => jest.useRealTimers());

beforeEach(() => {
  jest.clearAllMocks();
  seq = 0;
  Cellar.distinct.mockResolvedValue(['cellar1']);
  Bottle.bulkWrite.mockResolvedValue({});
  WineVintageProfile.find.mockReturnValue({ lean: () => Promise.resolve([]) });
});

test('two wines reaching peak each get their own notification, linking the vintage page', async () => {
  mockBottles([bottle('Barolo', PEAK), bottle('Rioja', PEAK)]);

  expect(await processUser({ _id: 'u1' }, false)).toBe(2);
  expect(sent().map((n) => n.link)).toEqual([
    '/cellars/cellar1/vintages/wd-Barolo/2015',
    '/cellars/cellar1/vintages/wd-Rioja/2015',
  ]);
  expect(sent()[0].message).toBe('Barolo 2015 has entered its peak drinking window — time to enjoy it!');
});

test('three or more wines of a cellar reaching peak share one notification, linking the cellar filtered to peak', async () => {
  const bottles = ['Barolo', 'Rioja', 'Chablis', 'Sancerre'].map((n) => bottle(n, PEAK));
  mockBottles(bottles);

  expect(await processUser({ _id: 'u1' }, false)).toBe(1);
  expect(sent()).toEqual([{
    type: 'drink_window_peak',
    title: '4 wines at peak maturity',
    message: 'Barolo 2015 and 3 other wines in your cellar are in their peak drinking window — time to enjoy them!',
    link: '/cellars/cellar1?maturity=peak',
    category: 'drinkWindow',
  }]);
  // Every bottle is still marked, so none of them is announced again tomorrow.
  expect(markedIds().sort()).toEqual(bottles.map((b) => b._id).sort());
});

test('an import of a matured cellar: one notification per status, not one per wine', async () => {
  const names = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
  mockBottles([
    ...names('Peak', 40).map((n) => bottle(n, PEAK)),
    ...names('Ending', 12).map((n) => bottle(n, ENDING)),
    ...names('Past', 25).map((n) => bottle(n, PAST)),
  ]);

  expect(await processUser({ _id: 'u1' }, false)).toBe(3);
  expect(sent().map((n) => [n.type, n.title, n.link])).toEqual([
    ['drink_window_peak', '40 wines at peak maturity', '/cellars/cellar1?maturity=peak'],
    ['drink_window_ending', '12 wines with their peak ending soon', '/cellars/cellar1?maturity=peak'],
    ['drink_window_past', '25 wines past their window', '/cellars/cellar1?maturity=late,declining'],
  ]);
});

test('several bottles of one wine and vintage count as one wine', async () => {
  mockBottles([bottle('Barolo', PEAK), bottle('Barolo', PEAK), bottle('Barolo', PEAK), bottle('Rioja', PEAK)]);

  expect(await processUser({ _id: 'u1' }, false)).toBe(2);
  expect(sent().map((n) => n.link)).toEqual([
    '/cellars/cellar1/vintages/wd-Barolo/2015',
    '/cellars/cellar1/vintages/wd-Rioja/2015',
  ]);
});

test('wines are grouped per cellar: each link opens one cellar', async () => {
  Cellar.distinct.mockResolvedValue(['cellar1', 'cellar2']);
  mockBottles([
    ...['A', 'B', 'C'].map((n) => bottle(n, PEAK)),
    ...['D', 'E'].map((n) => bottle(n, PEAK, { cellar: 'cellar2' })),
  ]);

  expect(await processUser({ _id: 'u1' }, false)).toBe(3);
  expect(sent().map((n) => n.link)).toEqual([
    '/cellars/cellar1?maturity=peak',
    '/cellars/cellar2/vintages/wd-D/2015',
    '/cellars/cellar2/vintages/wd-E/2015',
  ]);
});

test('a grouped non-vintage wine is named without "NV"', async () => {
  mockBottles([bottle('Champagne Brut', PEAK, { vintage: 'NV' }), bottle('Rioja', PEAK), bottle('Chablis', PEAK)]);

  await processUser({ _id: 'u1' }, false);
  expect(sent()[0].message).toMatch(/^Champagne Brut and 2 other wines /);
});

test('a bottle first seen in the last year of its peak is announced once, as ending', async () => {
  const b = bottle('Barolo', ENDING);
  mockBottles([b]);

  expect(await processUser({ _id: 'u1' }, false)).toBe(1);
  expect(sent()[0].type).toBe('drink_window_ending');
  const [[ops]] = Bottle.bulkWrite.mock.calls;
  expect(ops[0].updateOne.update.$set.drinkWindowNotifiedStatus).toBe('ending');

  // The next day's run finds the marker and says nothing more.
  jest.clearAllMocks();
  Cellar.distinct.mockResolvedValue(['cellar1']);
  mockBottles([{ ...b, drinkWindowNotifiedStatus: 'ending' }]);
  expect(await processUser({ _id: 'u1' }, false)).toBe(0);
  expect(createNotification).not.toHaveBeenCalled();
});

test('a bottle already announced at peak is announced as ending when its last year comes', async () => {
  mockBottles([bottle('Barolo', ENDING, { drinkWindowNotifiedStatus: 'peak' })]);

  expect(await processUser({ _id: 'u1' }, false)).toBe(1);
  expect(sent()[0].type).toBe('drink_window_ending');
});
