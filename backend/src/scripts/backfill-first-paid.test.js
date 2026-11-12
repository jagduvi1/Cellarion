/**
 * scripts/backfill-first-paid — fills User.firstPaidAt from Stripe's invoices
 * for the accounts that paid before the field existed. The User model and the
 * Stripe client are stand-ins; the script's logic is what is tested.
 */
jest.mock('../models/User', () => ({ find: jest.fn(), bulkWrite: jest.fn() }));

const User = require('../models/User');
const { backfillFirstPaid } = require('./backfill-first-paid');

const oid = (c) => c.repeat(24);
const lean = (rows) => ({ lean: () => Promise.resolve(rows) });
const unix = (iso) => Math.floor(new Date(iso).getTime() / 1000);

// A Stripe client whose invoices.list answers per customer, the way the real
// one does: an async iterable over every page.
function stripeWith(invoicesByCustomer) {
  return {
    invoices: {
      list: jest.fn(({ customer }) => {
        const invoices = invoicesByCustomer[customer];
        if (invoices instanceof Error) throw invoices;
        return (async function* pages() { yield* invoices || []; }());
      }),
    },
  };
}

const paid = (iso, amount = 200) => ({ status: 'paid', amount_paid: amount, status_transitions: { paid_at: unix(iso) } });

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  User.bulkWrite.mockImplementation(async (ops) => ({ modifiedCount: ops.length }));
});

afterEach(() => jest.restoreAllMocks());

test('asks only about accounts with a Stripe customer and no firstPaidAt', async () => {
  User.find.mockReturnValue(lean([]));
  await backfillFirstPaid({ stripe: stripeWith({}), apply: true });
  expect(User.find.mock.calls[0][0]).toEqual({ stripeCustomerId: { $ne: null }, firstPaidAt: null });
  expect(User.bulkWrite).not.toHaveBeenCalled();
});

test('the earliest paid invoice above zero is the first payment', async () => {
  User.find.mockReturnValue(lean([{ _id: oid('a'), stripeCustomerId: 'cus_a', stripeSubscriptionId: null }]));
  const stripe = stripeWith({
    cus_a: [paid('2025-06-01T09:00:00Z', 500), paid('2025-02-01T09:00:00Z', 200), paid('2025-04-01T09:00:00Z', 200)],
  });

  const r = await backfillFirstPaid({ stripe, apply: true });

  expect(User.bulkWrite.mock.calls[0][0]).toEqual([
    { updateOne: { filter: { _id: oid('a'), firstPaidAt: null }, update: { $set: { firstPaidAt: new Date('2025-02-01T09:00:00Z') } } } },
  ]);
  expect(r).toEqual({ candidates: 1, paid: 1, current: 0, former: 1, failed: 0, applied: 1 });
});

test('an abandoned checkout (a customer, no paid invoice) is not a payment', async () => {
  User.find.mockReturnValue(lean([
    { _id: oid('a'), stripeCustomerId: 'cus_none', stripeSubscriptionId: null },
    { _id: oid('b'), stripeCustomerId: 'cus_zero', stripeSubscriptionId: null },
  ]));
  const stripe = stripeWith({ cus_none: [], cus_zero: [paid('2025-03-01T00:00:00Z', 0)] });

  const r = await backfillFirstPaid({ stripe, apply: true });

  expect(User.bulkWrite).not.toHaveBeenCalled();
  expect(r).toEqual({ candidates: 2, paid: 0, current: 0, former: 0, failed: 0, applied: 0 });
});

test('counts who still has a subscription apart from who has none', async () => {
  User.find.mockReturnValue(lean([
    { _id: oid('a'), stripeCustomerId: 'cus_a', stripeSubscriptionId: 'sub_live' },
    { _id: oid('b'), stripeCustomerId: 'cus_b', stripeSubscriptionId: null },
    { _id: oid('c'), stripeCustomerId: 'cus_c', stripeSubscriptionId: null },
  ]));
  const stripe = stripeWith({
    cus_a: [paid('2025-05-01T00:00:00Z')], cus_b: [paid('2025-03-01T00:00:00Z')], cus_c: [paid('2025-01-01T00:00:00Z')],
  });

  const r = await backfillFirstPaid({ stripe });

  expect(r).toMatchObject({ paid: 3, current: 1, former: 2 });
});

test('a dry run reads Stripe and writes nothing', async () => {
  User.find.mockReturnValue(lean([{ _id: oid('a'), stripeCustomerId: 'cus_a', stripeSubscriptionId: null }]));

  const r = await backfillFirstPaid({ stripe: stripeWith({ cus_a: [paid('2025-03-01T00:00:00Z')] }) });

  expect(User.bulkWrite).not.toHaveBeenCalled();
  expect(r).toMatchObject({ paid: 1, applied: 0 });
});

test('an account Stripe cannot answer for is skipped and the rest still written', async () => {
  User.find.mockReturnValue(lean([
    { _id: oid('a'), stripeCustomerId: 'cus_gone', stripeSubscriptionId: null },
    { _id: oid('b'), stripeCustomerId: 'cus_b', stripeSubscriptionId: null },
  ]));
  const stripe = stripeWith({ cus_gone: new Error('No such customer'), cus_b: [paid('2025-03-01T00:00:00Z')] });

  const r = await backfillFirstPaid({ stripe, apply: true });

  expect(User.bulkWrite.mock.calls[0][0].map((o) => o.updateOne.filter._id)).toEqual([oid('b')]);
  expect(r).toEqual({ candidates: 2, paid: 1, current: 0, former: 1, failed: 1, applied: 1 });
});
