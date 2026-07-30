/**
 * Locale coverage rules.
 *
 * Shared by three consumers, so it stays pure — no fs, no importing the locale
 * bundles themselves:
 *   - the Vite plugin that builds `virtual:locale-coverage` (Node, reads files)
 *   - translation.test.js (Vitest, reads bundles via import.meta.glob)
 *   - nothing at runtime: the app consumes the plugin's output, not this file
 *
 * Coverage counts UNITS, not raw keys: a plural family (`x_one`/`x_other`, plus
 * `_few`/`_many` in languages that have them) is one unit, the way Weblate
 * counts it, so languages with richer plural rules aren't scored against a
 * denominator English never had.
 */

// Keys only staff ever read. They're excluded from the denominator rather than
// counted as missing: a translator who finishes every screen a normal user can
// reach should read 100%, not 86% — the admin UI is 465 of 3,301 strings, so
// counting it would demand ~29% of a back-office they will never open before
// their language could ship. `audit`/`cellarAudit` are NOT staff (they back the
// rack and cellar activity views ordinary users see).
export const isStaffKey = (key) => /^admin/.test(key) || key.startsWith('moderationReports.');

// Below this share of user-facing units a language is still selectable, but
// labelled beta and never auto-selected from the browser's language list.
export const BETA_BELOW = 0.9;

// Languages whose first pass was drafted in bulk rather than typed by a
// speaker. They stay beta at any percentage until a human review pass clears
// them by hand.
//
// The percentage cannot make this call: coverage counts strings that are
// *filled*, and a bulk-drafted locale is 100% full and 0% read — which is
// exactly the state the beta label exists to disclose. Gating on Weblate's
// "approved" count instead is not an option either; that lives in Weblate's
// database, not in the locale files this module can see, and it would demote
// Swedish (96% translated, 1% approved) the day it landed.
//
// Removing a code from this set is the same deliberate, announced step as any
// other graduation out of beta — see TRANSLATING.md, and remember
// backend/src/config/languages.js.
export const MACHINE_DRAFTED = new Set(['fr', 'de']);

// A regional variant inherits its base language's status: an `fr-CA` directory
// branched from drafted `fr` is drafted too until reviewed.
const listed = (set, code) =>
  set.has(code) || set.has(String(code || '').split(/[-_]/)[0]);

export const isMachineDrafted = (code) => listed(MACHINE_DRAFTED, code);

// Languages no speaker has read yet. Distinct from MACHINE_DRAFTED on purpose:
// Swedish was typed by a human but sits at 1% approved in Weblate (3,196
// strings unreviewed), so it is unreviewed without being drafted.
//
// This flag is LABEL-ONLY. It deliberately does not touch `beta`, which is what
// governs SHIPPED_CODES, browser auto-detection and hreflang — demoting a
// language that is 98% translated and live in production would hand Swedish
// users an English UI to make a point about review process. Honesty about
// review status and fitness to ship are two different questions.
//
// Entries are cleared by hand as review lands; the app cannot see Weblate's
// approved count (see MACHINE_DRAFTED above).
export const UNREVIEWED = new Set(['fr', 'de', 'sv']);

export const isUnreviewed = (code) => listed(UNREVIEWED, code);

// Below this, a language isn't offered in the menu at all. Weblate creates a
// locale file the moment a language is requested, so without a floor the picker
// would advertise languages that are literally empty — an option that changes
// nothing when chosen reads as a broken app, not as an invitation. It stays
// selectable for anyone who already has it saved, and `?lng=<code>` previews it
// (see TRANSLATING.md), so a translator can still watch their work land.
export const LIST_ABOVE = 0.1;

// No /g flag — shared safely between callers (a global regex would carry
// lastIndex across .test() calls).
export const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;

export const flatten = (obj, prefix = '') =>
  Object.entries(obj).flatMap(([k, v]) => {
    const key = prefix ? `${prefix}.${k}` : k;
    return v && typeof v === 'object' && !Array.isArray(v) ? flatten(v, key) : [key];
  });

export const stripPlural = (key) => key.replace(PLURAL_SUFFIX, '');

export const get = (obj, path) =>
  path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

/** Distinct translatable units in a bundle, staff strings optionally dropped. */
const units = (bundle, { includeStaff = false } = {}) => {
  const keys = flatten(bundle).filter((k) => includeStaff || !isStaffKey(k));
  return new Set(keys.map(stripPlural));
};

/**
 * Share of English's user-facing units that `bundle` has a non-empty string for.
 * A unit counts as done when the locale supplies at least one plural form —
 * matching Weblate, which marks a plural unit complete per its own CLDR rules
 * rather than per English's two forms.
 */
export function coverageFor(en, bundle, options) {
  const total = units(en, options);
  const done = new Set();

  for (const key of flatten(bundle)) {
    const base = stripPlural(key);
    if (!total.has(base)) continue; // orphan or staff string — not in the denominator
    const value = get(bundle, key);
    if (typeof value === 'string' && value.trim() !== '') done.add(base);
  }

  return {
    translated: done.size,
    total: total.size,
    ratio: total.size === 0 ? 0 : done.size / total.size,
  };
}

/** `{ code, translated, total, ratio, beta, unreviewed }` — shipped to the app. */
export function localeStatus(code, en, bundle, options) {
  const { translated, total, ratio } = coverageFor(en, bundle, options);
  return {
    code,
    translated,
    total,
    ratio,
    beta: ratio < BETA_BELOW || isMachineDrafted(code),
    unreviewed: isUnreviewed(code),
  };
}
