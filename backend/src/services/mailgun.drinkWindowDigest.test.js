/**
 * services/mailgun sendDrinkWindowDigest: the drink-window email, now on by
 * default for new accounts and sent at most once a week.
 *
 * WHY THIS TEST EXISTS:
 * An email that starts on must be as easy to stop as to get: it says it comes
 * at most weekly, and carries a one-click link that stops ONLY these emails
 * (the bell keeps the alerts), the Settings link and the unsubscribe-all link.
 */
process.env.MAILGUN_API_KEY = 'key-test';
process.env.MAILGUN_DOMAIN = 'mg.test';
process.env.FRONTEND_URL = 'https://cellarion.test';
process.env.JWT_SECRET = 'test-secret';

const mockCreate = jest.fn(async () => ({ id: 'msg-1' }));
jest.mock('mailgun.js', () => jest.fn().mockImplementation(() => ({
  client: () => ({ messages: { create: (...args) => mockCreate(...args) } }),
})));

const { sendDrinkWindowDigest } = require('./mailgun');
const { verifyScopedUnsubscribeToken, verifyUnsubscribeToken } = require('../utils/unsubscribe');

const USER = '64b000000000000000000001';
const lines = [{ name: 'Château Musar', vintage: 2008, status: 'declining' }, { name: 'Barolo', vintage: 2016, status: 'peak' }];

test('says it comes at most weekly and links a stop for just these emails, Settings and unsubscribe-all', async () => {
  await sendDrinkWindowDigest('anna@example.com', 'Anna', lines, USER);
  const msg = mockCreate.mock.calls[0][1];

  for (const body of [msg.text, msg.html]) {
    expect(body).toContain('You get at most one of these emails a week.');
    const stop = body.match(/https:\/\/cellarion\.test\/api\/users\/unsubscribe\/drink-window\?token=([A-Za-z0-9_-]+)/);
    expect(stop && verifyScopedUnsubscribeToken(stop[1], 'drinkWindow')).toBe(USER);
    // the stop link cannot be replayed as an unsubscribe-from-everything
    expect(verifyUnsubscribeToken(stop[1])).toBeNull();
    const all = body.match(/https:\/\/cellarion\.test\/api\/users\/unsubscribe\?token=([A-Za-z0-9_-]+)/);
    expect(all && verifyUnsubscribeToken(all[1])).toBe(USER);
    expect(body).toContain('https://cellarion.test/settings#notifications');
  }
  expect(msg.text).toContain('- Château Musar 2008: Past its window');
});

describe('a long list', () => {
  const many = (status, n) => Array.from({ length: n }, (_, i) => ({ name: `${status} wine ${i + 1}`, vintage: 2015, status }));
  const send = async (list) => {
    mockCreate.mockClear();
    await sendDrinkWindowDigest('anna@example.com', 'Anna', list, USER);
    return mockCreate.mock.calls[0][1];
  };
  const listedIn = (text) => text.split('\n').filter((l) => l.startsWith('- '));

  test('up to 20 wines are all listed, with no count line', async () => {
    const msg = await send(many('peak', 20));
    expect(listedIn(msg.text)).toHaveLength(20);
    expect(msg.text).toContain('Some bottles in your cellar have drink-window updates:');
    expect(msg.text).not.toContain('more.');
  });

  test('beyond 20 it lists 20, counts each status and counts the rest', async () => {
    const msg = await send([...many('declining', 264), ...many('ending', 91), ...many('peak', 214)]);

    expect(listedIn(msg.text)).toHaveLength(20);
    for (const body of [msg.text, msg.html]) {
      expect(body).toContain('569 wines in your cellar have drink-window updates: 264 past their window, 91 with their peak ending soon, 214 at peak. Here are 20 of them:');
      expect(body).toContain('…and 549 more. Open your cellar to see them all.');
    }
    expect(msg.subject).toBe('Cellarion: 569 bottles need your attention');
    // Every status is shown, the urgent ones first: not 20 wines past their window.
    const statuses = listedIn(msg.text).map((l) => l.split(': ')[1]);
    expect(statuses.filter((s) => s.startsWith('Past its window'))).toHaveLength(8);
    expect(statuses.filter((s) => s.startsWith('Peak ending soon'))).toHaveLength(6);
    expect(statuses.filter((s) => s.startsWith('Entered peak'))).toHaveLength(6);
    expect((msg.html.match(/<tr>/g) || []).length).toBe(21);
  });

  test('a status with few wines gives its free places to the others', async () => {
    const msg = await send([...many('declining', 2), ...many('peak', 60)]);
    const statuses = listedIn(msg.text).map((l) => l.split(': ')[1]);
    expect(statuses.filter((s) => s.startsWith('Past its window'))).toHaveLength(2);
    expect(statuses.filter((s) => s.startsWith('Entered peak'))).toHaveLength(18);
    expect(msg.text).toContain('62 wines in your cellar have drink-window updates: 2 past their window, 60 at peak.');
  });
});
