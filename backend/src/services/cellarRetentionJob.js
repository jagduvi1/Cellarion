/**
 * 30-day retention purge for soft-deleted cellars and racks.
 *
 * The DELETE routes promise "data retained 30 days" — this job is what makes
 * that true (GDPR storage limitation). Runs daily; hard-deletes:
 *  - cellars soft-deleted more than RETENTION_DAYS ago, via the same
 *    purgeCellarPermanently cascade the admin permanent-delete route uses
 *  - individually soft-deleted racks (their cellar is still active) past the
 *    same window — these have no restore path, only the retention grace
 *
 * It also frees NFC tags still held by soft-deleted racks inside the window:
 * the unique index on rfidTag has no deletedAt filter, so a tag stays claimed
 * by a deleted rack and can't be linked to a new one until the field is unset.
 */
const Cellar = require('../models/Cellar');
const Rack = require('../models/Rack');
const { purgeCellarPermanently } = require('./cellarPurge');
const { logAudit } = require('./audit');

const RETENTION_DAYS = 30;

async function runCellarRetentionPurge() {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);

  // Free NFC tags on ALL soft-deleted racks (also self-heals racks deleted
  // before the soft-delete route started unsetting the tag).
  const tagResult = await Rack.updateMany(
    { deletedAt: { $type: 'date' }, rfidTag: { $exists: true } },
    { $unset: { rfidTag: '' } }
  );

  // Expired cellars — full cascade per cellar so a failure on one doesn't
  // block the rest.
  const expired = await Cellar.find({ deletedAt: { $type: 'date', $lt: cutoff } })
    .select('name user deletedAt').lean();
  let cellarsPurged = 0;
  for (const cellar of expired) {
    try {
      const counts = await purgeCellarPermanently(cellar._id);
      cellarsPurged++;
      logAudit(null, 'cellar.retention_purge', { type: 'cellar', id: cellar._id, cellarId: cellar._id }, {
        name: cellar.name,
        owner: cellar.user,
        deletedAt: cellar.deletedAt,
        ...counts,
      });
    } catch (err) {
      console.error(`[cellarRetention] purge failed for cellar ${cellar._id}:`, err);
    }
  }

  // Expired individually-deleted racks (cellar-cascaded ones are gone above).
  const rackResult = await Rack.deleteMany({ deletedAt: { $type: 'date', $lt: cutoff } });

  if (cellarsPurged > 0 || rackResult.deletedCount > 0 || tagResult.modifiedCount > 0) {
    console.log(`[cellarRetention] purged ${cellarsPurged} cellar(s), ${rackResult.deletedCount} rack(s); freed ${tagResult.modifiedCount} NFC tag(s)`);
  }

  return { cellarsPurged, racksPurged: rackResult.deletedCount, tagsFreed: tagResult.modifiedCount };
}

module.exports = { runCellarRetentionPurge, RETENTION_DAYS };
