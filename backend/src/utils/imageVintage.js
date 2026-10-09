/**
 * The vintage a photo belongs to (support ticket 2026-10-09: a photo of the
 * 2015 label showed on the 2016 bottles, with the wrong year printed on it).
 *
 * A photo is taken of ONE bottle, so it is of that bottle's vintage. Stored
 * on BottleImage.vintage in the same canonical form Bottle.vintage uses
 * ('2015', 'NV'), so a same-vintage lookup is an equality match. 'Unknown'
 * and empty vintages carry no information worth matching on — a photo of a
 * bottle whose year nobody knows must not become "the" photo of every other
 * unknown-year bottle of the wine — so they store as null (wine-wide).
 */
function photoVintage(vintage) {
  if (vintage == null) return null;
  const v = String(vintage).trim();
  if (!v || v.length > 10 || /^unknown$/i.test(v)) return null;
  return v;
}

const vintageKey = (wine, vintage) => `${wine}::${vintage}`;

/**
 * Which photo a vintage shows — its "vintage official" (Johan, 2026-10-09:
 * "if someone uploads an image of that vintage it should be validated as
 * before and selected as the vintage official"). Among the approved, public
 * photos of one wine AND vintage: the one an admin chose (assignedToVintage),
 * else the wine's official image when it is of this vintage, else the FIRST
 * one approved — so a later upload never silently replaces it. Derived on
 * read rather than stored, so a rejected, unpublished or deleted official
 * simply hands over to the next photo with nothing to repair.
 */
function vintageOfficialOrder(a, b) {
  return (b.assignedToVintage === true) - (a.assignedToVintage === true)
    || (b.assignedToWine === true) - (a.assignedToWine === true)
    || new Date(a.createdAt || 0) - new Date(b.createdAt || 0)
    || String(a._id).localeCompare(String(b._id));
}

/**
 * From rows the caller already narrowed to eligible photos (approved, public,
 * not a label scan, with a file), the vintage official of every (wine,
 * vintage) present. Rows without a wine or a usable vintage are skipped.
 * Returns Map(vintageKey → row).
 */
function pickVintageOfficials(rows) {
  const best = new Map();
  for (const row of rows || []) {
    const wine = row.wineDefinition && (row.wineDefinition._id || row.wineDefinition);
    const vintage = photoVintage(row.vintage);
    if (!wine || !vintage) continue;
    const key = vintageKey(String(wine), vintage);
    const current = best.get(key);
    if (!current || vintageOfficialOrder(row, current) < 0) best.set(key, row);
  }
  return best;
}

module.exports = { photoVintage, vintageKey, vintageOfficialOrder, pickVintageOfficials };
