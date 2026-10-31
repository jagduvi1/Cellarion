/**
 * Which accepted public key a typed name means.
 *
 * Members name a figure in their own language and spelling ("Alkoholhalt",
 * "degré d'alcool", "A.B.V."), while the vocabulary stores one canonical
 * English name plus display translations. A name that only matches in a
 * translation is still that key — resolving it here keeps a promotion from a
 * personal entry from dead-ending on "no such key" and then proposing the
 * same field again under another name.
 *
 * Pure and free of models, so the routes, the ops service and the MCP tools
 * share one rule (the frontend mirrors it in utils/registryKeyName.js).
 */

// Case, accents and everything that is not a letter or a digit are noise:
// "Degré d’alcool" and "degre d'alcool" are the same name. æ and œ are
// letters of their own to NFKD, so they are unfolded by hand.
function normaliseKeyName(name) {
  if (name === null || name === undefined) return '';
  return String(name)
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/æ/g, 'ae')
    .replace(/œ/g, 'oe')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

// A lean row and a serialised key carry a plain object, a document a Map.
function translationValues(key) {
  const tr = key && key.translations;
  if (!tr) return [];
  const values = typeof tr.values === 'function' && typeof tr.get === 'function'
    ? Array.from(tr.values())
    : Object.values(tr);
  return values.filter((v) => typeof v === 'string');
}

/**
 * The key in `keys` that `name` means, or null. The canonical name wins; a
 * translation (or a served displayName) counts only when it points at ONE
 * key — two keys sharing a translated name is a guess, and a guess here
 * would file a figure under the wrong field.
 *
 * @param {Array<{ _id, name: string, displayName?: string, translations?: object }>} keys
 * @param {string} name
 */
function matchKeyByName(keys, name) {
  const wanted = normaliseKeyName(name);
  if (!wanted || !Array.isArray(keys)) return null;
  const canonical = keys.find((k) => k && normaliseKeyName(k.name) === wanted);
  if (canonical) return canonical;
  const translated = keys.filter((k) => k && [k.displayName, ...translationValues(k)]
    .some((n) => normaliseKeyName(n) === wanted));
  const ids = new Set(translated.map((k) => String(k._id)));
  return ids.size === 1 ? translated[0] : null;
}

module.exports = { normaliseKeyName, matchKeyByName };
