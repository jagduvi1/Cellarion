/**
 * Display names for taxonomy in the reader's language.
 *
 * A French owner asked for "Rhône Valley" to read "Vallée du Rhône" (correction
 * proposal 6a959b9d, 2026-09-01, reason: "En Français svp"). His request could
 * not be granted as filed, because a region's `name` is stored once and shared
 * by every wine and every user: renaming it would have changed the region for
 * all 298 wines on it, in every language, and undone the French→English
 * consolidation the taxonomy had just been through.
 *
 * But he was right about the gap. The interface ships in five languages while
 * the taxonomy speaks only English — and the asymmetry is already visible in
 * our own code, which ACCEPTS "Allemagne" and "Vallée du Rhône" on import
 * (utils/normalize's COUNTRY_ALIASES is full of French, German and Swedish
 * spellings) and then hands back "Germany" for ever after. We take his language
 * in and never give it back.
 *
 * So the canonical name stays English and authoritative — it is what search,
 * dedup, exports and the registry key are built on — and a translation is a
 * DISPLAY concern layered on top.
 *
 * WHAT IS DELIBERATELY NOT TRANSLATED:
 *
 *   - Appellations. Côte-Rôtie is Côte-Rôtie in every language; a protected
 *     designation of origin is a legal name, and translating one would be
 *     inventing a wine law that does not exist.
 *   - Grapes. Cabernet Sauvignon does not change language. Where a variety
 *     genuinely goes by another name it is a REGIONAL difference, not a
 *     linguistic one (Malvoisie in the Loire is Pinot Gris), and models/Grape
 *     already carries `regionalNames` keyed by place for exactly that.
 *
 * Which leaves countries and regions — the two that really are translated, and
 * the two the owner actually asked about.
 */

/**
 * The reader's language, reduced to a bare tag we store translations under.
 * "fr-CA" and "fr" are the same shelf here: regional variants of a country
 * name are not what this solves, and pretending otherwise would leave a
 * fr-CA reader with English while a perfectly good French name sat unused.
 *
 * @param {string} locale
 * @returns {string|null} lowercase base language, or null when unusable
 */
function baseLanguage(locale) {
  if (typeof locale !== 'string') return null;
  const base = locale.trim().toLowerCase().split(/[-_]/)[0];
  return /^[a-z]{2,3}$/.test(base) ? base : null;
}

/**
 * The name to show this reader.
 *
 * Falls back to the canonical English name whenever there is no translation,
 * which is the honest answer and also today's behaviour everywhere — so an
 * unadopted surface and an untranslated entry look identical, and neither is
 * a regression.
 *
 * @param {{name?: string, translations?: Map<string,string>|Object}} doc
 * @param {string} locale
 * @returns {string} never null when the doc has a name
 */
function localizedName(doc, locale) {
  const canonical = doc && typeof doc.name === 'string' ? doc.name : '';
  const lang = baseLanguage(locale);
  if (!lang || lang === 'en' || !doc || !doc.translations) return canonical;
  // A Mongoose document gives a Map; a .lean() one gives a plain object. Both
  // reach this function and both must work — reading only one shape is how a
  // feature works in tests and silently does nothing in production.
  const t = typeof doc.translations.get === 'function'
    ? doc.translations.get(lang)
    : doc.translations[lang];
  return (typeof t === 'string' && t.trim()) ? t.trim() : canonical;
}

/**
 * Clean a translations payload from an admin editor.
 *
 * Drops anything that is not a real language→non-empty-string pair, and drops
 * `en` outright: English is the canonical `name`, and a second English spelling
 * that could drift from it is a bug waiting to be filed as a data mystery.
 *
 * @param {Object} raw
 * @param {number} [maxLength=120]
 * @returns {{ok: true, translations: Object}|{ok: false, error: string}}
 */
function sanitizeTranslations(raw, maxLength = 120) {
  if (raw == null) return { ok: true, translations: {} };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'translations must be an object of language → name' };
  }
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    const lang = baseLanguage(key);
    if (!lang) return { ok: false, error: `"${key}" is not a language code` };
    if (lang === 'en') return { ok: false, error: 'English is the canonical name and cannot be a translation' };
    if (value == null || value === '') continue;              // an explicit clear
    if (typeof value !== 'string') return { ok: false, error: `translation for "${lang}" must be a string` };
    const trimmed = value.trim();
    if (!trimmed) continue;
    if (trimmed.length > maxLength) return { ok: false, error: `translation for "${lang}" is longer than ${maxLength} characters` };
    out[lang] = trimmed;
  }
  return { ok: true, translations: out };
}

module.exports = { localizedName, baseLanguage, sanitizeTranslations };
