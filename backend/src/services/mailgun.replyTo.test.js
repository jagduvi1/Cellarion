/**
 * Where a reply goes when someone answers one of the emails that promise a
 * person reads it: a support answer, or the supporter thank-you.
 *
 * SUPPORT_REPLY_TO decides when the install sets it. Without it, only the
 * hosted cellarion.app uses the hosted inbox; any other install answers with
 * its own From address, so its users' replies never reach a third party.
 * MAILGUN_FROM is read when the module loads, so each case loads it fresh.
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

const ENV_KEYS = ['FRONTEND_URL', 'MAILGUN_FROM', 'SUPPORT_REPLY_TO'];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
});

/** Reply-To of each sender, with the module loaded under `env`. */
async function replyTos(env) {
  for (const k of ENV_KEYS) {
    if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k];
  }
  mockCreate.mockClear();
  let out;
  await jest.isolateModulesAsync(async () => {
    const mail = require('./mailgun');
    await mail.sendSupportReplyEmail('anna@example.com', 'Anna', 'u1', 'Question', 'Answer');
    await mail.sendSupporterThankYou('anna@example.com', 'Anna', 'supporter');
    out = mockCreate.mock.calls.map(([, msg]) => msg['h:Reply-To']);
  });
  return { supportAnswer: out[0], thankYou: out[1] };
}

test('a self-hosted install without SUPPORT_REPLY_TO uses its own MAILGUN_FROM, never the hosted inbox', async () => {
  const r = await replyTos({ FRONTEND_URL: 'https://wine.example.org', MAILGUN_FROM: 'Our Cellar <help@example.org>' });
  expect(r).toEqual({ supportAnswer: 'Our Cellar <help@example.org>', thankYou: 'Our Cellar <help@example.org>' });
});

test('a self-hosted install with neither set answers with its own From (the no-reply default on its domain)', async () => {
  const r = await replyTos({ FRONTEND_URL: 'http://localhost' });
  expect(r).toEqual({ supportAnswer: 'Cellarion <no-reply@mg.example.org>', thankYou: 'Cellarion <no-reply@mg.example.org>' });
});

test('the hosted cellarion.app keeps the hosted inbox', async () => {
  const r = await replyTos({ FRONTEND_URL: 'https://cellarion.app' });
  expect(r).toEqual({ supportAnswer: 'info@cellarion.app', thankYou: 'info@cellarion.app' });
});

test('SUPPORT_REPLY_TO wins on any install', async () => {
  const self = await replyTos({ FRONTEND_URL: 'https://wine.example.org', MAILGUN_FROM: 'Our Cellar <help@example.org>', SUPPORT_REPLY_TO: 'team@example.org' });
  expect(self).toEqual({ supportAnswer: 'team@example.org', thankYou: 'team@example.org' });
  const hosted = await replyTos({ FRONTEND_URL: 'https://cellarion.app', SUPPORT_REPLY_TO: 'team@example.org' });
  expect(hosted).toEqual({ supportAnswer: 'team@example.org', thankYou: 'team@example.org' });
});
