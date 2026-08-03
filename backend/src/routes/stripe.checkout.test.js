/**
 * Race tests for POST /api/stripe/checkout — audit 2026-07-08 finding L-6.
 *
 * WHY THIS TEST EXISTS:
 * On a user's FIRST checkout, stripeCustomerId is null. Two concurrent
 * requests (double-click / two tabs) both used to pass the guard, both
 * customers.create() a separate Stripe customer, and an unconditional
 * findByIdAndUpdate let the last write win — a subscription completed on the
 * overwritten customer became invisible to /portal and immune to the
 * subscription.deleted reconcile (un-cancellable double billing).
 *
 * The fix under test:
 *   1. atomic conditional claim ({_id, stripeCustomerId: null}) so exactly
 *      one request persists its customer; the loser converges on the winner's
 *      customer and best-effort deletes its subscription-less duplicate;
 *   2. the subscriptions.list "hasLive" guard runs before EVERY
 *      sessions.create, not only the existing-customer branch;
 *   3. a user+price+10s-bucket idempotency key on sessions.create so a burst
 *      replays one session instead of minting two.
 *
 * Stripe SDK, User model, auth and audit are all mocked; the real router is
 * mounted and driven over HTTP so the full handler (including the concurrent
 * interleaving) is exercised.
 */

process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
process.env.STRIPE_SUPPORTER_PRICE_ID = 'price_supporter';
process.env.STRIPE_PATRON_PRICE_ID = 'price_patron';
process.env.STRIPE_SUPPORTER_ANNUAL_PRICE_ID = 'price_supporter_year';
// STRIPE_PATRON_ANNUAL_PRICE_ID is deliberately LEFT UNSET — it pins the
// "annual price not configured" branch that a self-hoster with monthly-only
// prices would hit.

// Every request authenticates as the same user — the race is intra-user.
jest.mock('../middleware/auth', () => ({
  requireAuth: (req, res, next) => { req.user = { id: 'u1' }; next(); },
}));

jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));

jest.mock('../models/User', () => ({
  findById: jest.fn(),
  findOneAndUpdate: jest.fn(),
  findByIdAndUpdate: jest.fn(),
}));

// require('stripe')(key) → singleton mock client (getStripe caches it).
const mockStripe = {
  customers: { create: jest.fn(), del: jest.fn() },
  subscriptions: { list: jest.fn() },
  checkout: { sessions: { create: jest.fn() } },
  billingPortal: { sessions: { create: jest.fn() } },
  webhooks: { constructEvent: jest.fn() },
};
jest.mock('stripe', () => jest.fn(() => mockStripe));

const express = require('express');
const http = require('http');
const User = require('../models/User');
const stripeRouter = require('./stripe');

// ── In-memory "User collection" (single doc) with atomic-claim semantics ──
let dbUser;
const resetDb = (overrides = {}) => {
  dbUser = {
    _id: 'u1',
    email: 'u1@example.com',
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    ...overrides,
  };
};

// ── One HTTP server for the suite ──
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

// `interval` omitted entirely when not given, so these calls reproduce an
// older client that only knows about `plan`.
const checkout = (plan = 'supporter', interval) => new Promise((resolve, reject) => {
  const body = JSON.stringify(interval === undefined ? { plan } : { plan, interval });
  const req = http.request({
    port,
    path: '/api/stripe/checkout',
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
  }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }));
  });
  req.on('error', reject);
  req.end(body);
});

// Freeze Date.now so the 10-second idempotency bucket cannot straddle a
// boundary mid-test. (Node's timers use the libuv clock, not Date.now.)
const NOW = 1751000000000;
const BUCKET = Math.floor(NOW / 10_000);
let dateNowSpy;

beforeEach(() => {
  jest.clearAllMocks();
  resetDb();
  dateNowSpy = jest.spyOn(Date, 'now').mockReturnValue(NOW);

  User.findById.mockImplementation(() => ({
    select: jest.fn().mockImplementation(async () => (dbUser ? { ...dbUser } : null)),
  }));
  // The atomic conditional claim: flips null → id for exactly one caller.
  User.findOneAndUpdate.mockImplementation(async (filter, update) => {
    if (!dbUser || filter._id !== dbUser._id) return null;
    if (filter.stripeCustomerId === null && dbUser.stripeCustomerId == null) {
      dbUser.stripeCustomerId = update.stripeCustomerId;
      return { ...dbUser };
    }
    return null;
  });

  mockStripe.subscriptions.list.mockResolvedValue({ data: [] });
  mockStripe.customers.del.mockResolvedValue({ deleted: true });
  mockStripe.checkout.sessions.create.mockResolvedValue({ id: 'cs_1', url: 'https://checkout.stripe.test/cs_1' });
});

afterEach(() => dateNowSpy.mockRestore());

describe('POST /api/stripe/checkout — first-checkout customer race (L-6)', () => {
  test('two concurrent first checkouts converge on ONE persisted customer; the duplicate is deleted', async () => {
    // Barrier inside customers.create: neither call resolves until BOTH
    // requests have read stripeCustomerId === null and asked Stripe for a
    // customer — the exact interleaving of the audit finding.
    let created = 0;
    const release = [];
    mockStripe.customers.create.mockImplementation(() => {
      created += 1;
      const id = `cus_${created}`;
      return new Promise((resolve) => {
        release.push(() => resolve({ id }));
        if (release.length === 2) release.forEach((r) => r());
      });
    });

    const [r1, r2] = await Promise.all([checkout(), checkout()]);

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(mockStripe.customers.create).toHaveBeenCalledTimes(2);

    // Exactly one customer id was claimed on the user…
    const persisted = dbUser.stripeCustomerId;
    expect(['cus_1', 'cus_2']).toContain(persisted);

    // …and BOTH checkout sessions were created against that one customer
    // (the loser converged instead of using its own fresh customer).
    const sessionCustomers = mockStripe.checkout.sessions.create.mock.calls.map(([params]) => params.customer);
    expect(sessionCustomers).toEqual([persisted, persisted]);

    // The losing request deleted its now-orphaned duplicate — and ONLY that one.
    const duplicate = persisted === 'cus_1' ? 'cus_2' : 'cus_1';
    expect(mockStripe.customers.del).toHaveBeenCalledTimes(1);
    expect(mockStripe.customers.del).toHaveBeenCalledWith(duplicate);

    // The hasLive guard ran before EVERY sessions.create, on the converged id.
    expect(mockStripe.subscriptions.list).toHaveBeenCalledTimes(2);
    for (const [args] of mockStripe.subscriptions.list.mock.calls) {
      expect(args.customer).toBe(persisted);
    }

    // Both requests carried the SAME idempotency key (user+price+10s bucket),
    // so Stripe would replay one session rather than mint two.
    const keys = mockStripe.checkout.sessions.create.mock.calls.map(([, opts]) => opts.idempotencyKey);
    expect(keys[0]).toBe(`checkout:u1:price_supporter:${BUCKET}`);
    expect(keys[1]).toBe(keys[0]);
  });

  test('single first checkout creates, atomically claims and uses one customer', async () => {
    mockStripe.customers.create.mockResolvedValue({ id: 'cus_1' });

    const r = await checkout();

    expect(r.status).toBe(200);
    expect(r.body.url).toBe('https://checkout.stripe.test/cs_1');
    expect(dbUser.stripeCustomerId).toBe('cus_1');
    expect(User.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'u1', stripeCustomerId: null },
      { stripeCustomerId: 'cus_1' },
      { new: true }
    );
    expect(mockStripe.customers.del).not.toHaveBeenCalled();
    const [params, opts] = mockStripe.checkout.sessions.create.mock.calls[0];
    expect(params.customer).toBe('cus_1');
    expect(opts).toEqual({ idempotencyKey: `checkout:u1:price_supporter:${BUCKET}` });
  });

  test('hasLive guard now also refuses a live subscription on the just-created-customer path', async () => {
    mockStripe.customers.create.mockResolvedValue({ id: 'cus_1' });
    mockStripe.subscriptions.list.mockResolvedValue({ data: [{ status: 'trialing' }] });

    const r = await checkout();

    expect(r.status).toBe(409);
    expect(r.body.code).toBe('subscription_exists');
    expect(mockStripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  test('existing customer with a live subscription is still refused (guard not regressed)', async () => {
    resetDb({ stripeCustomerId: 'cus_9' });
    mockStripe.subscriptions.list.mockResolvedValue({ data: [{ status: 'canceled' }, { status: 'active' }] });

    const r = await checkout();

    expect(r.status).toBe(409);
    expect(r.body.code).toBe('subscription_exists');
    expect(mockStripe.customers.create).not.toHaveBeenCalled();
    expect(mockStripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  test('a persisted stripeSubscriptionId short-circuits with 409 before touching Stripe', async () => {
    resetDb({ stripeCustomerId: 'cus_9', stripeSubscriptionId: 'sub_1' });

    const r = await checkout();

    expect(r.status).toBe(409);
    expect(mockStripe.customers.create).not.toHaveBeenCalled();
    expect(mockStripe.subscriptions.list).not.toHaveBeenCalled();
  });

  test('a failed duplicate-customer deletion is best-effort and does not block the checkout', async () => {
    mockStripe.customers.create.mockResolvedValue({ id: 'cus_dup' });
    // Simulate losing the race: by the time this request tries to claim,
    // another request has already persisted cus_winner.
    User.findOneAndUpdate.mockImplementation(async () => {
      dbUser.stripeCustomerId = 'cus_winner';
      return null;
    });
    mockStripe.customers.del.mockRejectedValue(new Error('resource_missing'));

    const r = await checkout();

    expect(r.status).toBe(200);
    expect(mockStripe.customers.del).toHaveBeenCalledWith('cus_dup');
    expect(mockStripe.checkout.sessions.create.mock.calls[0][0].customer).toBe('cus_winner');
  });
});

describe('POST /api/stripe/checkout — annual billing interval', () => {
  const sessionParams = () => mockStripe.checkout.sessions.create.mock.calls[0][0];

  test('omitting interval still bills MONTHLY (older clients must not silently switch)', async () => {
    const r = await checkout('supporter');

    expect(r.status).toBe(200);
    expect(sessionParams().line_items).toEqual([{ price: 'price_supporter', quantity: 1 }]);
    expect(sessionParams().subscription_data.metadata.interval).toBe('month');
  });

  test("interval 'year' uses the ANNUAL price while granting the same tier", async () => {
    const r = await checkout('supporter', 'year');

    expect(r.status).toBe(200);
    expect(sessionParams().line_items).toEqual([{ price: 'price_supporter_year', quantity: 1 }]);
    // The tier written to metadata — and therefore applied by the webhook — is
    // still plain 'supporter'. Entitlement must not learn about cadence.
    expect(sessionParams().subscription_data.metadata.plan).toBe('supporter');
    expect(sessionParams().subscription_data.metadata.interval).toBe('year');
  });

  test('monthly and annual carry DIFFERENT idempotency keys in the same 10s bucket', async () => {
    await checkout('supporter', 'month');
    await checkout('supporter', 'year');

    const [k1, k2] = mockStripe.checkout.sessions.create.mock.calls.map(([, o]) => o.idempotencyKey);
    // Same user + same bucket: only the price id separates them. If it didn't,
    // toggling monthly→yearly and clicking would replay the monthly session.
    expect(k1).toBe(`checkout:u1:price_supporter:${BUCKET}`);
    expect(k2).toBe(`checkout:u1:price_supporter_year:${BUCKET}`);
    expect(k1).not.toBe(k2);
  });

  test('an unknown interval is rejected with 400 before Stripe is touched', async () => {
    const r = await checkout('supporter', 'week');

    expect(r.status).toBe(400);
    expect(r.body.error).toBe('Invalid billing interval');
    expect(mockStripe.checkout.sessions.create).not.toHaveBeenCalled();
    expect(mockStripe.customers.create).not.toHaveBeenCalled();
  });

  test('an interval with no configured price 500s instead of falling back to the other cadence', async () => {
    // STRIPE_PATRON_ANNUAL_PRICE_ID is unset (see top of file).
    const r = await checkout('patron', 'year');

    expect(r.status).toBe(500);
    expect(r.body.error).toBe('Stripe price not configured for this plan');
    // Critically: it must NOT have silently billed the monthly patron price.
    expect(mockStripe.checkout.sessions.create).not.toHaveBeenCalled();
  });
});
