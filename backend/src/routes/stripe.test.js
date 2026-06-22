// Unit tests for applyStripePlan — the helper behind the Stripe webhook handlers.
// Mock the User model so we can assert the exact { plan, planExpiresAt, ... }
// write without a live MongoDB. PLAN_RANK (utils/cellarCred) is used for real.
jest.mock('../models/User', () => ({
  findById: jest.fn(),
  findByIdAndUpdate: jest.fn().mockResolvedValue({}),
}));

const User = require('../models/User');
const { applyStripePlan } = require('./stripe');

// applyStripePlan does `User.findById(id).select('plan planExpiresAt')`.
const mockUser = (doc) =>
  User.findById.mockReturnValue({ select: jest.fn().mockResolvedValue(doc) });

// Grab the update object passed to findByIdAndUpdate.
const capturedUpdate = () => User.findByIdAndUpdate.mock.calls.at(-1)[1];

const future = () => new Date(Date.now() + 30 * 86400_000);
const past = () => new Date(Date.now() - 86400_000);

beforeEach(() => jest.clearAllMocks());

describe('applyStripePlan', () => {
  test('HONOURS a Stripe-only paid downgrade (patron → supporter)', async () => {
    // The regression: previously the rank guard silently dropped every downgrade,
    // leaving the user on patron after they switched to (and only pay for) supporter.
    mockUser({ plan: 'patron', planExpiresAt: null });
    const change = await applyStripePlan('u1', 'supporter', 'sub_123');

    const update = capturedUpdate();
    expect(update.plan).toBe('supporter');
    expect(update.planExpiresAt).toBeNull();
    expect(update.stripeSubscriptionId).toBe('sub_123');
    expect(change).toEqual({ from: 'patron', to: 'supporter' });
  });

  test('applies an upgrade from free → supporter', async () => {
    mockUser({ plan: 'free', planExpiresAt: null });
    await applyStripePlan('u1', 'supporter', 'sub_123');
    expect(capturedUpdate().plan).toBe('supporter');
  });

  test('does NOT downgrade an active, higher time-limited grant (admin/Cellar-Cred)', async () => {
    // A future planExpiresAt marks a non-Stripe grant; a lower Stripe plan must
    // not clobber it, but the subscription id is still recorded.
    mockUser({ plan: 'patron', planExpiresAt: future() });
    const change = await applyStripePlan('u1', 'supporter', 'sub_123');

    const update = capturedUpdate();
    expect(update.plan).toBeUndefined();        // plan left untouched
    expect(update.stripeSubscriptionId).toBe('sub_123');
    expect(change).toEqual({ from: 'patron', to: 'patron' });
  });

  test('applies the Stripe plan once a time-limited grant has expired', async () => {
    mockUser({ plan: 'patron', planExpiresAt: past() });
    await applyStripePlan('u1', 'supporter', 'sub_123');
    const update = capturedUpdate();
    expect(update.plan).toBe('supporter');
    expect(update.planExpiresAt).toBeNull();
  });

  test('an upgrade still wins over a lower active grant (supporter grant → patron sub)', async () => {
    mockUser({ plan: 'supporter', planExpiresAt: future() });
    await applyStripePlan('u1', 'patron', 'sub_123');
    expect(capturedUpdate().plan).toBe('patron');
  });

  test('returns null and writes nothing when the user is gone', async () => {
    mockUser(null);
    const change = await applyStripePlan('u1', 'supporter', 'sub_123');
    expect(change).toBeNull();
    expect(User.findByIdAndUpdate).not.toHaveBeenCalled();
  });
});
