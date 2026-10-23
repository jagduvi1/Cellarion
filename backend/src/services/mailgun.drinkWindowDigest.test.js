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
