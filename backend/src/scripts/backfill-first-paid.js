/**
 * One-time backfill: fill User.firstPaidAt for the accounts that paid for
 * support before the field existed, from Stripe's invoices.
 *
 * Per account with a Stripe customer and no firstPaidAt: the moment its
 * earliest paid invoice with an amount above zero was paid. A customer record
 * alone proves nothing (Stripe creates it when a checkout opens), so an
 * account whose customer has no such invoice is left alone.
 *
 * Only rows still without a value are written (`firstPaidAt: null` in the
 * filter), so a stamp the webhook wrote since the read is never overwritten,
 * and a re-run after an apply finds nothing to do.
 *
 *   node src/scripts/backfill-first-paid.js           # dry run: counts only
 *   node src/scripts/backfill-first-paid.js --apply   # write
 */
const mongoose = require('mongoose');
const User = require('../models/User');

/**
 * @param {object} stripe      a Stripe client
 * @param {string} customerId
 * @returns {Promise<Date|null>} when the customer's first invoice above zero was paid
 */
async function firstPaidAtFor(stripe, customerId) {
  let first = null;
  for await (const invoice of stripe.invoices.list({ customer: customerId, status: 'paid', limit: 100 })) {
    if (!(invoice.amount_paid > 0)) continue;
    const seconds = invoice.status_transitions?.paid_at || invoice.created;
    if (!seconds) continue;
    const at = new Date(seconds * 1000);
    if (!first || at < first) first = at;
  }
  return first;
}

/**
 * @returns {Promise<{ candidates: number, paid: number, current: number, former: number, failed: number, applied: number }>}
 *   candidates = accounts with a Stripe customer and no firstPaidAt; paid = the
 *   ones Stripe has a paid invoice for, split into current (a subscription now)
 *   and former (none: what the Former supporters card counts); failed = Stripe
 *   could not be asked about them, so they are left for a re-run.
 */
async function backfillFirstPaid({ stripe, apply = false } = {}) {
  const users = await User.find(
    { stripeCustomerId: { $ne: null }, firstPaidAt: null },
    '_id stripeCustomerId stripeSubscriptionId'
  ).lean();
  const result = { candidates: users.length, paid: 0, current: 0, former: 0, failed: 0, applied: 0 };

  const ops = [];
  for (const user of users) {
    let firstPaidAt;
    try {
      firstPaidAt = await firstPaidAtFor(stripe, user.stripeCustomerId);
    } catch (err) {
      result.failed++;
      console.warn(`Stripe could not list the invoices of account ${user._id}: ${err.message}`);
      continue;
    }
    if (!firstPaidAt) continue;
    result.paid++;
    result[user.stripeSubscriptionId ? 'current' : 'former']++;
    ops.push({ updateOne: { filter: { _id: user._id, firstPaidAt: null }, update: { $set: { firstPaidAt } } } });
  }

  if (apply && ops.length > 0) {
    const written = await User.bulkWrite(ops, { ordered: false });
    result.applied = written.modifiedCount || 0;
  }
  return result;
}

async function main() {
  const apply = process.argv.includes('--apply');
  if (!process.env.STRIPE_SECRET_KEY) {
    console.error('STRIPE_SECRET_KEY is not set: without Stripe there are no payments to read.');
    process.exitCode = 1;
    return;
  }
  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://mongo:27017/winecellar');
  console.log(`Mode: ${apply ? 'APPLY' : 'DRY-RUN (no changes; pass --apply to execute)'}`);

  const r = await backfillFirstPaid({ stripe, apply });
  console.log(`Accounts with a Stripe customer and no firstPaidAt: ${r.candidates}`);
  console.log(`Paid at least once: ${r.paid} (${r.current} with a subscription now, ${r.former} without)`);
  if (r.failed) console.log(`Not checked, Stripe failed: ${r.failed} (run again)`);
  if (apply) console.log(`Written: ${r.applied}`);

  await mongoose.disconnect();
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { backfillFirstPaid, firstPaidAtFor };
