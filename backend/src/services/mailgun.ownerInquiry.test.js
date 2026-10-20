/**
 * services/mailgun sendOwnerInquiryEmail: a curator's question, by email.
 *
 * WHY THIS TEST EXISTS:
 * Until 2026-10-20 a question to a wine's owners reached the in-app bell and
 * push only, and none of 64 open questions had an answer. The email carries
 * the question itself (so the owner can read the label first), a button to
 * the question in the app, a Reply-To that reaches a person, a one-click stop
 * for these questions only, and the unsubscribe-all link. The wine label is
 * registry text and must not break out of its header; text in the HTML is
 * escaped.
 */
process.env.MAILGUN_API_KEY = 'key-test';
process.env.MAILGUN_DOMAIN = 'mg.test';
process.env.FRONTEND_URL = 'https://cellarion.test';

const mockCreate = jest.fn(async () => ({ id: 'msg-1' }));
jest.mock('mailgun.js', () => jest.fn().mockImplementation(() => ({
  client: () => ({ messages: { create: (...args) => mockCreate(...args) } }),
})));
jest.mock('../utils/unsubscribe', () => ({
  createUnsubscribeToken: (id) => `tok-${id}`,
  createScopedUnsubscribeToken: (id, scope) => `stok-${scope}-${id}`,
}));

const { sendOwnerInquiryEmail } = require('./mailgun');

beforeEach(() => {
  mockCreate.mockClear();
  delete process.env.SUPPORT_REPLY_TO;
});

const sent = () => mockCreate.mock.calls[0];
const QUESTION = 'Does your label print the word "Réserve"?\nOne word settles it.';

test('sends the question itself, a button to it in the app and a Reply-To that reaches a person', async () => {
  await sendOwnerInquiryEmail('anna@example.com', 'Anna', 'u1', 'Domaine Exemple — Cuvée Test', QUESTION, '/questions/q1');

  const [domain, msg] = sent();
  expect(domain).toBe('mg.test');
  expect(msg.to).toEqual(['anna@example.com']);
  expect(msg.subject).toBe('A question about your Domaine Exemple — Cuvée Test');
  expect(msg['h:Reply-To']).toBe('info@cellarion.app');
  expect(msg.text).toContain(QUESTION);
  expect(msg.text).toContain('https://cellarion.test/questions/q1');
  expect(msg.html).toContain('Does your label print the word &quot;Réserve&quot;?<br>One word settles it.');
  expect(msg.html).toContain('href="https://cellarion.test/questions/q1"');
});

test('offers a one-click stop for these questions only, the email settings and unsubscribe-all', async () => {
  await sendOwnerInquiryEmail('anna@example.com', 'Anna', 'u1', 'Wine', QUESTION, '/questions/q1');
  const [, msg] = sent();
  const stop = 'https://cellarion.test/api/users/unsubscribe/owner-questions?token=stok-ownerInquiry-u1';
  const settings = 'https://cellarion.test/settings#notifications';
  const all = 'https://cellarion.test/api/users/unsubscribe?token=tok-u1';
  for (const link of [stop, settings, all]) {
    expect(msg.text).toContain(link);
    expect(msg.html).toContain(`href="${link}"`);
  }
});

test("a wine label can't carry a line break into the header, and text is escaped in the HTML", async () => {
  await sendOwnerInquiryEmail('anna@example.com', '<b>Anna</b>', 'u1', 'Pira\r\nBcc: someone@else.test', 'Is it <script>x</script>?', '/questions/q1');

  const [, msg] = sent();
  expect(msg.subject).not.toMatch(/[\r\n]/);
  expect(msg.subject).toBe('A question about your Pira Bcc: someone@else.test');
  expect(msg.html).toContain('&lt;b&gt;Anna&lt;/b&gt;');
  expect(msg.html).toContain('Is it &lt;script&gt;x&lt;/script&gt;?');
  expect(msg.html).not.toContain('<script>');
});

test('SUPPORT_REPLY_TO sets where an answered email goes', async () => {
  process.env.SUPPORT_REPLY_TO = 'support@cellarion.test';
  await sendOwnerInquiryEmail('anna@example.com', 'Anna', 'u1', 'Wine', QUESTION, '/questions/q1');
  expect(sent()[1]['h:Reply-To']).toBe('support@cellarion.test');
});
