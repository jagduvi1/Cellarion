/**
 * services/mailgun sendInactivityNoticeEmail: the two notices before an unused
 * account is deleted (services/inactiveAccounts).
 *
 * WHY THIS TEST EXISTS:
 * Someone who has not used Cellarion for a long time must be able to tell, from
 * this email alone, what happens and when, and how to stop it: the date, that
 * signing in once is enough, and that they can take a copy first. It is a
 * notice about the account itself, so it says why it reaches them after an
 * unsubscribe and carries no unsubscribe link that could not stop it. Names
 * are user text and must be escaped.
 */
process.env.MAILGUN_API_KEY = 'key-test';
process.env.MAILGUN_DOMAIN = 'mg.test';
process.env.FRONTEND_URL = 'https://cellarion.test';
process.env.JWT_SECRET = 'test-secret';

const mockCreate = jest.fn(async () => ({ id: 'msg-1' }));
jest.mock('mailgun.js', () => jest.fn().mockImplementation(() => ({
  client: () => ({ messages: { create: (...args) => mockCreate(...args) } }),
})));

const { sendInactivityNoticeEmail } = require('./mailgun');

beforeEach(() => { mockCreate.mockClear(); });
const sent = () => mockCreate.mock.calls[0][1];

const notice = (over = {}) => ({
  final: false,
  deleteAfter: new Date('2028-12-01T09:13:00Z'),
  lastActiveAt: new Date('2026-11-01T00:00:00Z'),
  months: 24,
  bottles: 42,
  ...over,
});

test('the first notice names the date, the rule, and that signing in once keeps the account', async () => {
  await sendInactivityNoticeEmail('anna@example.com', 'Anna', notice());
  const m = sent();
  expect(m.to).toEqual(['anna@example.com']);
  expect(m.subject).toBe('Your Cellarion account will be deleted on 1 December 2028');
  expect(m.text).toContain('You have not used your Cellarion account since 1 November 2026. It still holds 42 bottles.');
  expect(m.text).toContain('not been used for 24 months');
  expect(m.text).toContain('will be deleted on 1 December 2028');
  expect(m.text).toContain('sign in once before then');
  expect(m.text).toContain('Sign in: https://cellarion.test/login');
  expect(m.text).toContain('Settings has a download');
  expect(m.html).toContain('href="https://cellarion.test/login"');
  expect(m['h:Reply-To']).toBeTruthy();
});

test('the final notice says it is the last one', async () => {
  await sendInactivityNoticeEmail('anna@example.com', 'Anna', notice({ final: true }));
  const m = sent();
  expect(m.subject).toBe('Last notice: your Cellarion account will be deleted on 1 December 2028');
  expect(m.text).toContain('This is the last notice about your Cellarion account.');
});

test('it says why it arrives after an unsubscribe, and carries no unsubscribe link', async () => {
  await sendInactivityNoticeEmail('anna@example.com', 'Anna', notice());
  const m = sent();
  expect(m.text).toContain('sent even if you unsubscribed from Cellarion emails');
  expect(m.text).not.toMatch(/\/api\/users\/unsubscribe/);
  expect(m.html).not.toMatch(/\/api\/users\/unsubscribe/);
});

test('an empty account gets no bottle line, and its own period', async () => {
  await sendInactivityNoticeEmail('anna@example.com', 'Anna', notice({ bottles: 0, months: 12 }));
  const m = sent();
  expect(m.text).not.toContain('It still holds');
  expect(m.text).toContain('not been used for 12 months');
});

test('one bottle reads as one bottle', async () => {
  await sendInactivityNoticeEmail('anna@example.com', 'Anna', notice({ bottles: 1 }));
  expect(sent().text).toContain('It still holds 1 bottle.');
});

test('the name is escaped in the HTML part', async () => {
  await sendInactivityNoticeEmail('anna@example.com', '<b>Anna</b>', notice());
  expect(sent().html).toContain('&lt;b&gt;Anna&lt;/b&gt;');
  expect(sent().html).not.toContain('<b>Anna</b>');
});
