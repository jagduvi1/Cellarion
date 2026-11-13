/**
 * The tasting-profile prose a screen shows: the translated copy when the
 * server sent one, else the English.
 *
 * With a language set in SuperAdmin → AI, the server sends
 * `aiProfile.localized` ({ lang, description, flavors, foodPairings }) beside
 * the English, and only while it is fresh (backend utils/profileLanguage
 * displayProfile). The check here is the same rule seen from the page: a
 * copy whose generatedAt differs from the profile's translates text that is
 * no longer there, and the English shows instead. The anonymous tier sends
 * the description only; a list the copy does not carry stays the profile's.
 *
 * @param {object|null|undefined} ap  the wine's aiProfile as the API sent it
 * @returns {{ description: string|null, flavors: string[], foodPairings: string[], lang: string|null }}
 */
export function profileText(ap) {
  const english = {
    description: ap?.description || null,
    flavors: Array.isArray(ap?.flavors) ? ap.flavors : [],
    foodPairings: Array.isArray(ap?.foodPairings) ? ap.foodPairings : [],
    lang: null,
  };
  const copy = ap?.localized;
  if (!english.description || !copy || typeof copy.description !== 'string' || !copy.description) return english;
  if (copy.generatedAt && ap.generatedAt && String(copy.generatedAt) !== String(ap.generatedAt)) return english;
  return {
    description: copy.description,
    flavors: Array.isArray(copy.flavors) ? copy.flavors : english.flavors,
    foodPairings: Array.isArray(copy.foodPairings) ? copy.foodPairings : english.foodPairings,
    lang: typeof copy.lang === 'string' && copy.lang ? copy.lang : null,
  };
}
