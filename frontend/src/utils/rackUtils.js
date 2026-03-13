/**
 * Collect the set of bottle IDs that are placed in any rack slot.
 *
 * @param {Array<{ slots: Array<{ bottle?: { _id: string }|string }> }>} racks
 * @returns {Set<string>}
 */
export function getPlacedBottleIds(racks) {
  const ids = new Set();
  racks.forEach(rack => rack.slots.forEach(s => {
    if (s.bottle?._id) ids.add(s.bottle._id);
  }));
  return ids;
}

/**
 * Return bottles that are not placed in any rack.
 *
 * @param {Array<{ _id: string }>} bottles
 * @param {Set<string>} placedIds - Set returned by getPlacedBottleIds
 * @returns {Array<{ _id: string }>}
 */
export function getAvailableBottles(bottles, placedIds) {
  return bottles.filter(b => !placedIds.has(b._id));
}
