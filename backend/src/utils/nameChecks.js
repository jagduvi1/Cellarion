/**
 * The registry NAME-CHECK registry: the row-shaped data-quality rules an admin
 * can clear a wine for (support ticket 2026-07-26). Every rule's verdict reads
 * NOTHING but `name` and `producer` — that invariant is what lets
 * WineDefinition's pre-validate hook be a complete invalidation chokepoint for
 * clearances (see the verifiedChecks field comment there).
 *
 * Rule ids are VERSIONED. Refining a rule means bumping its id in the same
 * commit that edits its detect(), which invalidates that rule's clearances
 * across the whole registry while leaving every other rule's work intact.
 * nameChecks.snapshot.test.js pins each detect body's source and FAILS on an
 * un-snapshotted edit, so the bump cannot be forgotten silently.
 *
 * Residual, stated honestly: a change to a shared helper (stripProducerName,
 * normalizeString) alters a verdict without altering any detect body, so the
 * snapshot will not fire. That edit is itself a reviewed change to
 * producerPrefix.js / normalize.js, both of which have their own test suites.
 */
const { normalizeString } = require('./normalize');
// DANGLING_TAIL_WORDS lives in producerPrefix.js (which cannot require this
// module back) so the suffix-strip guard and the dangling-tail rule share one
// list — see its definition there for what it includes and why.
const {
  stripProducerName, stripProducerKeyPrefix, DANGLING_TAIL_WORDS,
} = require('./producerPrefix');

// House/estate words that legitimately OPEN a wine name equal to its producer —
// "Château Latour" the wine IS Château Latour the estate. Pre-normalized
// (normalizeString strips diacritics + punctuation: 'château' → 'chateau').
//
// A SEPARATE list from normalize.js WINE_STOP_WORDS on purpose: that set is
// tuned for fuzzy MATCHING and is re-tuned whenever the deduper misbehaves (it
// is also not exported). Sharing it would silently change what this scan flags
// every time the matcher is touched.
const ESTATE_WORDS = new Set([
  'chateau', 'chateaux', 'domaine', 'domaines', 'clos', 'mas', 'maison',
  'cave', 'caves', 'weingut', 'schloss', 'tenuta', 'tenute', 'castello',
  'cantina', 'cantine', 'azienda', 'fattoria', 'podere', 'poderi', 'cascina',
  'bodega', 'bodegas', 'vina', 'quinta', 'herdade', 'casa', 'finca',
]);

const nameEqualsProducer = (w) =>
  !!normalizeString(w.name || '') &&
  normalizeString(w.name || '') === normalizeString(w.producer || '');

const firstToken = (w) => normalizeString(w.name || '').split(' ')[0] || '';

/**
 * Each rule:
 *   id            - stable, VERSIONED. Bump on refinement.
 *   labelKey      - i18n leaf under admin.wines.producerInName.reasons.
 *                   Decoupled from `id` because i18next treats '.' as nesting.
 *   defaultActive - included when the scan is called with no ?check.
 *   detect        - (wine) => proposed replacement name | truthy detail | null.
 */
const NAME_CHECKS = [
  {
    // The pre-existing scan rule, unchanged, registered here so there is one
    // implementation and one place a clearance id is declared.
    id: 'producer-in-name.v1',
    labelKey: 'producerInName',
    defaultActive: true,
    detect: (w) => stripProducerName(w.name, w.producer) ?? stripProducerKeyPrefix(w.name, w.producer),
  },
  {
    // Defect (b) from the ticket. A SAFETY NET for rows already in the
    // registry; preventing NEW ones is a guard in stripProducerSuffix itself
    // (its own PR — it changes a function every write surface calls).
    id: 'dangling-name-tail.v1',
    labelKey: 'danglingTail',
    defaultActive: true,
    detect: (w) => {
      const tokens = normalizeString(w.name || '').split(' ').filter(Boolean);
      if (tokens.length < 2) return null; // a one-word name is not "dangling"
      return DANGLING_TAIL_WORDS.has(tokens[tokens.length - 1]) ? w.name : null;
    },
  },
  {
    // name === producer, NON-estate shape. Invisible to producer-in-name:
    // stripProducerPrefix/-Suffix both bail on `n.length <= p.length + 1`, and
    // stripProducerKeyPrefix on "nothing meaningful would remain".
    id: 'name-equals-producer.v1',
    labelKey: 'nameEqualsProducer',
    defaultActive: true,
    detect: (w) => (nameEqualsProducer(w) && !ESTATE_WORDS.has(firstToken(w)) ? w.name : null),
  },
  {
    // The ~139-row legitimate cohort (Château Latour, Domaine X). Registered
    // as a NAMED, QUERYABLE rule but NOT in the default queue — it neither
    // floods the review list nor becomes an invisible hardcoded exemption.
    // Open it deliberately with ?check=name-equals-producer-estate.v1.
    id: 'name-equals-producer-estate.v1',
    labelKey: 'nameEqualsProducerEstate',
    defaultActive: false,
    detect: (w) => (nameEqualsProducer(w) && ESTATE_WORDS.has(firstToken(w)) ? w.name : null),
  },
];

const NAME_CHECK_IDS = NAME_CHECKS.map(c => c.id);
const DEFAULT_CHECK_IDS = NAME_CHECKS.filter(c => c.defaultActive).map(c => c.id);
const byId = new Map(NAME_CHECKS.map(c => [c.id, c]));

/** Operator-injection-safe lookup for an untrusted body/query value. */
const resolveCheck = (id) =>
  (typeof id === 'string' && byId.has(id) ? byId.get(id) : null);

/**
 * Run a set of rules against one wine. Clearances come from the wine's own
 * verifiedChecks (undefined on legacy rows — .lean() applies no defaults, so
 * guard it). Returns { checks: [id], proposedName } or null when clean.
 */
function runNameChecks(wine, { checkIds = DEFAULT_CHECK_IDS, ignoreCleared = false } = {}) {
  const cleared = Array.isArray(wine.verifiedChecks) ? wine.verifiedChecks : [];
  const hits = [];
  let proposedName = null;
  for (const id of checkIds) {
    // Live lookup (not the load-time Map) so the rule list is the single
    // source of truth — the staleness contract test appends a rule and proves
    // clearances recorded before it existed cannot suppress it.
    const check = NAME_CHECKS.find(c => c.id === id);
    if (!check) continue;
    if (!ignoreCleared && cleared.includes(id)) continue;
    const detail = check.detect(wine);
    if (!detail) continue;
    hits.push(id);
    // Only producer-in-name has an auto-fix; it is first in NAME_CHECKS so its
    // proposal wins when several rules fire on the same row.
    if (proposedName === null && id === 'producer-in-name.v1') proposedName = detail;
  }
  return hits.length ? { checks: hits, proposedName } : null;
}

/** Fields runNameChecks reads — every scan's .select() must cover these. */
const NAME_CHECK_SELECT = 'name producer verifiedChecks';

module.exports = {
  NAME_CHECKS, NAME_CHECK_IDS, DEFAULT_CHECK_IDS, NAME_CHECK_SELECT,
  resolveCheck, runNameChecks, DANGLING_TAIL_WORDS, ESTATE_WORDS,
};
