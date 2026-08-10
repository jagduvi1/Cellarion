/**
 * SAME-WINE fragmentation detectors (curator ticket d4a0e96b, 2026-08-10).
 *
 * Every existing duplicate net keys off the wine NAME in some form —
 * canonicalKey, normalizedKey, the fuzzy cluster scan. When one wine is split
 * across records whose name strings genuinely differ ("Haut-Médoc" vs "Cru
 * Bourgeois Haut-Médoc", "Moulis" vs "Moulis Médoc"), there is nothing to
 * normalize and nothing ever collides, so the split is invisible: the curator
 * documented 12 such producer splits by hand. Two detectors, both REVIEW
 * queues — no auto-merge, pure reads:
 *
 * 1. sameProducerAppellationGroups — the curator's evidence-backed rule: two
 *    records sharing an EXACT producer key AND EXACT appellation key are merge
 *    candidates. The discriminator against legitimate multi-cuvée estates is
 *    the vintage axis: an estate makes both cuvées most years (vintage sets
 *    overlap), while fragments of ONE wine split its vintages between records
 *    (sets are disjoint). Disjoint groups sort first; overlapping groups still
 *    list, just later — overlap is evidence, not proof.
 *
 * 2. nearProducerPairs — producer keys within Levenshtein distance 1..2 INSIDE
 *    the same (country, appellation) bucket ("Pierre Charau"/"Pierre Chanau",
 *    Tavel). An unscoped edit-distance sweep over ~5.5k producers is noise;
 *    the appellation is the cheap discriminator that makes distance 1-2 mean
 *    "typo", not "different estate".
 *
 * Both scans fetch the registry once with a small projection and group in
 * memory — the registry is ~5.5k rows, the same full-fetch pattern (and cost)
 * as the duplicate-clusters and producer-in-name scans, fine at this size.
 * Producer/appellation keys come from utils/normalize.js — composed, never
 * copied, so a normalizeProducerKey upgrade upgrades these queues for free.
 */
const WineDefinition = require('../models/WineDefinition');
const Bottle = require('../models/Bottle');
const WineVintageProfile = require('../models/WineVintageProfile');
const WineNotDuplicate = require('../models/WineNotDuplicate');
const {
  normalizeProducerKey,
  normalizeAppellationKey,
  levenshteinDistance,
} = require('../utils/normalize');

// Buckets larger than this are skipped by the pairwise producer comparison —
// a (country, appellation) holding hundreds of wines is a generic bucket
// ("Bordeaux") where edit-distance pairs are coincidence, and O(k²) over its
// distinct producers is cost without signal. Skips are counted and returned
// so the admin knows the scan was not exhaustive.
const MAX_PAIR_BUCKET = 200;

// Producer keys shorter than this never enter the pairwise comparison:
// one or two edits inside a 4-char key is a different word, not a typo.
const MIN_PRODUCER_KEY_LEN = 5;

const pairKey = (a, b) => (String(a) < String(b) ? `${a}|${b}` : `${b}|${a}`);

/**
 * Vintage evidence for a set of wine ids: per record, the union of its
 * bottles' vintages and its curated WineVintageProfile vintages, plus the
 * bottle count. 'Unknown' carries no year information and is dropped; 'NV'
 * deliberately COUNTS as shared evidence — two records both holding NV
 * bottles overlap the same (year-less) release, exactly like sharing 2019.
 * Fragments of a pure-NV wine are invisible to the vintage axis either way
 * (both sides hold NV); the group still lists, just without the disjoint flag.
 */
async function collectVintageEvidence(ids) {
  const vintageSets = new Map(); // String(wineId) -> Set(vintage)
  const bottleCounts = new Map(); // String(wineId) -> count
  if (ids.length === 0) return { vintageSets, bottleCounts };

  const [bottleAgg, profiles] = await Promise.all([
    Bottle.aggregate([
      { $match: { wineDefinition: { $in: ids } } },
      { $group: { _id: '$wineDefinition', count: { $sum: 1 }, vintages: { $addToSet: '$vintage' } } },
    ]),
    WineVintageProfile.find({ wineDefinition: { $in: ids } })
      .select('wineDefinition vintage')
      .lean(),
  ]);

  const add = (wineId, vintage) => {
    if (!vintage || vintage === 'Unknown') return;
    const key = String(wineId);
    let set = vintageSets.get(key);
    if (!set) { set = new Set(); vintageSets.set(key, set); }
    set.add(vintage);
  };
  for (const row of bottleAgg) {
    bottleCounts.set(String(row._id), row.count);
    for (const v of row.vintages || []) add(row._id, v);
  }
  for (const p of profiles) add(p.wineDefinition, p.vintage);

  return { vintageSets, bottleCounts };
}

/**
 * Detector 1 — records sharing an exact (producer key, appellation key).
 *
 * Groups with an empty appellation key are skipped (producer-only grouping is
 * too noisy — every estate's whole range would group), and so are empty
 * producer keys (all-stopword producers like "Domaine" would lump unrelated
 * estates into one bucket). Groups where the admin has dismissed EVERY member
 * pair as not-a-duplicate stop resurfacing — the same suppression, store and
 * keying (WineNotDuplicate {wineA, wineB}, smaller hex first) as the
 * canonical-collisions queue, so one "Not duplicates" click silences a group
 * across all three queues.
 *
 * @returns {Promise<{groups: Array, total: number, scannedCount: number}>}
 *   groups sorted disjoint-first, then size desc (pagination applied AFTER
 *   sorting, so page 1 is always the strongest candidates), each:
 *   { key, producer, appellation, disjoint,
 *     wines: [{ _id, name, producer, vintages, bottleCount }] }
 */
async function sameProducerAppellationGroups({ limit = 50, offset = 0 } = {}) {
  // Quarantined non-wines are excluded, same contract as every other
  // duplicate pool (code audit 2026-07-27, H3).
  const wines = await WineDefinition.find({ nonWine: { $ne: true } })
    .select('name producer appellation')
    .lean();

  const byKey = new Map(); // 'producerKey|appellationKey' -> wines[]
  for (const w of wines) {
    const producerKey = normalizeProducerKey(w.producer || '');
    const appellationKey = normalizeAppellationKey(w.appellation || '');
    if (!producerKey || !appellationKey) continue;
    const key = `${producerKey}|${appellationKey}`;
    let group = byKey.get(key);
    if (!group) { group = []; byKey.set(key, group); }
    group.push(w);
  }
  const candidates = [...byKey.entries()].filter(([, arr]) => arr.length >= 2);

  // Suppress groups whose every pair an admin already judged distinct.
  const notDup = await WineNotDuplicate.find({}).select('wineA wineB').lean();
  const dismissed = new Set(notDup.map(d => `${d.wineA}|${d.wineB}`));
  const active = candidates.filter(([, arr]) => {
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        if (!dismissed.has(pairKey(arr[i]._id, arr[j]._id))) return true;
      }
    }
    return false;
  });

  const ids = active.flatMap(([, arr]) => arr.map(w => w._id));
  const { vintageSets, bottleCounts } = await collectVintageEvidence(ids);

  // disjoint = no vintage appears on two DIFFERENT records of the group.
  const isDisjoint = (arr) => {
    const owner = new Map(); // vintage -> String(wine id) that first showed it
    for (const w of arr) {
      const wid = String(w._id);
      for (const v of vintageSets.get(wid) || []) {
        const seen = owner.get(v);
        if (seen === undefined) owner.set(v, wid);
        else if (seen !== wid) return false;
      }
    }
    return true;
  };

  const groups = active.map(([key, arr]) => {
    return {
      key,
      producer: arr[0].producer,
      appellation: arr[0].appellation || null,
      disjoint: isDisjoint(arr),
      wines: arr.map(w => ({
        _id: w._id,
        name: w.name,
        producer: w.producer,
        vintages: [...(vintageSets.get(String(w._id)) || [])].sort(),
        bottleCount: bottleCounts.get(String(w._id)) || 0,
      })),
    };
  });

  // Disjoint-first (the strong candidates), then size desc; producer, then
  // the unique group key, keep pagination deterministic between requests.
  groups.sort((a, b) =>
    (b.disjoint - a.disjoint) ||
    (b.wines.length - a.wines.length) ||
    String(a.producer).localeCompare(String(b.producer)) ||
    a.key.localeCompare(b.key));

  return {
    groups: groups.slice(offset, offset + limit),
    total: groups.length,
    scannedCount: wines.length,
  };
}

/**
 * Detector 2 — distinct producer keys within Levenshtein distance 1..2 inside
 * one (country, appellation key) bucket. Distance 0 (equal keys) is detector
 * 1's territory and is structurally excluded here — equal keys share one map
 * entry. No dismissal support: the not-a-duplicate store keys wine-id PAIRS,
 * and a producer-level dismissal has no clean mapping onto it (recording the
 * full bipartite product through the existing endpoint would also stamp each
 * producer's own wines as mutual non-duplicates, poisoning the cluster scan).
 *
 * @returns {Promise<{pairs: Array, total: number, scannedCount: number,
 *   skippedBuckets: number}>}
 *   pairs sorted distance asc, then combined record count desc (pagination
 *   after sorting), each:
 *   { key, appellation, distance,
 *     producers: [{ producer, recordCount, sampleNames }] × 2 }
 */
async function nearProducerPairs({ limit = 50, offset = 0 } = {}) {
  const wines = await WineDefinition.find({ nonWine: { $ne: true } })
    .select('name producer appellation country')
    .lean();

  // Bucket by (country id, appellation key); empty appellation keys are out —
  // without the appellation discriminator, edit-distance pairs are noise.
  const buckets = new Map();
  for (const w of wines) {
    const appellationKey = normalizeAppellationKey(w.appellation || '');
    if (!appellationKey) continue;
    const key = `${String(w.country || '')}|${appellationKey}`;
    let bucket = buckets.get(key);
    if (!bucket) { bucket = []; buckets.set(key, bucket); }
    bucket.push(w);
  }

  let skippedBuckets = 0;
  const pairs = [];
  for (const [bucketKey, bucket] of buckets.entries()) {
    if (bucket.length < 2) continue;
    if (bucket.length > MAX_PAIR_BUCKET) { skippedBuckets += 1; continue; }

    // Distinct producer keys in this bucket, with display string + members.
    const byProducer = new Map(); // producerKey -> { producer, names: [] }
    for (const w of bucket) {
      const k = normalizeProducerKey(w.producer || '');
      if (k.length < MIN_PRODUCER_KEY_LEN) continue; // short keys: an edit is a different word
      let entry = byProducer.get(k);
      if (!entry) { entry = { producer: w.producer, names: [] }; byProducer.set(k, entry); }
      entry.names.push(w.name);
    }

    const keys = [...byProducer.keys()];
    for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        // Length gap > 2 can never reach distance ≤ 2 — skip the O(m·n) walk.
        if (Math.abs(keys[i].length - keys[j].length) > 2) continue;
        const distance = levenshteinDistance(keys[i], keys[j]);
        if (distance < 1 || distance > 2) continue;
        const side = (k) => {
          const entry = byProducer.get(k);
          return {
            producer: entry.producer,
            recordCount: entry.names.length,
            sampleNames: entry.names.slice(0, 3),
          };
        };
        // Larger side first: the established spelling reads before the stray.
        const producers = [side(keys[i]), side(keys[j])].sort((a, b) =>
          (b.recordCount - a.recordCount) || a.producer.localeCompare(b.producer));
        pairs.push({
          // Bucket key (country id + appellation key) keeps the id unique
          // when the same producer pair recurs across countries.
          key: `${pairKey(keys[i], keys[j])}|${bucketKey}`,
          appellation: bucket[0].appellation || null,
          distance,
          producers,
        });
      }
    }
  }

  // Closest first (distance 1 beats 2), then the pair touching most records;
  // key as the final tie-break keeps pagination deterministic.
  pairs.sort((a, b) =>
    (a.distance - b.distance) ||
    ((b.producers[0].recordCount + b.producers[1].recordCount) -
     (a.producers[0].recordCount + a.producers[1].recordCount)) ||
    a.key.localeCompare(b.key));

  return {
    pairs: pairs.slice(offset, offset + limit),
    total: pairs.length,
    scannedCount: wines.length,
    skippedBuckets,
  };
}

module.exports = { sameProducerAppellationGroups, nearProducerPairs };
