/**
 * Applies the Vivino scan-history destination choice to parsed rows and
 * strips the transient scanDate before anything is sent to the backend.
 * In history mode every scan becomes a consumed bottle; in wishlist mode
 * every row becomes a WishlistItem instead of a bottle. The transformed
 * items flow into the validate results, which is what both the session
 * draft and the confirm payload are built from.
 *
 * Extracted from ImportBottles (audit 2026-07-24 M3) so the mode transform
 * sits behind a unit test like its siblings importMappers/importPayload —
 * a field dropped here silently disappears between review and creation.
 */
export function prepareImportItems(parsedItems, { vivinoScanHistory, vivinoImportMode } = {}) {
  return parsedItems.map(({ scanDate, ...item }) => {
    if (!vivinoScanHistory) return item;
    if (vivinoImportMode === 'wishlist') {
      return { ...item, addToWishlist: true };
    }
    if (vivinoImportMode !== 'history') return item;
    return {
      ...item,
      addToHistory: true,
      consumedReason: 'drank',
      // The scan date anchors BOTH ends of the journey: the bottle entered
      // the collection and was drunk at the scan moment. Without dateAdded
      // the backend stamps addedToCellarAt = import day, producing "Added
      // Jul 2026 → Drank May 2019" journeys and negative holding-time
      // stats (audit 2026-07-24 H1). Vivino histories have no purchase
      // date, so scanDate is the only truthful anchor.
      ...(scanDate ? { consumedAt: scanDate, dateAdded: scanDate } : {}),
      // The user's Vivino rating doubles as the drinking rating (it was
      // given at scan time).
      ...(item.rating !== undefined
        ? { consumedRating: item.rating, consumedRatingScale: item.ratingScale }
        : {}),
    };
  });
}
