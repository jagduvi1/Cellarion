// "More of this bottle": the copies "Add more bottles" (bottle page) and an
// order's "Change quantity" (On order page) create — one rule for both.

/** How many copies one action adds (one POST /api/bottles each, under the write limiter). */
export const MAX_COPIES = 24;

/**
 * What a copy is made of — only fields POST /api/bottles accepts (see backend
 * bottleOps.addBottle):
 * - wine / cellar / vintage / bottleSize / currency always travel: "more of
 *   this bottle" means the same wine, same vintage, same format, same cellar —
 *   and the same currency even when details are left out, because the backend
 *   otherwise defaults a blank copy to USD (bottleOps).
 * - copyDetails carries provenance: price, purchase info, notes, occasion.
 * - Never copied: rating and the personal drink window (judgements about that
 *   specific bottle, not the purchase), rack position (new bottles arrive
 *   unplaced) and the migration helpers (dateAdded / addToHistory).
 */
export function bottleCopyPayload(bottle, { copyDetails = true } = {}) {
  const payload = {
    cellar: bottle.cellar?._id || bottle.cellar,
    wineDefinition: bottle.wineDefinition?._id || bottle.wineDefinition,
    vintage: bottle.vintage,
    bottleSize: bottle.bottleSize || undefined,
  };
  if (bottle.currency) payload.currency = bottle.currency;
  if (copyDetails) {
    if (bottle.price != null && bottle.price !== '') payload.price = bottle.price;
    if (bottle.purchaseDate) payload.purchaseDate = bottle.purchaseDate;
    if (bottle.purchaseLocation) payload.purchaseLocation = bottle.purchaseLocation;
    if (bottle.purchaseUrl) payload.purchaseUrl = bottle.purchaseUrl;
    if (bottle.notes) payload.notes = bottle.notes;
    if (bottle.occasion) payload.occasion = bottle.occasion;
  }
  return payload;
}
