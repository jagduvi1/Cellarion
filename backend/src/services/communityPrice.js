/**
 * Read-side helpers for the community release-price aggregates produced by
 * communityPriceJob. Answers "what does this wine cost now?" for a given
 * currency, without ever converting across currencies.
 */
const CommunityWinePrice = require('../models/CommunityWinePrice');

function normCurrency(c) {
  return String(c || 'USD').toUpperCase();
}

/** Vintage is stored as a string; sort newest-first numerically. */
function vintageDesc(a, b) {
  return (parseInt(b.vintage, 10) || 0) - (parseInt(a.vintage, 10) || 0);
}

/**
 * Full per-vintage release-price curve for a wine in one currency,
 * newest vintage first. Used for the sparkline / wine page.
 */
async function getReleaseCurve(wineId, currency) {
  if (!wineId) return [];
  const docs = await CommunityWinePrice.find({
    wineDefinition: wineId,
    currency: normCurrency(currency),
  })
    .select('vintage medianPrice sampleSize confidence p25 p75 currency -_id')
    .lean();
  docs.sort(vintageDesc);
  return docs;
}

/**
 * The "current release" = the newest vintage we have a community price for, in
 * the requested currency. This is the replacement-value signal for an ordinary
 * bottle. Returns null when there's no community data in that currency yet.
 */
async function getCurrentRelease(wineId, currency) {
  const curve = await getReleaseCurve(wineId, currency);
  if (curve.length === 0) return null;
  const top = curve[0];
  return {
    vintage: top.vintage,
    medianPrice: top.medianPrice,
    currency: top.currency,
    sampleSize: top.sampleSize,
    confidence: top.confidence,
  };
}

module.exports = { getReleaseCurve, getCurrentRelease };
