/**
 * services/mailgun sendAiCapAlertEmail: the warning before the site-wide
 * daily AI cap switches AI off for everyone (services/aiCapAlertJob).
 *
 * WHY THIS TEST EXISTS:
 * The email has to say how close the cap is, what happens at the cap, when the
 * count resets, where to raise the cap, and which accounts are behind most of
 * today's calls, so the admin can tell abuse from growth without logging in.
 */
process.env.MAILGUN_API_KEY = 'key-test';
process.env.MAILGUN_DOMAIN = 'mg.test';
process.env.FRONTEND_URL = 'https://cellarion.test';

const mockCreate = jest.fn(async () => ({ id: 'msg-1' }));
jest.mock('mailgun.js', () => jest.fn().mockImplementation(() => ({
  client: () => ({ messages: { create: (...args) => mockCreate(...args) } }),
})));

const { sendAiCapAlertEmail } = require('./mailgun');

beforeEach(() => mockCreate.mockClear());

const sent = () => mockCreate.mock.calls[0][1];

test('80%: the count, the cap, the reset time, where to raise it and the top accounts', async () => {
  await sendAiCapAlertEmail('admin@example.com', {
    pct: 80, count: 16000, cap: 20000, resetsInSeconds: 5 * 3600 + 30 * 60,
    topAi: [{ userId: 'aaa111', count: 9000 }], topChat: [],
  });

  const msg = sent();
  expect(msg.to).toEqual(['admin@example.com']);
  expect(msg.subject).toBe("Cellarion AI: 80% of today's AI cap used (16000 of 20000 calls)");
  expect(msg.text).toContain('switches off for everyone until 00:00 UTC');
  expect(msg.text).toContain('resets in 5 h 30 min');
  expect(msg.text).toContain('SuperAdmin → Settings → AI daily budget (spend cap) → Site-wide daily kill-switch');
  expect(msg.text).toContain('user aaa111: 9000');
  expect(msg.text).toMatch(/Most chat questions today:\nnone/);
  expect(msg.text).toContain('https://cellarion.test/super-admin');
  expect(msg.html).toContain('<li>user aaa111: 9000</li>');
});

test('100%: says AI is off now', async () => {
  await sendAiCapAlertEmail('admin@example.com', {
    pct: 100, count: 20000, cap: 20000, resetsInSeconds: 60, topAi: [], topChat: [],
  });
  expect(sent().subject).toBe("Cellarion AI: today's cap is reached, AI is off for everyone until 00:00 UTC");
  expect(sent().text).toContain('are off for everyone until the count resets at 00:00 UTC, in 0 h 1 min');
});

test('top AI accounts not tracked (per-user budget unlimited) says so', async () => {
  await sendAiCapAlertEmail('admin@example.com', { pct: 50, count: 10000, cap: 20000, resetsInSeconds: 3600, topAi: null, topChat: [] });
  expect(sent().text).toContain('Most AI calls today (scans, imports, wine info):\nnot tracked (the per-user AI budget is unlimited)');
});
