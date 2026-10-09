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

module.exports = { photoVintage };
