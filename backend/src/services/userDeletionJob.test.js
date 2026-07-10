/**
 * Guards the GDPR user-deletion job invariants:
 *  - only users whose cooling-off period has expired are selected;
 *  - a Stripe failure never blocks the account erasure;
 *  - one user's purge failure never aborts the rest of the batch;
 *  - the User doc is only deleted AFTER the data purge succeeded.
 */
jest.mock('../models/User', () => ({
  find: jest.fn(),
  deleteOne: jest.fn(),
}));
jest.mock('./userDataRegistry', () => ({
  purgeUserData: jest.fn(),
}));
jest.mock('stripe', () => {
  const mockCustomersDel = jest.fn();
  const factory = jest.fn(() => ({ customers: { del: mockCustomersDel } }));
  factory.mockCustomersDel = mockCustomersDel;
  return factory;
});

const User = require('../models/User');
const { purgeUserData } = require('./userDataRegistry');
const stripeFactory = require('stripe');
const stripeDel = stripeFactory.mockCustomersDel;
const { runUserDeletionJob } = require('./userDeletionJob');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function mockUsersToDelete(users) {
  User.find.mockReturnValue({
    select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(users) }),
  });
}

const savedStripeKey = process.env.STRIPE_SECRET_KEY;
let logSpy, errorSpy;

beforeEach(() => {
  jest.clearAllMocks();
  process.env.STRIPE_SECRET_KEY = 'sk_test_123';
  purgeUserData.mockResolvedValue();
  stripeDel.mockResolvedValue({});
  User.deleteOne.mockResolvedValue({ deletedCount: 1 });
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  if (savedStripeKey === undefined) delete process.env.STRIPE_SECRET_KEY;
  else process.env.STRIPE_SECRET_KEY = savedStripeKey;
  logSpy.mockRestore();
  errorSpy.mockRestore();
});

// ─── runUserDeletionJob ──────────────────────────────────────────────────────

describe('runUserDeletionJob', () => {
  test('selects only users whose deletionScheduledFor is due and non-null', async () => {
    mockUsersToDelete([]);

    const before = Date.now();
    await runUserDeletionJob();
    const after = Date.now();

    expect(User.find).toHaveBeenCalledTimes(1);
    const [filter] = User.find.mock.calls[0];
    expect(Object.keys(filter)).toEqual(['deletionScheduledFor']);
    expect(filter.deletionScheduledFor.$ne).toBeNull();
    // $lte is "now" — a user scheduled for the future must NOT be selected
    expect(filter.deletionScheduledFor.$lte).toBeInstanceOf(Date);
    expect(filter.deletionScheduledFor.$lte.getTime()).toBeGreaterThanOrEqual(before);
    expect(filter.deletionScheduledFor.$lte.getTime()).toBeLessThanOrEqual(after);
    // Only the fields the job needs are fetched (data minimisation)
    expect(User.find.mock.results[0].value.select).toHaveBeenCalledWith('_id email stripeCustomerId');
  });

  test('does nothing when no deletions are due', async () => {
    mockUsersToDelete([]);

    await runUserDeletionJob();

    expect(purgeUserData).not.toHaveBeenCalled();
    expect(User.deleteOne).not.toHaveBeenCalled();
    expect(stripeDel).not.toHaveBeenCalled();
  });

  test('purges data, deletes the Stripe customer, then deletes the user doc', async () => {
    mockUsersToDelete([{ _id: 'u1', email: 'a@x.com', stripeCustomerId: 'cus_1' }]);

    await runUserDeletionJob();

    expect(purgeUserData).toHaveBeenCalledWith('u1', 'a@x.com');
    expect(stripeDel).toHaveBeenCalledWith('cus_1');
    expect(User.deleteOne).toHaveBeenCalledWith({ _id: 'u1' });

    // The user doc is removed only AFTER the purge (deleting it first would
    // orphan the linked data if the purge failed).
    const purgeOrder = purgeUserData.mock.invocationCallOrder[0];
    const deleteOrder = User.deleteOne.mock.invocationCallOrder[0];
    expect(purgeOrder).toBeLessThan(deleteOrder);
  });

  test('a Stripe deletion failure does NOT block the user deletion', async () => {
    mockUsersToDelete([{ _id: 'u1', email: 'a@x.com', stripeCustomerId: 'cus_1' }]);
    stripeDel.mockRejectedValue(new Error('stripe down'));

    await expect(runUserDeletionJob()).resolves.toBeUndefined();

    expect(User.deleteOne).toHaveBeenCalledWith({ _id: 'u1' });
  });

  test('skips Stripe entirely when the user has no customer id', async () => {
    mockUsersToDelete([{ _id: 'u1', email: 'a@x.com' }]);

    await runUserDeletionJob();

    expect(stripeDel).not.toHaveBeenCalled();
    expect(User.deleteOne).toHaveBeenCalledWith({ _id: 'u1' });
  });

  test('skips Stripe when STRIPE_SECRET_KEY is not configured', async () => {
    delete process.env.STRIPE_SECRET_KEY;
    mockUsersToDelete([{ _id: 'u1', email: 'a@x.com', stripeCustomerId: 'cus_1' }]);

    await runUserDeletionJob();

    expect(stripeDel).not.toHaveBeenCalled();
    expect(User.deleteOne).toHaveBeenCalledWith({ _id: 'u1' });
  });

  test('one user\'s purge failure does not abort the batch — the next user is still processed', async () => {
    mockUsersToDelete([
      { _id: 'u1', email: 'a@x.com' },
      { _id: 'u2', email: 'b@x.com' },
    ]);
    purgeUserData
      .mockRejectedValueOnce(new Error('purge exploded'))
      .mockResolvedValueOnce();

    await expect(runUserDeletionJob()).resolves.toBeUndefined();

    expect(purgeUserData).toHaveBeenCalledTimes(2);
    expect(purgeUserData).toHaveBeenNthCalledWith(1, 'u1', 'a@x.com');
    expect(purgeUserData).toHaveBeenNthCalledWith(2, 'u2', 'b@x.com');
    // u1 failed before its doc deletion; u2 completed
    expect(User.deleteOne).toHaveBeenCalledTimes(1);
    expect(User.deleteOne).toHaveBeenCalledWith({ _id: 'u2' });
    expect(errorSpy).toHaveBeenCalled();
  });
});
