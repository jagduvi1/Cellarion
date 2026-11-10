/**
 * createNotifications → web push: the push carries the opening of a long
 * message, the bell keeps the whole text.
 *
 * A push service refuses a payload over 4 KB, and that refusal is silent: the
 * member simply gets no push. Messages can be long (a curator's reason for
 * not applying a suggested fix runs to 2000 characters), so the push copy is
 * bounded while the stored notification is not.
 *
 * VAPID keys are read when the module loads, so they are set before it is
 * required; web-push itself is mocked.
 */
const savedEnv = { pub: process.env.VAPID_PUBLIC_KEY, priv: process.env.VAPID_PRIVATE_KEY };
process.env.VAPID_PUBLIC_KEY = 'test-public';
process.env.VAPID_PRIVATE_KEY = 'test-private';

const mockSend = jest.fn().mockResolvedValue({});
jest.mock('web-push', () => ({ setVapidDetails: jest.fn(), sendNotification: (...args) => mockSend(...args) }));
jest.mock('../models/Notification', () => ({ insertMany: jest.fn() }));
jest.mock('../models/PushSubscription', () => ({ find: jest.fn(), deleteOne: jest.fn() }));
jest.mock('../models/User', () => ({ find: jest.fn() }));
jest.mock('./eventBus', () => ({ emit: jest.fn() }));

const Notification = require('../models/Notification');
const PushSubscription = require('../models/PushSubscription');
const User = require('../models/User');
const { createNotification } = require('./notifications');

afterAll(() => {
  for (const [key, name] of [['pub', 'VAPID_PUBLIC_KEY'], ['priv', 'VAPID_PRIVATE_KEY']]) {
    if (savedEnv[key] === undefined) delete process.env[name]; else process.env[name] = savedEnv[key];
  }
});

beforeEach(() => {
  jest.clearAllMocks();
  Notification.insertMany.mockImplementation(async (rows) => rows.map((r, i) => ({ ...r, _id: { toString: () => `n${i}` } })));
  User.find.mockReturnValue({ select: () => ({ lean: async () => [{ _id: 'u1', preferences: { notifications: { drinkWindow: { push: true } } } }] }) });
  PushSubscription.find.mockReturnValue({ lean: async () => [{ _id: 's1', user: 'u1', endpoint: 'https://push.example/1', keys: {} }] });
});

const pushed = () => JSON.parse(mockSend.mock.calls[0][1]);

test('a short message is pushed as it is', async () => {
  await createNotification('u1', 'wine_correction_decided', 'Not applied', 'The label says otherwise.', '/wines/w1');
  expect(pushed()).toEqual({ title: 'Not applied', message: 'The label says otherwise.', link: '/wines/w1', tag: 'wine_correction_decided' });
});

test('a long message is stored whole and pushed as its opening, within the push size limit', async () => {
  const long = `Your suggested fix was not applied.\n\n${'A reason with detail. '.repeat(90)}`;
  expect(long.length).toBeGreaterThan(1900);
  await createNotification('u1', 'wine_correction_decided', 'Not applied', long, '/wines/w1');

  expect(Notification.insertMany.mock.calls[0][0][0].message).toBe(long);
  const { message } = pushed();
  // At most 500 characters: a space before the cut is dropped, not pushed.
  expect([...message].length).toBeLessThanOrEqual(500);
  expect([...message].length).toBeGreaterThan(490);
  expect(message.endsWith('…')).toBe(true);
  expect(long.startsWith(message.slice(0, -1))).toBe(true);
  expect(Buffer.byteLength(mockSend.mock.calls[0][1], 'utf8')).toBeLessThan(4000);
});

test('four-byte characters are counted whole, never cut in half, and still fit', async () => {
  await createNotification('u1', 'wine_correction_decided', 'Not applied', '🍷'.repeat(2000), '/wines/w1');
  const { message } = pushed();
  expect([...message]).toHaveLength(500);
  expect(message).toBe(`${'🍷'.repeat(499)}…`);
  expect(Buffer.byteLength(mockSend.mock.calls[0][1], 'utf8')).toBeLessThan(4000);
});
