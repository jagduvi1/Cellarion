/**
 * services/mailgun sendSupportReplyEmail: support's answer, by email.
 *
 * WHY THIS TEST EXISTS:
 * Until 2026-09-26 an answer to a support ticket only reached the in-app
 * bell, so someone who asked and left never saw it. The email carries the
 * answer itself, a link back to the ticket, a Reply-To that reaches a person,
 * and the one-click unsubscribe. The ticket subject is user text, so it must
 * not be able to break out of its header, and user text in the HTML is escaped.
 */
process.env.MAILGUN_API_KEY = 'key-test';
process.env.MAILGUN_DOMAIN = 'mg.test';
process.env.FRONTEND_URL = 'https://cellarion.test';

const mockCreate = jest.fn(async () => ({ id: 'msg-1' }));
jest.mock('mailgun.js', () => jest.fn().mockImplementation(() => ({
  client: () => ({ messages: { create: (...args) => mockCreate(...args) } }),
})));
jest.mock('../utils/unsubscribe', () => ({ createUnsubscribeToken: (id) => `tok-${id}` }));

const { sendSupportReplyEmail } = require('./mailgun');

beforeEach(() => {
  mockCreate.mockClear();
  delete process.env.SUPPORT_REPLY_TO;
});

const sent = () => mockCreate.mock.calls[0];

test('sends the answer itself, a link back to the ticket, a Reply-To and the unsubscribe link', async () => {
  await sendSupportReplyEmail('anna@example.com', 'Anna', 'u1', 'Import from CellarTracker?', 'Yes, it can.\n1. Create a cellar.');

  const [domain, msg] = sent();
  expect(domain).toBe('mg.test');
  expect(msg.to).toEqual(['anna@example.com']);
  expect(msg.subject).toBe('Reply to your support ticket: Import from CellarTracker?');
  expect(msg['h:Reply-To']).toBe('info@cellarion.app');
  expect(msg.text).toContain('Yes, it can.\n1. Create a cellar.');
  expect(msg.text).toContain('https://cellarion.test/support');
  expect(msg.text).toContain('https://cellarion.test/api/users/unsubscribe?token=tok-u1');
  expect(msg.html).toContain('Yes, it can.<br>1. Create a cellar.');
  expect(msg.html).toContain('href="https://cellarion.test/api/users/unsubscribe?token=tok-u1"');
});

test("a subject can't carry a line break into the header, and user text is escaped in the HTML", async () => {
  await sendSupportReplyEmail('anna@example.com', '<b>Anna</b>', 'u1', 'Help\r\nBcc: someone@else.test', 'Use <script>x</script> nowhere');

  const [, msg] = sent();
  expect(msg.subject).not.toMatch(/[\r\n]/);
  expect(msg.subject).toBe('Reply to your support ticket: Help Bcc: someone@else.test');
  expect(msg.html).toContain('&lt;b&gt;Anna&lt;/b&gt;');
  expect(msg.html).toContain('Use &lt;script&gt;x&lt;/script&gt; nowhere');
  expect(msg.html).not.toContain('<script>');
});

test('SUPPORT_REPLY_TO sets where an answered email goes', async () => {
  process.env.SUPPORT_REPLY_TO = 'support@cellarion.test';
  await sendSupportReplyEmail('anna@example.com', 'Anna', 'u1', 'Question', 'Answer');
  expect(sent()[1]['h:Reply-To']).toBe('support@cellarion.test');
});

test('without mail configured, nothing is sent', async () => {
  const saved = process.env.MAILGUN_API_KEY;
  delete process.env.MAILGUN_API_KEY;
  try {
    await jest.isolateModulesAsync(async () => {
      const mail = require('./mailgun');
      expect(mail.EMAIL_VERIFICATION_ENABLED).toBe(false);
      await mail.sendSupportReplyEmail('anna@example.com', 'Anna', 'u1', 'Question', 'Answer');
    });
    expect(mockCreate).not.toHaveBeenCalled();
  } finally {
    process.env.MAILGUN_API_KEY = saved;
  }
});
