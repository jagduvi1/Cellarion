/**
 * The vintage official photo of each (wine, vintage) asked for — see
 * utils/imageVintage.pickVintageOfficials for the rule. One query for a whole
 * cellar page: the cards, the bottle page and the vintage page all resolve
 * their "photo of this vintage" here, so they agree.
 */
const BottleImage = require('../models/BottleImage');
const { pickVintageOfficials } = require('../utils/imageVintage');

// What may represent a vintage to everyone: published, never a label scan.
const ELIGIBLE = { status: 'approved', visibility: 'public', kind: { $ne: 'label-scan' } };

/**
 * @param {Array} wineIds  wine ids (strings or ObjectIds)
 * @param {Array} vintages canonical vintages (photoVintage output, no nulls)
 * @returns {Promise<Map<string, {url, credit, _id}>>} keyed by vintageKey
 */
async function findVintageOfficials(wineIds, vintages) {
  const out = new Map();
  if (!wineIds || !wineIds.length || !vintages || !vintages.length) return out;
  const rows = await BottleImage.find({
    ...ELIGIBLE,
    wineDefinition: { $in: wineIds },
    vintage: { $in: vintages },
  }).select('_id wineDefinition vintage processedUrl originalUrl credit assignedToWine assignedToVintage createdAt').lean();
  const withFile = rows.filter((r) => r.processedUrl || r.originalUrl);
  for (const [key, row] of pickVintageOfficials(withFile)) {
    out.set(key, { _id: row._id, url: row.processedUrl || row.originalUrl, credit: row.credit || null });
  }
  return out;
}

module.exports = { findVintageOfficials, ELIGIBLE };
