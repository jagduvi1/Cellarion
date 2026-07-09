/**
 * Tests for the signed unsubscribe token (utils/unsubscribe.js).
 *
 * Covers the 2026-07 hardening (SECURITY_AUDIT_2026-07-08 L-2 + L-3):
 * - full 64-hex HMAC emitted (was truncated to 16 hex / 64 bits)
 * - 90-day expiry enforced on the signed timestamp (was never checked)
 * - strict 3-part token shape
 * - backward compatibility: legacy 16-hex MACs from already-sent emails keep
 *   verifying until the expiry window retires them
 */

process.env.JWT_SECRET = 'test-secret';

const crypto = require('crypto');
const { createUnsubscribeToken, verifyUnsubscribeToken } = require('./unsubscribe');

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

// Build a token the way the server does, with control over timestamp and MAC.
function buildToken(userId, timestamp, mac) {
  return Buffer.from(`${userId}:${timestamp}:${mac}`).toString('base64url');
}

function fullMac(userId, timestamp) {
  return crypto.createHmac('sha256', process.env.JWT_SECRET)
    .update(`${userId}:${timestamp}`)
    .digest('hex');
}

describe('createUnsubscribeToken', () => {
  it('round-trips through verifyUnsubscribeToken', () => {
    const token = createUnsubscribeToken('507f1f77bcf86cd799439011');
    expect(verifyUnsubscribeToken(token)).toBe('507f1f77bcf86cd799439011');
  });

  it('emits the full 64-hex HMAC digest (L-2)', () => {
    const token = createUnsubscribeToken('507f1f77bcf86cd799439011');
    const parts = Buffer.from(token, 'base64url').toString().split(':');
    expect(parts).toHaveLength(3);
    expect(parts[2]).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('verifyUnsubscribeToken — forgery / malformation', () => {
  const userId = '507f1f77bcf86cd799439011';

  it('rejects a tampered MAC', () => {
    const now = Date.now();
    const mac = fullMac(userId, now);
    const flipped = (mac[0] === 'a' ? 'b' : 'a') + mac.slice(1);
    expect(verifyUnsubscribeToken(buildToken(userId, now, flipped))).toBeNull();
  });

  it('rejects a token whose userId was swapped after signing', () => {
    const now = Date.now();
    const mac = fullMac(userId, now);
    expect(verifyUnsubscribeToken(buildToken('507f1f77bcf86cd799439099', now, mac))).toBeNull();
  });

  it('rejects tokens without exactly 3 parts', () => {
    expect(verifyUnsubscribeToken(Buffer.from('justonepart').toString('base64url'))).toBeNull();
    expect(verifyUnsubscribeToken(Buffer.from(`${userId}:${Date.now()}`).toString('base64url'))).toBeNull();
    expect(verifyUnsubscribeToken(Buffer.from(`a:b:c:d`).toString('base64url'))).toBeNull();
  });

  it('rejects garbage input without throwing', () => {
    expect(verifyUnsubscribeToken('')).toBeNull();
    expect(verifyUnsubscribeToken('!!!not-base64url!!!')).toBeNull();
  });

  it('rejects a MAC of the wrong length even if it is a digest prefix', () => {
    const now = Date.now();
    // 32-hex prefix: neither the legacy 16-hex form nor the full 64-hex digest.
    const mac = fullMac(userId, now).slice(0, 32);
    expect(verifyUnsubscribeToken(buildToken(userId, now, mac))).toBeNull();
  });
});

describe('verifyUnsubscribeToken — expiry (L-3)', () => {
  const userId = '507f1f77bcf86cd799439011';

  it('accepts a token just inside the 90-day window', () => {
    const ts = Date.now() - NINETY_DAYS_MS + 60 * 1000;
    expect(verifyUnsubscribeToken(buildToken(userId, ts, fullMac(userId, ts)))).toBe(userId);
  });

  it('rejects a token older than 90 days (valid signature, expired)', () => {
    const ts = Date.now() - NINETY_DAYS_MS - 60 * 1000;
    expect(verifyUnsubscribeToken(buildToken(userId, ts, fullMac(userId, ts)))).toBeNull();
  });

  it('rejects a non-numeric timestamp even with a valid signature over it', () => {
    const ts = 'not-a-number';
    expect(verifyUnsubscribeToken(buildToken(userId, ts, fullMac(userId, ts)))).toBeNull();
  });
});

describe('verifyUnsubscribeToken — legacy 16-hex MAC compatibility (L-2 transition)', () => {
  const userId = '507f1f77bcf86cd799439011';

  it('accepts a fresh legacy token (16-hex digest prefix, as in already-sent emails)', () => {
    const ts = Date.now();
    const legacyMac = fullMac(userId, ts).slice(0, 16);
    expect(verifyUnsubscribeToken(buildToken(userId, ts, legacyMac))).toBe(userId);
  });

  it('rejects a legacy token older than 90 days (expiry retires legacy links)', () => {
    const ts = Date.now() - NINETY_DAYS_MS - 60 * 1000;
    const legacyMac = fullMac(userId, ts).slice(0, 16);
    expect(verifyUnsubscribeToken(buildToken(userId, ts, legacyMac))).toBeNull();
  });

  it('rejects a 16-char MAC that does not match the digest prefix', () => {
    const ts = Date.now();
    expect(verifyUnsubscribeToken(buildToken(userId, ts, '0123456789abcdef'))).toBeNull();
  });

  it('does not treat 16 non-hex chars as a legacy MAC', () => {
    const ts = Date.now();
    expect(verifyUnsubscribeToken(buildToken(userId, ts, 'zzzzzzzzzzzzzzzz'))).toBeNull();
  });
});
