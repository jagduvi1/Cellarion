/**
 * Who signs the supporter thank-you, which is written in the first person.
 *
 * The code is shared by every install, so the signature is the install's to
 * set: SUPPORT_SIGNATURE when given, else the display name of MAILGUN_FROM,
 * else "Cellarion". Never a person's name by default. MAILGUN_FROM is read
 * when the module loads, so each case loads it fresh.
 */
process.env.MAILGUN_API_KEY = 'key-test';
process.env.MAILGUN_DOMAIN = 'mg.example.org';

const mockCreate = jest.fn(async () => ({ id: 'msg-1' }));
jest.mock('mailgun.js', () => jest.fn().mockImplementation(() => ({
  client: () => ({ messages: { create: (...args) => mockCreate(...args) } }),
})));
jest.mock('../utils/unsubscribe', () => ({
  createUnsubscribeToken: (id) => `tok-${id}`,
  createScopedUnsubscribeToken: (id, scope) => `stok-${scope}-${id}`,
}));

const ENV_KEYS = ['FRONTEND_URL', 'MAILGUN_FROM', 'SUPPORT_SIGNATURE'];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
});

/** The thank-you's text and html, with the module loaded under `env`. */
async function thankYou(env) {
  for (const k of ENV_KEYS) {
    if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k];
  }
  mockCreate.mockClear();
  let msg;
  await jest.isolateModulesAsync(async () => {
    const mail = require('./mailgun');
    await mail.sendSupporterThankYou('anna@example.com', 'Anna', 'supporter');
    msg = mockCreate.mock.calls[0][1];
  });
  return msg;
}

const lastLine = (text) => text.trim().split('\n').at(-1);

test('SUPPORT_SIGNATURE signs the text and the html, escaped', async () => {
  const msg = await thankYou({ FRONTEND_URL: 'https://wine.example.org', MAILGUN_FROM: 'Our Cellar <help@example.org>', SUPPORT_SIGNATURE: ' Maria & Co ' });
  expect(lastLine(msg.text)).toBe('Maria & Co');
  expect(msg.html).toContain('<p>Maria &amp; Co</p>');
});

test('without it, the display name of MAILGUN_FROM signs', async () => {
  const msg = await thankYou({ FRONTEND_URL: 'https://wine.example.org', MAILGUN_FROM: 'Our Cellar <help@example.org>' });
  expect(lastLine(msg.text)).toBe('Our Cellar');
  expect(msg.html).toContain('<p>Our Cellar</p>');
});

test('with neither, and with a bare address as From, it is "Cellarion"; the hosted install gets no special name', async () => {
  expect(lastLine((await thankYou({ FRONTEND_URL: 'http://localhost' })).text)).toBe('Cellarion');
  expect(lastLine((await thankYou({ FRONTEND_URL: 'https://wine.example.org', MAILGUN_FROM: '<help@example.org>' })).text)).toBe('Cellarion');
  expect(lastLine((await thankYou({ FRONTEND_URL: 'https://cellarion.app' })).text)).toBe('Cellarion');
});
