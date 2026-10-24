/**
 * services/mailgun sendCellarInviteEmail: the invitation a member sends when
 * they share a cellar with someone who has no account yet.
 *
 * WHY THIS TEST EXISTS:
 * The shared cellar only exists on the instance that sent the invite, so every
 * link in the mail must lead there. The Google Play app is bound to the hosted
 * cellarion.app, so only the hosted service may offer it; a self-hosted
 * instance links its own origin instead. The cellar name is user text and
 * must be escaped in the HTML.
 */
process.env.MAILGUN_API_KEY = 'key-test';
process.env.MAILGUN_DOMAIN = 'mg.test';

const mockCreate = jest.fn(async () => ({ id: 'msg-1' }));
jest.mock('mailgun.js', () => jest.fn().mockImplementation(() => ({
  client: () => ({ messages: { create: (...args) => mockCreate(...args) } }),
})));

const { sendCellarInviteEmail } = require('./mailgun');

const savedFrontendUrl = process.env.FRONTEND_URL;
beforeEach(() => { mockCreate.mockClear(); });
afterAll(() => {
  if (savedFrontendUrl === undefined) delete process.env.FRONTEND_URL;
  else process.env.FRONTEND_URL = savedFrontendUrl;
});

async function invite(frontendUrl, cellarName = 'Home') {
  if (frontendUrl === undefined) delete process.env.FRONTEND_URL;
  else process.env.FRONTEND_URL = frontendUrl;
  await sendCellarInviteEmail('new@example.com', 'Anna', 'anna@example.com', cellarName, 'viewer');
  return mockCreate.mock.calls[0][1];
}

test('a self-hosted instance links only itself: no Google Play, no cellarion.app', async () => {
  const msg = await invite('https://cellarion.test');

  expect(msg.text).toContain('https://cellarion.test/register');
  expect(msg.text).toContain('Or visit our website: https://cellarion.test');
  expect(msg.html).toContain('href="https://cellarion.test/register"');
  expect(msg.html).toContain('href="https://cellarion.test"');
  expect(msg.html).toContain('Open Cellarion');
  for (const body of [msg.text, msg.html]) {
    expect(body).not.toContain('play.google.com');
    expect(body).not.toContain('Google Play');
    expect(body).not.toContain('cellarion.app');
  }
});

test('an instance without FRONTEND_URL links its local origin, never the hosted service', async () => {
  const msg = await invite(undefined);

  expect(msg.text).toContain('Or visit our website: http://localhost:3000');
  expect(msg.html).toContain('href="http://localhost:3000"');
  for (const body of [msg.text, msg.html]) {
    expect(body).not.toContain('play.google.com');
    expect(body).not.toContain('cellarion.app');
  }
});

test('the hosted service offers Google Play and links cellarion.app', async () => {
  const msg = await invite('https://cellarion.app');
  const play = 'https://play.google.com/store/apps/details?id=app.cellarion.twa';

  expect(msg.text).toContain(`You can also get Cellarion on Google Play:\n${play}\n`);
  expect(msg.text).toContain('Or visit our website: https://cellarion.app');
  expect(msg.text).toContain('https://cellarion.app/register');
  expect(msg.html).toContain(`<a href="${play}" style="color:#7B9E88;font-weight:600;">Get it on Google Play</a>`);
  expect(msg.html).toContain('<a href="https://cellarion.app" style="color:#7B9E88;font-weight:600;">Visit cellarion.app</a>');
});

test('the cellar name is escaped in the HTML', async () => {
  const msg = await invite('https://cellarion.test', 'Mine <b>& yours</b>');

  expect(msg.html).toContain('&ldquo;Mine &lt;b&gt;&amp; yours&lt;/b&gt;&rdquo;');
  expect(msg.html).not.toContain('<b>&');
});
