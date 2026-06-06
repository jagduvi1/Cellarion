/**
 * Community release-price aggregation job — runs weekly via the scheduler.
 *
 * For every (wine, currency) with active, priced bottles it builds the wine's
 * per-vintage release-price curve from what users actually paid, then upserts
 * one CommunityWinePrice per non-suspect vintage. Prices are bucketed *by
 * currency* and never converted across currencies (same-currency = same-tax =
 * comparable). See docs/wine-valuation-spec.md.
 *
 * The cross-vintage fat-finger cleaner and the median/IQR aggregation live in
 * utils/communityPricing.js (pure + unit-tested).
 */
const Bottle = require('../models/Bottle');
const CommunityWinePrice = require('../models/CommunityWinePrice');
const { CONSUMED_STATUSES } = require('../config/constants');
const { ABSOLUTE_CAP } = require('../utils/priceValidation');
const { buildReleaseCurve, median } = require('../utils/communityPricing');

/** Per-currency typical-maximum cap, falling back to USD. */
function capFor(currency) {
  return ABSOLUTE_CAP[currency] ?? ABSOLUTE_CAP.USD;
}

async function runCommunityPriceAggregation() {
  // One pass: group bottles to per (wine, currency) → vintages → owners → prices.
  //
  // Only STANDARD 750 ml bottles are aggregated — a magnum (~2×) or half-bottle
  // would skew the median, and "current release" means the price of a standard
  // bottle. `bottleSize` stores a localized display label (e.g. '750ml',
  // '750ml (Standard)', '750ml（標準）'), so we match the '750ml' prefix across
  // locales rather than an exact string. Legacy bottles with no size set
  // (Mongoose default is '750ml') are treated as standard.
  const STANDARD_750 = /^\s*750\s*ml/i;
  const rows = await Bottle.aggregate([
    {
      $match: {
        status: { $nin: CONSUMED_STATUSES },
        price: { $gt: 0 },
        wineDefinition: { $ne: null },
        $or: [
          { bottleSize: { $regex: STANDARD_750 } },
          { bottleSize: null }, // matches null and missing
        ],
      },
    },
    // Each distinct owner's prices for a wine+currency+vintage.
    {
      $group: {
        _id: {
          wine: '$wineDefinition',
          currency: { $ifNull: ['$currency', 'USD'] },
          vintage: { $ifNull: ['$vintage', 'NV'] },
          user: '$user',
        },
        prices: { $push: '$price' },
      },
    },
    // Collect owners per wine+currency+vintage.
    {
      $group: {
        _id: { wine: '$_id.wine', currency: '$_id.currency', vintage: '$_id.vintage' },
        owners: { $push: '$prices' },
      },
    },
    // Collect vintages per wine+currency.
    {
      $group: {
        _id: { wine: '$_id.wine', currency: '$_id.currency' },
        vintages: { $push: { vintage: '$_id.vintage', owners: '$owners' } },
      },
    },
  ]);

  let upserted = 0;
  let removed = 0;

  for (const row of rows) {
    const { wine, currency } = row._id;
    const cur = String(currency || 'USD').toUpperCase();
    const cap = capFor(cur);

    // Reduce each owner's bottles to one cleaned representative price, per vintage.
    // Skip 'NV' — non-vintage wines have no release-price progression to track.
    const vintages = [];
    for (const v of row.vintages) {
      if (!v.vintage || v.vintage === 'NV') continue;
      const ownerPrices = [];
      for (const prices of v.owners) {
        const clean = (prices || []).filter((p) => typeof p === 'number' && p > 0 && p <= cap);
        if (clean.length === 0) continue;
        ownerPrices.push(median(clean));
      }
      if (ownerPrices.length > 0) vintages.push({ vintage: String(v.vintage), ownerPrices });
    }

    const curve = buildReleaseCurve(vintages);
    const valid = curve.filter((c) => !c.suspect);
    const validVintages = valid.map((c) => c.vintage);

    if (valid.length > 0) {
      const ops = valid.map((c) => ({
        updateOne: {
          filter: { wineDefinition: wine, vintage: c.vintage, currency: cur },
          update: {
            $set: {
              wineDefinition: wine,
              vintage: c.vintage,
              currency: cur,
              medianPrice: c.medianPrice,
              sampleSize: c.sampleSize,
              confidence: c.confidence,
              p25: c.p25 ?? null,
              p75: c.p75 ?? null,
              computedAt: new Date(),
            },
          },
          upsert: true,
        },
      }));
      const res = await CommunityWinePrice.bulkWrite(ops);
      upserted += (res.upsertedCount || 0) + (res.modifiedCount || 0);
    }

    // Drop stale aggregates for this wine+currency: vintages that became suspect,
    // lost all owners, or were removed since the last run.
    const del = await CommunityWinePrice.deleteMany({
      wineDefinition: wine,
      currency: cur,
      vintage: { $nin: validVintages },
    });
    removed += del.deletedCount || 0;
  }

  console.log(
    `[communityPrice] Aggregated ${rows.length} wine/currency group(s): ` +
    `${upserted} price(s) upserted, ${removed} stale removed`
  );
  return { groups: rows.length, upserted, removed };
}

module.exports = { runCommunityPriceAggregation };
