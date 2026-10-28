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

// The words a vintage field accepts besides a year: the stored codes, and
// their translations in the user's language (Johan, #1690).
function vintageWords(t) {
  return {
    // An empty translation (a scaffolded sibling, a blank) must never make
    // the empty field read as a code.
    NV: [...new Set(['NV', t('common.nonVintage', 'NV')])].filter(Boolean),
    Unknown: [...new Set(['Unknown', t('common.unknownVintage', 'Unknown')])].filter(Boolean),
  };
}

/** Stored value for what was typed: "nv", "Uten årgang" → 'NV'; anything else comes back trimmed, for the usual validation. */
export function parseVintageInput(input, t) {
  const v = String(input ?? '').trim();
  if (!v) return v;
  const lower = v.toLocaleLowerCase();
  for (const [code, words] of Object.entries(vintageWords(t))) {
    if (words.some((w) => w.toLocaleLowerCase() === lower)) return code;
  }
  return v;
}

// One letter → "[nN]": the pattern attribute has no case-insensitive flag.
const caseless = (word) => [...word].map((ch) => {
  const up = ch.toLocaleUpperCase();
  const low = ch.toLocaleLowerCase();
  if (up !== low && up.length === 1 && low.length === 1) return `[${low}${up}]`;
  return ch.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}).join('');

/** pattern and maxLength for a vintage <input>: a year from 1900, or one of the words in any case. */
export function vintageInputProps(t) {
  const words = Object.values(vintageWords(t)).flat();
  return {
    pattern: `^(?:${words.map(caseless).join('|')}|(?:19|20)\\d{2})$`,
    maxLength: Math.max(7, ...words.map((w) => w.length)),
  };
}
