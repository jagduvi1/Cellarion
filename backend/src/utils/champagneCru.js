/**
 * Champagne's Premier Cru and Grand Cru rate the VILLAGE, not the appellation
 * (docs/wine-fields.md): the appellation is "Champagne" and the cru is a
 * classification. A cru typed into the appellation ("Champagne Grand Cru")
 * would otherwise give one wine two identity keys, and the duplicate guard
 * would not see the twin.
 *
 * Only the appellation Champagne followed by exactly a cru rank counts.
 * Cognac's "Grande Champagne", "Petite Champagne" and "Fine Champagne",
 * "Ratafia de Champagne", "Coteaux Champenois" and "Rosé des Riceys" are other
 * appellations, and a value that names a village ("Champagne Grand Cru
 * (Bouzy)") is left as typed for a person.
 *
 * Who reads this:
 *   - the key builders (utils/normalize appellationKeySegment,
 *     utils/wineIdentity computeCanonicalKey) key a cru form as "Champagne";
 *   - the write rule (services/classificationOps moveChampagneCru, run by the
 *     WineDefinition pre-validate hook) stores "Champagne" and adds the cru to
 *     the wine's tiers;
 *   - the mint (services/findOrCreateWine) and the registry import
 *     (routes/admin/import mapRow) split the value before they match or write.
 *
 * No dependency on utils/normalize: that module requires this one.
 */

const CHAMPAGNE = 'Champagne';

// Keyed by the folded value; the tier is named as the classification list
// names it (data/classifications.json).
const CRU_BY_KEY = new Map([
  ['champagne grand cru', 'Grand Cru'],
  ['champagne premier cru', 'Premier Cru'],
  ['champagne 1er cru', 'Premier Cru'],
]);

// The appellation key's fold, restated (utils/normalize normalizeAppellationKey:
// hyphens to spaces, case, accents, punctuation, whitespace). champagneCru.test.js
// holds the two folds together.
const foldAppellation = (value) => String(value)
  .replace(/-/g, ' ')
  .toLowerCase()
  .normalize('NFD')
  .replace(/[̀-ͯ]/g, '')
  .replace(/[^\w\s]/g, '')
  .replace(/\s+/g, ' ')
  .trim();

/** The cru a Champagne appellation carries ("Grand Cru" | "Premier Cru"), or null when the value is anything else. */
const champagneCruOf = (appellation) =>
  (typeof appellation === 'string' ? CRU_BY_KEY.get(foldAppellation(appellation)) || null : null);

/** The appellation as it is stored and keyed: "Champagne" for a cru form, every other value unchanged. */
const withoutChampagneCru = (appellation) => (champagneCruOf(appellation) ? CHAMPAGNE : appellation);

/**
 * Split a cru form for a path that holds the two fields as strings (the mint,
 * the registry import): { appellation, classification, cru }. The cru joins
 * whatever classification was given, comma-separated, for the classification
 * write rule to resolve; it leads, so a caller's length cap never cuts it
 * off. Any other appellation comes back as given, with cru null.
 */
function splitChampagneCru(appellation, classification) {
  const cru = champagneCruOf(appellation);
  if (!cru) return { appellation, classification, cru: null };
  const given = typeof classification === 'string' ? classification.trim() : '';
  return { appellation: CHAMPAGNE, classification: given ? `${cru}, ${given}` : cru, cru };
}

module.exports = { CHAMPAGNE, champagneCruOf, withoutChampagneCru, splitChampagneCru, foldAppellation };
