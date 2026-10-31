/**
 * Which accepted public key a typed name means — the frontend mirror of
 * backend/src/utils/registryKeyName.js, so the card steers by the same rule
 * the server resolves by. Members name a figure in their own language and
 * spelling ("Alkoholhalt", "degré d'alcool"); the vocabulary stores one
 * canonical name plus display translations.
 */

// Case, accents and everything that is not a letter or a digit are noise.
// æ and œ are letters of their own to NFKD, so they are unfolded by hand.
export function normaliseKeyName(name) {
  if (name === null || name === undefined) return '';
  return String(name)
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/æ/g, 'ae')
    .replace(/œ/g, 'oe')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * The key in `keys` that `name` means, or null. The canonical name wins; a
 * translation (or the served displayName) counts only when it points at ONE
 * key, because filing a figure under a guessed field is worse than not
 * steering at all.
 */
export function matchKeyByName(keys, name) {
  const wanted = normaliseKeyName(name);
  if (!wanted || !Array.isArray(keys)) return null;
  const canonical = keys.find((k) => k && normaliseKeyName(k.name) === wanted);
  if (canonical) return canonical;
  const translated = keys.filter((k) => k && [k.displayName, ...Object.values(k.translations || {})]
    .some((n) => typeof n === 'string' && normaliseKeyName(n) === wanted));
  const ids = new Set(translated.map((k) => String(k._id)));
  return ids.size === 1 ? translated[0] : null;
}
