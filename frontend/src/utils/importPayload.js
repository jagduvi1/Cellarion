/**
 * Builds one /api/bottles/import/confirm item from a review row + the user's
 * selection. Extracted from ImportBottles so the payload boundary is unit-
 * testable: every field the parsers emit and the backend consumes must be
 * forwarded here — a field missing from this mapping silently disappears
 * between the review screen and the created bottle (that is exactly how the
 * CellarTracker rack auto-map's row/col placements got lost).
 */
export function buildImportItem(r, selection) {
  return {
    wineDefinition: selection !== 'request' && selection !== 'create' ? selection : undefined,
    requestWine: selection === 'request' ? true : undefined,
    // AI-identified NEW wine the user confirmed at review — /confirm creates
    // it (validate is read-only and returns the proposal as aiProposed).
    aiWine: selection === 'create' ? r.aiProposed : undefined,
    wineName: r.item.wineName,
    producer: r.item.producer,
    vintage: r.item.vintage,
    price: r.item.price,
    currency: r.item.currency,
    bottleSize: r.item.bottleSize,
    purchaseDate: r.item.purchaseDate,
    purchaseLocation: r.item.purchaseLocation,
    location: r.item.location,
    notes: r.item.notes,
    rating: r.item.rating,
    ratingScale: r.item.ratingScale,
    // CellarTracker imports carry grape varieties and a personal drink
    // window; the backend importer consumes these when present.
    grapes: r.item.grapes,
    // …and geography. The parsers have read these all along (CT Appellation,
    // the Country/Region/SubRegion/Appellation Locale path, SubRegion, and a
    // generic appellation column) and they were never forwarded — so a wine
    // minted from an import lost the appellation the user's own file stated,
    // and a curator put it back by hand later. Exactly the disappearance this
    // file's docblock warns about, on a different field.
    country: r.item.country,
    region: r.item.region,
    appellation: r.item.appellation,
    classification: r.item.classification,
    drinkFrom: r.item.drinkFrom ?? undefined,
    drinkTo: r.item.drinkTo ?? undefined,
    dateAdded: r.item.dateAdded || r.item.purchaseDate,
    // Rack placement — the backend places via rackPosition OR row+col
    // (grid), layer+slotInLayer (shelf), and sizes auto-created racks from
    // the per-item rackType/rackRows/rackCols hints (utils/rackImport.js).
    rackName: r.item.rackName,
    rackPosition: r.item.rackPosition,
    row: r.item.row,
    col: r.item.col,
    layer: r.item.layer,
    slotInLayer: r.item.slotInLayer,
    internalSlot: r.item.internalSlot,
    rackType: r.item.rackType,
    rackRows: r.item.rackRows,
    rackCols: r.item.rackCols,
    addToHistory: r.item.addToHistory,
    consumedReason: r.item.consumedReason,
    consumedAt: r.item.consumedAt,
    consumedRating: r.item.consumedRating,
    consumedRatingScale: r.item.consumedRatingScale,
    consumedNote: r.item.consumedNote,
    // Wishlist destination (e.g. Vivino scan-history sent to the wishlist):
    // the backend creates a WishlistItem instead of a Bottle.
    addToWishlist: r.item.addToWishlist,
  };
}
