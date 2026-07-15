/**
 * Guards the ephemeral demo User shape. The password-complexity validator runs at
 * pre-validate — BEFORE the pre-save hook swaps in the demo sentinel — so the
 * password createDemoAccount constructs must itself be complexity-valid. An
 * all-hex random string is NOT (no uppercase, no special char) and 500s
 * demo-login; this regression guards the "Aa1!" + hex shape.
 *
 * Uses the REAL User model (no mock) so validators actually run.
 */
const crypto = require('crypto');
const User = require('../models/User');

describe('ephemeral demo User shape', () => {
  test('the demo password shape (Aa1! + hex) passes schema validation', () => {
    const rand = crypto.randomBytes(8).toString('hex');
    const user = new User({
      username: `demo-${rand}`,
      email: `demo-${rand}@demo.cellarion.invalid`,
      password: 'Aa1!' + crypto.randomBytes(24).toString('hex'),
      roles: ['user'],
      emailVerified: true,
      isDemo: true,
      demoExpiresAt: new Date(),
    });
    expect(user.validateSync()).toBeUndefined();
  });

  test('a plain-hex password FAILS validation (documents the fixed bug)', () => {
    const user = new User({
      username: 'demo-x',
      email: 'demo-x@demo.cellarion.invalid',
      password: crypto.randomBytes(24).toString('hex'), // no uppercase / special char
      roles: ['user'],
      isDemo: true,
    });
    const err = user.validateSync();
    expect(err).toBeDefined();
    expect(err.errors.password).toBeDefined();
  });
});
