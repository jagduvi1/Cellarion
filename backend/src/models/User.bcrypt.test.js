/**
 * Native bcrypt replaced pure-JS bcryptjs (scaling audit 2026-09-25): hash
 * and compare now run on libuv's thread pool instead of stalling the event
 * loop for every login. Every account's stored password was written by
 * bcryptjs, so these pin that nothing about signing in changes:
 *  - a stored bcryptjs hash ($2a$) verifies, the wrong password does not;
 *  - a password longer than 72 bytes behaves as before (bcrypt only ever
 *    reads the first 72 bytes) — no limit was ever enforced on length;
 *  - a stored value that is not a bcrypt hash (an ephemeral demo account's
 *    unhashed password) compares false instead of throwing;
 *  - the hook hashes at BCRYPT_COST, and the model method uses it end to end.
 * The two hashes below were generated with bcryptjs 2.4.3.
 */
const bcrypt = require('bcrypt');
const User = require('./User');

const STORED = { password: 'Stored-Before-1!', hash: '$2a$10$mIYued6ZQT0NDEZAsp2yg.fl10BCRjpmVb14BjDkOa5UBjWocxJcW' };
const LONG = {
  password: `Long-Pass-1!${'x'.repeat(88)}`, // 100 bytes
  hash: '$2a$10$PW8TDot0hbIGgTfvYNrxyub1PbcOIlPfKJm7v5w7sE476Wadz8xo2',
};

test('a password stored by bcryptjs still verifies, and a wrong one does not', async () => {
  expect(await bcrypt.compare(STORED.password, STORED.hash)).toBe(true);
  expect(await bcrypt.compare('Stored-Before-2!', STORED.hash)).toBe(false);
});

test('over 72 bytes: exactly the old behaviour (only the first 72 bytes count)', async () => {
  expect(await bcrypt.compare(LONG.password, LONG.hash)).toBe(true);
  expect(await bcrypt.compare(`${LONG.password.slice(0, 72)}-another-tail`, LONG.hash)).toBe(true);
  expect(await bcrypt.compare(`${LONG.password.slice(0, 71)}!`, LONG.hash)).toBe(false);
});

test('a stored value that is not a bcrypt hash compares false, not an exception', async () => {
  await expect(bcrypt.compare('anything', 'a-plain-unhashed-demo-password')).resolves.toBe(false);
});

test('comparePassword works on a stored bcryptjs hash and on an SSO-only account', async () => {
  const user = new User({ username: 'anna', email: 'anna@example.com', password: STORED.hash });
  expect(await user.comparePassword(STORED.password)).toBe(true);
  expect(await user.comparePassword('nope')).toBe(false);
  const sso = new User({ username: 'sso', email: 'sso@example.com', authProviders: [{ provider: 'google', providerId: 'g1' }] });
  expect(await sso.comparePassword('anything')).toBe(false);
});

test('new hashes are native $2b$ at BCRYPT_COST', async () => {
  const hash = await bcrypt.hash(STORED.password, await bcrypt.genSalt(User.BCRYPT_COST));
  expect(hash.startsWith(`$2b$${User.BCRYPT_COST}$`)).toBe(true);
  expect(bcrypt.getRounds(hash)).toBe(User.BCRYPT_COST);
  expect(await bcrypt.compare(STORED.password, hash)).toBe(true);
});
