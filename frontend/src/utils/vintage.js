/**
 * Vintages are stored as a year, 'NV' (non-vintage) or 'Unknown'. The two
 * codes stay as they are in the data — the API, MCP, exports and URLs all
 * depend on them — and are translated only where they are shown, here.
 */

/** Display text for a stored vintage: 2015 → "2015", 'NV' → "NV" ("Uten årgang" in nb), empty → "". */
export function formatVintage(vintage, t) {
  if (vintage == null || vintage === '') return '';
  const v = String(vintage);
  if (v.toUpperCase() === 'NV') return t('common.nonVintage', 'NV');
  if (v.toLowerCase() === 'unknown') return t('common.unknownVintage', 'Unknown');
  return v;
}
