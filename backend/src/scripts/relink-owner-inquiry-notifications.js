/**
 * One-time relink (support ticket 2026-10-14): point the curator-question
 * notifications written before the fix at the question itself.
 *
 * Until then an owner_inquiry / owner_inquiry_resolved notification linked to
 * the recipient's bottle as it was when the question went out
 * (/cellars/<cellar>/bottles/<bottle>). Once that bottle or its cellar was
 * deleted the link led to "bottle not found". New notifications link to
 * /questions/<inquiryId>, which finds a bottle page the owner can open at click
 * time (services/ownerInquiryOps.inquiryForRecipient). This rewrites the old
 * links the same way.
 *
 * Which: a notification of those two types whose link is a bottle link, for
 * which an inquiry exists with a recipient row of the SAME user and the SAME
 * bottle (the row the notification was written from). When several inquiries
 * match, the newest one created at or before the notification. Anything that
 * does not match exactly is left alone. Only `link` changes.
 *
 *   node src/scripts/relink-owner-inquiry-notifications.js          # dry run: counts only
 *   node src/scripts/relink-owner-inquiry-notifications.js --apply  # rewrite the links
 */
const mongoose = require('mongoose');
const Notification = require('../models/Notification');
const WineOwnerInquiry = require('../models/WineOwnerInquiry');
const { questionLink } = require('../services/ownerInquiryOps');

const TYPES = ['owner_inquiry', 'owner_inquiry_resolved'];
const BOTTLE_LINK = /^\/cellars\/([a-f0-9]{24})\/bottles\/([a-f0-9]{24})$/;

/**
 * @param {{apply?: boolean}} [opts]
 * @returns {Promise<{scanned:number, matched:number, relinked:number, unmatched:number}>}
 */
async function relinkOwnerInquiryNotifications({ apply = false } = {}) {
  const notes = await Notification.find({ type: { $in: TYPES }, link: { $regex: '^/cellars/' } })
    .select('user link createdAt')
    .lean();
  const stats = { scanned: notes.length, matched: 0, relinked: 0, unmatched: 0 };
  for (const n of notes) {
    const m = BOTTLE_LINK.exec(n.link || '');
    if (!m) { stats.unmatched += 1; continue; }
    const bottleId = new mongoose.Types.ObjectId(m[2]);
    const inquiry = await WineOwnerInquiry.findOne({
      recipients: { $elemMatch: { user: n.user, bottle: bottleId } },
      ...(n.createdAt ? { createdAt: { $lte: n.createdAt } } : {}),
    }).sort({ createdAt: -1 }).select('_id').lean();
    if (!inquiry) { stats.unmatched += 1; continue; }
    stats.matched += 1;
    if (apply) {
      const r = await Notification.updateOne({ _id: n._id, link: n.link }, { $set: { link: questionLink(inquiry._id) } });
      stats.relinked += r.modifiedCount || 0;
    }
  }
  return stats;
}

async function main() {
  const apply = process.argv.includes('--apply');
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://mongo:27017/winecellar');
  const stats = await relinkOwnerInquiryNotifications({ apply });
  console.log(`${apply ? 'APPLIED' : 'DRY RUN'} — scanned ${stats.scanned}, matched ${stats.matched}, relinked ${stats.relinked}, left alone ${stats.unmatched}`);
  await mongoose.disconnect();
}

if (require.main === module) {
  main().catch((err) => {
    console.error('relink-owner-inquiry-notifications failed:', err.message);
    process.exit(1);
  });
}

module.exports = { relinkOwnerInquiryNotifications, BOTTLE_LINK };
