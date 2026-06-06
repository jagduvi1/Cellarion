/**
 * Replacement-value resolution: "what would it cost to rebuy this bottle today?"
 *
 * Priority per bottle:
 *   1. secondary      — a sommelier-set WineVintagePrice for this EXACT
 *                       wine+vintage (Track B). Most accurate for collectibles.
 *   2. currentRelease — the community release price (Phase 0) for the newest
 *                       vintage in the bottle's currency. Replacement value for
 *                       ordinary bottles.
 *   3. paid           — the bottle's own purchase price (fallback so a cellar
 *                       total is never understated by missing estimates).
 *
 * Values are returned in their own currency; the caller converts to a canonical
 * currency (USD) for any cross-currency total. See docs/wine-valuation-spec.md.
 */
const WineVintagePrice = require('../models/WineVintagePrice');
const CommunityWinePrice = require('../models/CommunityWinePrice');

/**
 * Pure priority pick. Each input is `{ amount, currency }` or null.
 * @returns {{amount:number, currency:string, source:'secondary'|'currentRelease'|'paid'}|null}
 */
function pickReplacement({ secondary, currentRelease, paid }) {
  if (secondary && secondary.amount > 0) {
    return { amount: secondary.amount, currency: secondary.currency, source: 'secondary' };
  }
  if (currentRelease && currentRelease.amount > 0) {
    return { amount: currentRelease.amount, currency: currentRelease.currency, source: 'currentRelease' };
  }
  if (paid && paid.amount > 0) {
    return { amount: paid.amount, currency: paid.currency, source: 'paid' };
  }
  return null;
}

/**
 * Resolve replacement values for a batch of bottles with two bulk queries.
 * @param {Array<{_id, wineDefinition, vintage, price, currency}>} bottles  (lean)
 * @returns {Promise<Map<string, {amount, currency, source}>>} keyed by bottle id
 */
async function resolveReplacementForBottles(bottles) {
  const result = new Map();
  if (!bottles || bottles.length === 0) return result;

  // Accept lean bottles (wineDefinition = ObjectId) and populated docs
  // (wineDefinition = { _id, ... }) alike.
  const wineIdOf = (b) => (b.wineDefinition ? String(b.wineDefinition._id || b.wineDefinition) : null);
  const wineIds = [...new Set(bottles.map(wineIdOf).filter(Boolean))];

  // secondary: latest WineVintagePrice per (wine, vintage). Sort ascending so
  // the last write per key wins (= newest setAt).
  const secondaryMap = new Map();
  if (wineIds.length) {
    const wvp = await WineVintagePrice.find({ wineDefinition: { $in: wineIds } })
      .select('wineDefinition vintage price currency setAt')
      .sort({ setAt: 1 })
      .lean();
    for (const p of wvp) {
      secondaryMap.set(`${p.wineDefinition}|${p.vintage}`, {
        amount: p.price,
        currency: (p.currency || 'USD').toUpperCase(),
      });
    }
  }

  // currentRelease: newest-vintage CommunityWinePrice per (wine, currency).
  const crMap = new Map();
  if (wineIds.length) {
    const cwp = await CommunityWinePrice.find({ wineDefinition: { $in: wineIds } })
      .select('wineDefinition vintage currency medianPrice')
      .lean();
    for (const c of cwp) {
      const key = `${c.wineDefinition}|${c.currency}`;
      const vNum = parseInt(c.vintage, 10) || 0;
      const prev = crMap.get(key);
      if (!prev || vNum > prev.vNum) {
        crMap.set(key, { amount: c.medianPrice, currency: c.currency, vNum });
      }
    }
  }

  for (const b of bottles) {
    const wine = wineIdOf(b);
    const cur = (b.currency || 'USD').toUpperCase();
    const secondary = wine ? secondaryMap.get(`${wine}|${b.vintage}`) : null;
    const cr = wine ? crMap.get(`${wine}|${cur}`) : null;
    const paid = typeof b.price === 'number' && b.price > 0 ? { amount: b.price, currency: cur } : null;

    const picked = pickReplacement({
      secondary,
      currentRelease: cr ? { amount: cr.amount, currency: cr.currency } : null,
      paid,
    });
    if (picked) result.set(String(b._id), picked);
  }

  return result;
}

module.exports = { pickReplacement, resolveReplacementForBottles };
