/**
 * One-off backfill: thank the people who took out a paid plan before the
 * automatic thank-you existed.
 *
 * Dry-run by default. Pass --apply to actually send.
 *
 *   docker compose exec -T backend node src/scripts/send-supporter-thank-you.js
 *   docker compose exec -T backend node src/scripts/send-supporter-thank-you.js --apply
 *
 * Deliberately routed through the same maybeSendSupporterThankYou() the Stripe
 * webhook uses, rather than calling the mailer directly: the once-ever claim is
 * the whole safety property here, and a second implementation of it is a second
 * chance to get it wrong. Running this twice sends nothing the second time, and
 * anyone it reaches will never be picked up by the webhook path either.
 */
const mongoose = require('mongoose');
const User = require('../models/User');
const { maybeSendSupporterThankYou, PAID_PLANS } = require('../services/supporterThankYou');
const { EMAIL_VERIFICATION_ENABLED } = require('../services/mailgun');

const APPLY = process.argv.includes('--apply');

(async () => {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://mongo:27017/winecellar');

  const pending = await User.find({
    plan: { $in: PAID_PLANS },
    supporterThankYouSentAt: null,
  }).select('username email plan planStartedAt createdAt').sort({ createdAt: 1 });

  console.log(`mail configured: ${EMAIL_VERIFICATION_ENABLED ? 'yes' : 'NO — nothing can be sent'}`);
  console.log(`paid accounts never thanked: ${pending.length}`);
  console.log('');

  for (const u of pending) {
    const since = (u.planStartedAt || u.createdAt || new Date()).toISOString().slice(0, 10);
    console.log(`  ${u.username.padEnd(20)} ${String(u.plan).padEnd(10)} since ${since}  <${u.email}>`);
  }
  console.log('');

  if (!APPLY) {
    console.log('DRY RUN — nothing sent. Re-run with --apply to send.');
    await mongoose.disconnect();
    return;
  }

  if (!EMAIL_VERIFICATION_ENABLED) {
    console.error('Mailgun is not configured — refusing to run so the once-ever stamp is not burned.');
    process.exitCode = 1;
    await mongoose.disconnect();
    return;
  }

  let sent = 0, skipped = 0;
  for (const u of pending) {
    const ok = await maybeSendSupporterThankYou(u._id);
    console.log(`  ${ok ? 'SENT   ' : 'skipped'} ${u.username} <${u.email}>`);
    ok ? sent++ : skipped++;
  }

  console.log('');
  console.log(`done — sent ${sent}, skipped ${skipped}`);

  // logAudit persists fire-and-forget (AuditLog.create(...).catch()), which is
  // right for a long-lived server and wrong for a script that exits. On the
  // 2026-08-17 backfill the disconnect below raced the last write and one of
  // three audit rows never reached MongoDB — the emails and the stamps were
  // all correct, but the trail was short a row. Give the in-flight writes a
  // moment to settle before pulling the connection out from under them.
  await new Promise(resolve => setTimeout(resolve, 1000));

  await mongoose.disconnect();
})().catch(e => { console.error('FAILED:', e); process.exit(1); });
