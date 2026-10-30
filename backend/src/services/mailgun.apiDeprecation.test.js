/**
 * services/mailgun sendApiDeprecationEmail: the owner of a token still
 * calling routes on their way out is told which token, which routes, the day
 * they stop answering tokens, and what replaces them. A service message about
 * their own account: no unsubscribe link, and a Reply-To that reaches a
 * person, since it asks to hear what is missing. The token's name is the
 * owner's text, so it cannot break out of the subject header, and it is
 * escaped in the HTML.
 */
process.env.MAILGUN_API_KEY = 'key-test';
process.env.MAILGUN_DOMAIN = 'mg.test';
process.env.FRONTEND_URL = 'https://cellarion.test';

const mockCreate = jest.fn(async () => ({ id: 'msg-1' }));
jest.mock('mailgun.js', () => jest.fn().mockImplementation(() => ({
  client: () => ({ messages: { create: (...args) => mockCreate(...args) } }),
})));

const { sendApiDeprecationEmail } = require('./mailgun');

const SUNSET = new Date('2027-05-01T00:00:00Z');
const sent = () => mockCreate.mock.calls[0][1];

beforeEach(() => {
  mockCreate.mockClear();
  delete process.env.SUPPORT_REPLY_TO;
});

test('the first notice names the token, the routes, the day and the replacement, and links the guide and the tokens', async () => {
  await sendApiDeprecationEmail('anna@example.com', 'Anna', {
    tokenName: 'Home Assistant', routes: ['GET /api/cellars/:id', 'GET /api/stats/value-history'],
    sunset: SUNSET, lastUsedAt: new Date('2026-10-30T09:00:00Z'), reminderDays: [90, 30],
  });

  const msg = sent();
  expect(mockCreate.mock.calls[0][0]).toBe('mg.test');
  expect(msg.to).toEqual(['anna@example.com']);
  expect(msg.subject).toBe('Your API token "Home Assistant" uses routes that stop working on 1 May 2027');
  for (const part of [
    '"Home Assistant"', '- GET /api/cellars/:id', '- GET /api/stats/value-history', '1 May 2027', '403',
    'GET /api/inventory', 'https://cellarion.test/developers', 'https://cellarion.test/settings#api-tokens',
    'called them on 30 October 2026', 'Reminders follow 90 and 30 days before the date',
    'sent whatever your email settings',
  ]) expect(msg.text).toContain(part);
  expect(msg.html).toContain('<code>GET /api/cellars/:id</code>');
  expect(msg.html).toContain('href="https://cellarion.test/developers"');
  expect(msg.html).toContain('href="https://cellarion.test/settings#api-tokens"');
  // A service message: no unsubscribe link to follow.
  expect(msg.text).not.toMatch(/unsubscribe/i);
  // Replies reach a person (a non-hosted install answers with its own From).
  expect(msg['h:Reply-To']).toBe('Cellarion <no-reply@mg.test>');
});

test('a reminder says how many days are left, and that it ends once the token stops', async () => {
  await sendApiDeprecationEmail('anna@example.com', 'Anna', {
    tokenName: 'Home Assistant', routes: ['GET /api/cellars/:id'], sunset: SUNSET, lastUsedAt: new Date('2027-01-30T12:00:00Z'), daysLeft: 90,
  });
  const msg = sent();
  expect(msg.subject).toBe('Reminder: your API token "Home Assistant" uses a route that stops working on 1 May 2027');
  expect(msg.text).toContain('still calls a route that API tokens can no longer use from 1 May 2027, in 90 days:');
  expect(msg.text).toContain('From then on it answers with 403 Forbidden');
  expect(msg.text).toContain('No more reminders come once it stops, or once you revoke it.');
  expect(msg.text).not.toContain('Reminders follow');
});

test("the token's name cannot carry a line break into the subject, and is escaped in the HTML", async () => {
  await sendApiDeprecationEmail('anna@example.com', '<b>Anna</b>', {
    tokenName: 'HA\r\nBcc: someone@else.test <script>', routes: ['GET /api/cellars/:id'], sunset: SUNSET,
  });
  const msg = sent();
  expect(msg.subject).not.toMatch(/[\r\n]/);
  expect(msg.subject).toContain('"HA Bcc: someone@else.test <script>"');
  expect(msg.html).toContain('&lt;b&gt;Anna&lt;/b&gt;');
  expect(msg.html).toContain('HA Bcc: someone@else.test &lt;script&gt;');
  expect(msg.html).not.toContain('<script>');
});

test('SUPPORT_REPLY_TO decides where a reply goes', async () => {
  process.env.SUPPORT_REPLY_TO = 'support@cellarion.test';
  await sendApiDeprecationEmail('anna@example.com', 'Anna', { tokenName: 'HA', routes: ['GET /api/cellars/:id'], sunset: SUNSET });
  expect(sent()['h:Reply-To']).toBe('support@cellarion.test');
});

test('without mail configured, nothing is sent', async () => {
  const saved = process.env.MAILGUN_API_KEY;
  delete process.env.MAILGUN_API_KEY;
  try {
    await jest.isolateModulesAsync(async () => {
      const mail = require('./mailgun');
      expect(mail.EMAIL_VERIFICATION_ENABLED).toBe(false);
      await mail.sendApiDeprecationEmail('anna@example.com', 'Anna', { tokenName: 'HA', routes: ['GET /api/cellars/:id'], sunset: SUNSET });
    });
    expect(mockCreate).not.toHaveBeenCalled();
  } finally {
    process.env.MAILGUN_API_KEY = saved;
  }
});
