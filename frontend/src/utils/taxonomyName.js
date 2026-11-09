/**
 * Show a country or region in the reader's language.
 *
 * The registry stores one canonical English name per taxonomy entry, because
 * search, dedup, exports and the wine key are all built on it. Renaming an
 * entry for one language ("Rhône Valley" → "Vallée du Rhône") would change it
 * for every wine on it, for every user, in every language.
 *
 * This is the other half: the same stored entry, rendered in the reader's
 * language. `GET /api/taxonomy/display-names?lang=fr` returns only the
 * entries that HAVE a French name, keyed by id and by canonical name, and this
 * resolves against that map.
 *
 * WHY A MAP RATHER THAN A FIELD ON EVERY RESPONSE: taxonomy names are rendered
 * in about thirty components, and most never call a taxonomy endpoint — they
 * get a populated `region` on a wine or a bottle. One map localises all of them
 * without touching a single query or projection, and a component that has not
 * adopted this keeps showing English, which is what it shows today. Nothing
 * regresses by being left alone.
 */

const EMPTY = { byId: {}, byName: {} };

/**
 * @param {{_id?: string, id?: string, name?: string}|string|null} taxon
 *   a populated country/region, or just its canonical name
 * @param {{byId: Object, byName: Object}} [names] the display-name map
 * @returns {string} the localised name, or the canonical one, or ''
 */
export function taxonomyName(taxon, names = EMPTY) {
  if (!taxon) return '';
  const map = names || EMPTY;

  // A bare string — the denormalised case. Only byName can help here, which is
  // why the endpoint ships both keyings.
  if (typeof taxon === 'string') return map.byName?.[taxon] || taxon;

  const id = taxon._id || taxon.id;
  // id first: it is exact. Region names can in principle repeat across
  // countries, so byName is a convenience rather than an authority.
  if (id && map.byId?.[String(id)]) return map.byId[String(id)];

  const canonical = typeof taxon.name === 'string' ? taxon.name : '';
  return (canonical && map.byName?.[canonical]) || canonical;
}

export { EMPTY as EMPTY_DISPLAY_NAMES };
