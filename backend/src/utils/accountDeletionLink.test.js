/**
 * The "delete my account" email link token (utils/accountDeletionLink).
 *
 * WHY THIS TEST EXISTS:
 * The link lets someone schedule their account's deletion without logging in,
 * so the token must be unforgeable, must expire after 14 days, and must never
 * be interchangeable with the unsubscribe tokens that share the same secret.
 */
process.env.JWT_SECRET = 'test-secret';
process.env.FRONTEND_URL = 'https://cellarion.test/';

const {
  createDeleteAccountToken, verifyDeleteAccountToken, deleteAccountLink, TOKEN_MAX_AGE_MS,
} = require('./accountDeletionLink');
const {
  createUnsubscribeToken, verifyUnsubscribeToken,
  createScopedUnsubscribeToken, verifyScopedUnsubscribeToken,
} = require('./unsubscribe');

const USER = '64b000000000000000000001';

afterEach(() => { jest.useRealTimers(); });

test('a fresh token gives back its user id', () => {
  expect(verifyDeleteAccountToken(createDeleteAccountToken(USER))).toBe(USER);
});

test('the token is refused once 14 days have passed', () => {
  jest.useFakeTimers({ now: new Date('2026-10-01T12:00:00Z') });
  const token = createDeleteAccountToken(USER);
  jest.setSystemTime(new Date('2026-10-01T12:00:00Z').getTime() + TOKEN_MAX_AGE_MS - 1000);
  expect(verifyDeleteAccountToken(token)).toBe(USER);
  jest.setSystemTime(new Date('2026-10-01T12:00:00Z').getTime() + TOKEN_MAX_AGE_MS + 1000);
  expect(verifyDeleteAccountToken(token)).toBeNull();
});

test('a token for one account cannot be edited to point at another', () => {
  const [, ts, purpose, mac] = Buffer.from(createDeleteAccountToken(USER), 'base64url').toString().split(':');
  const forged = Buffer.from(`64b000000000000000000002:${ts}:${purpose}:${mac}`).toString('base64url');
  expect(verifyDeleteAccountToken(forged)).toBeNull();
});

test('garbage, empty and non-string tokens are refused', () => {
  for (const bad of ['', 'not-a-token', null, undefined, 42, {}]) {
    expect(verifyDeleteAccountToken(bad)).toBeNull();
  }
});

test('unsubscribe tokens never work as a delete link', () => {
  expect(verifyDeleteAccountToken(createUnsubscribeToken(USER))).toBeNull();
  expect(verifyDeleteAccountToken(createScopedUnsubscribeToken(USER, 'supportReply'))).toBeNull();
});

test('a delete-link token never works as an unsubscribe token', () => {
  const token = createDeleteAccountToken(USER);
  expect(verifyUnsubscribeToken(token)).toBeNull();
  expect(verifyScopedUnsubscribeToken(token, 'supportReply')).toBeNull();
  expect(verifyScopedUnsubscribeToken(token, 'ownerInquiry')).toBeNull();
});

test('the link opens the confirm page on this site, token encoded', () => {
  const link = deleteAccountLink(USER);
  expect(link.startsWith('https://cellarion.test/delete-account?token=')).toBe(true);
  const token = decodeURIComponent(new URL(link).searchParams.get('token'));
  expect(verifyDeleteAccountToken(token)).toBe(USER);
});
