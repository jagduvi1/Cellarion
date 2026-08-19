/**
 * Price-ID → tier resolution, exercised through the /availability endpoint and
 * the checkout route because planFromPriceId/priceIdsFor are module-private.
 *
 * The behaviour under test is what keeps a repricing safe. Archiving a Price in
 * Stripe does NOT move existing subscriptions off it — they renew at the old
 * amount indefinitely, and every renewal arrives as a webhook carrying the OLD
 * price id. If that id stops resolving to a tier, the webhook's "maps to no
 * known plan" branch fires and the grandfathered subscriber's plan goes stale.
 * So each price env var takes a comma-separated list: current price first,
 * retired prices after it.
 */

process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
// Supporter carries a RETIRED price alongside the current one — the shape a
// repricing leaves behind.
process.env.STRIPE_SUPPORTER_PRICE_ID = 'price_supporter_new, price_supporter_retired';
process.env.STRIPE_SUPPORTER_ANNUAL_PRICE_ID = 'price_supporter_year_new,price_supporter_year_retired';
process.env.STRIPE_PATRON_PRICE_ID = 'price_patron';
process.env.STRIPE_PATRON_ANNUAL_PRICE_ID = 'price_patron_year';
process.env.STRIPE_BENEFACTOR_PRICE_ID = 'price_benefactor';
// Benefactor's annual price is deliberately UNSET — a half-configured install.

jest.mock('../middleware/auth', () => ({
  requireAuth: (req, res, next) => { req.user = { id: 'u1' }; next(); },
}));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../services/supporterThankYou', () => ({ maybeSendSupporterThankYou: jest.fn() }));
jest.mock('../models/User', () => ({
  findById: jest.fn(),
  findOneAndUpdate: jest.fn(),
  findByIdAndUpdate: jest.fn().mockResolvedValue({}),
}));
jest.mock('stripe', () => jest.fn(() => ({})));

const express = require('express');
const http = require('http');
const User = require('../models/User');
const stripeRouter = require('./stripe');
const { applyStripePlan } = require('./stripe');

// Raw http rather than supertest — it is not a dependency of this project, and
// stripe.checkout.test.js already drives the router this way.
let server;
let port;

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/stripe', stripeRouter);
  server = http.createServer(app);
  server.listen(0, () => { port = server.address().port; done(); });
});

afterAll((done) => {
  server.closeAllConnections?.();
  server.close(() => done()); // swallow close's arg — jest's done() fails on any truthy value
});

const call = (method, path, body) => new Promise((resolve, reject) => {
  const payload = body === undefined ? null : JSON.stringify(body);
  const req = http.request({
    port,
    path,
    method,
    headers: payload
      ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
      : {},
  }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({
      status: res.statusCode,
      body: JSON.parse(Buffer.concat(chunks).toString()),
    }));
  });
  req.on('error', reject);
  req.end(payload);
});

const mockUser = (doc) =>
  User.findById.mockReturnValue({ select: jest.fn().mockResolvedValue(doc) });

beforeEach(() => jest.clearAllMocks());

describe('GET /api/stripe/availability', () => {
  test('reports a configured pair as available and an unconfigured one as not', async () => {
    const r = await call('GET', '/api/stripe/availability');

    expect(r.status).toBe(200);
    expect(r.body.configured).toBe(true);
    expect(r.body.tiers.supporter).toEqual({ month: true, year: true });
    expect(r.body.tiers.patron).toEqual({ month: true, year: true });
    // The page must not render a yearly Benefactor button it cannot complete.
    expect(r.body.tiers.benefactor).toEqual({ month: true, year: false });
  });

  test('never leaks the Price IDs themselves', async () => {
    const r = await call('GET', '/api/stripe/availability');
    expect(JSON.stringify(r.body)).not.toContain('price_');
  });

  test('covers every tier checkout accepts, so no tier can be silently unlisted', async () => {
    const r = await call('GET', '/api/stripe/availability');
    expect(Object.keys(r.body.tiers)).toEqual(['supporter', 'patron', 'benefactor']);
  });
});

describe('checkout tier allowlist', () => {
  const checkout = (plan) => call('POST', '/api/stripe/checkout', { plan, interval: 'month' });

  test('accepts the newest tier — the allowlist is derived, not hand-listed', async () => {
    // Reaching the user lookup proves the plan passed validation; the request
    // then fails for an unrelated reason, which is enough for this assertion.
    mockUser(null);
    User.findById.mockReturnValue({ select: jest.fn().mockResolvedValue(null) });
    const r = await checkout('benefactor');

    expect(r.status).not.toBe(400);
    expect(r.body.error).not.toBe('Invalid plan');
  });

  test('still rejects an unknown tier', async () => {
    const r = await checkout('freeloader');
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('Invalid plan');
  });
});

describe('planFromPriceId — retired prices keep resolving (grandfathering)', () => {
  const { planFromPriceId } = require('./stripe');
  const { PLANS, PLAN_NAMES } = require('../config/plans');

  test('resolves the current price of each tier', () => {
    expect(planFromPriceId('price_supporter_new')).toBe('supporter');
    expect(planFromPriceId('price_patron')).toBe('patron');
    expect(planFromPriceId('price_benefactor')).toBe('benefactor');
  });

  test('resolves a RETIRED price to the same tier as the current one', () => {
    // The regression this guards: a subscriber left on the archived price keeps
    // renewing there forever. If this returned null, every one of their renewal
    // webhooks would hit the "maps to no known plan" branch and their plan would
    // drift out of sync with what they are actually paying.
    expect(planFromPriceId('price_supporter_retired')).toBe('supporter');
    expect(planFromPriceId('price_supporter_year_retired')).toBe('supporter');
  });

  test('tolerates whitespace around the comma', () => {
    // STRIPE_SUPPORTER_PRICE_ID is set with ', ' between ids at the top of file.
    expect(planFromPriceId('price_supporter_retired')).toBe('supporter');
  });

  test('resolves annual and monthly prices to the same tier', () => {
    expect(planFromPriceId('price_patron_year')).toBe('patron');
    expect(planFromPriceId('price_patron')).toBe('patron');
  });

  test('returns null for an unknown or empty price id', () => {
    expect(planFromPriceId('price_never_seen')).toBeNull();
    expect(planFromPriceId('')).toBeNull();
    expect(planFromPriceId(undefined)).toBeNull();
  });

  test('does not match on a prefix — ids must be exact', () => {
    expect(planFromPriceId('price_patron_year_extra')).toBeNull();
    expect(planFromPriceId('price_patr')).toBeNull();
  });

  test('every configured tier exists in the plan config', () => {
    // A tier priced in Stripe but missing from the config would be written to
    // User.plan and rejected by the schema enum.
    for (const tier of ['supporter', 'patron', 'benefactor']) {
      expect(PLAN_NAMES).toContain(tier);
      expect(PLANS[tier].price).toBeGreaterThan(0);
    }
  });

  test('applyStripePlan ranks the new top tier above patron', async () => {
    // PLAN_RANK is derived from config order; if benefactor ranked 0 the guard
    // would treat an upgrade into it as a downgrade and skip the write.
    mockUser({ plan: 'patron', planExpiresAt: null });
    const change = await applyStripePlan('u1', 'benefactor', 'sub_1');

    expect(change).toEqual({ from: 'patron', to: 'benefactor' });
    expect(User.findByIdAndUpdate.mock.calls.at(-1)[1].plan).toBe('benefactor');
  });

  test('an unexpired admin grant of a HIGHER tier still outranks a Stripe downgrade', async () => {
    mockUser({ plan: 'benefactor', planExpiresAt: new Date(Date.now() + 30 * 86400_000) });
    await applyStripePlan('u1', 'supporter', 'sub_1');

    // Grant wins: no plan overwrite, only the subscription id is recorded.
    const update = User.findByIdAndUpdate.mock.calls.at(-1)[1];
    expect(update.plan).toBeUndefined();
    expect(update.stripeSubscriptionId).toBe('sub_1');
  });
});
