/**
 * Unify producer DISPLAY spellings across the registry (strategy 2026-07-29,
 * R1 — the ~85 spelling-splits the 2026-07-26 audit left on the backlog, plus
 * the Ribeauvillé accent split from support ticket 2026-07-28).
 *
 * Groups every wine by normalizeString(producer) — which folds accents, case
 * and punctuation but deliberately NOT corporate suffixes or stop words, so
 * "Kumeu River" vs "Kumeu River Wines Limited" (a judgement call) is left for
 * a human while "Ribeauvillé"/"Ribeauville"/"RIBEAUVILLE" (a typo) is unified.
 * Groups with more than one raw spelling are rewritten to the majority
 * spelling (most wines; ties → the spelling whose earliest wine is oldest,
 * matching services/producerSpelling.js so mint-time and cleanup agree).
 *
 * Safe by construction: normalizedKey, canonicalKey and slugs all fold the
 * spelling away, so this is a display-string-only update — verified per row
 * before writing (any row where the keys WOULD change is skipped and
 * reported, because that means the group was not a pure spelling variant).
 * Plain updateOne, no hooks needed: canonicalKey stays valid (invariant) and
 * verifiedChecks should NOT be cleared for a fold-equivalent respelling.
 *
 * Dry-run by default — prints every group and the chosen target. --apply to
 * write; after applying it triggers a Meilisearch fullSync (producer is
 * denormalized into search docs). Embeddings: producer is part of the
 * embedding text, so run the embedding job in incremental mode afterwards.
 *
 *   docker exec cellarion-backend node src/scripts/unify-producer-spellings.js
 *   docker exec cellarion-backend node src/scripts/unify-producer-spellings.js --apply
 */

const mongoose = require('mongoose');
const WineDefinition = require('../models/WineDefinition');
const { normalizeString } = require('../utils/normalize');
const { computeCanonicalKey } = require('../utils/wineIdentity');

(async () => {
  const apply = process.argv.includes('--apply');
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://mongo:27017/winecellar');

  const wines = await WineDefinition.find({})
    .select('name producer appellation canonicalKey nonWine createdAt')
    .lean();

  // group key → { spellings: Map<raw, {count, oldest, wines[]}> }
  const groups = new Map();
  for (const w of wines) {
    const key = normalizeString(w.producer || '');
    if (!key) continue;
    let g = groups.get(key);
    if (!g) { g = new Map(); groups.set(key, g); }
    // Whitespace-collapsed spelling candidates: "Wrights  Estate" must never
    // WIN a majority vote on the strength of its own duplication (first
    // prod-data dry run) — the double-space rows count toward the clean form.
    const spelling = String(w.producer).trim().replace(/\s+/g, ' ');
    let s = g.get(spelling);
    // oldest seeds null and is only ever set by VOTING rows — seeding it from
    // whichever row happens to iterate first let a quarantined row's ancient
    // createdAt flip the tie-break against producerSpelling.js's identical
    // rule (audit 2026-07-29 F1).
    if (!s) { s = { count: 0, oldest: null, wines: [] }; g.set(spelling, s); }
    // Quarantined rows get rewritten too (consistency) but no vote (their
    // data is exactly what we don't want to canonize) — mirror producerSpelling.js.
    if (!w.nonWine) {
      s.count += 1;
      if (s.oldest === null || w.createdAt < s.oldest) s.oldest = w.createdAt;
    }
    s.wines.push(w);
  }

  const ops = [];
  let groupsToUnify = 0;
  let skippedKeyDrift = 0;
  for (const [key, spellings] of groups) {
    if (spellings.size < 2) continue;
    groupsToUnify += 1;

    const ranked = [...spellings.entries()].sort((a, b) =>
      (b[1].count - a[1].count) || ((a[1].oldest ?? Infinity) - (b[1].oldest ?? Infinity)));
    const target = ranked[0][0];
    console.log(`  [${key}] → "${target}"  (${ranked.map(([sp, s]) => `"${sp}"×${s.count}`).join('  ')})`);

    for (const [spelling, s] of spellings) {
      for (const w of s.wines) {
        // Compare the STORED string, not the collapsed group spelling: a row
        // stored with a double space groups under the clean form and still
        // needs the rewrite.
        if (w.producer === target) continue;
        // Safety proof, per row: a pure spelling variant leaves canonicalKey
        // untouched. If it would change, this was NOT a trivial variant —
        // leave it for a human rather than silently altering identity keys.
        // Always compute BOTH sides fresh: a stored canonicalKey stamped by an
        // older algorithm (the tier-token list grows, #842) would false-skip a
        // pure spelling variant as "key drift" (audit 2026-07-29 F2).
        const before = computeCanonicalKey(w.name, spelling, w.appellation);
        const after = computeCanonicalKey(w.name, target, w.appellation);
        if (before !== after) {
          skippedKeyDrift += 1;
          console.log(`    SKIP (canonicalKey would change): "${w.name}" — "${spelling}" [${w._id}]`);
          continue;
        }
        ops.push({ updateOne: {
          filter: { _id: w._id },
          update: { $set: { producer: target, updatedAt: new Date() } },
        } });
      }
    }
  }

  console.log(`[unify-producer-spellings] ${apply ? 'APPLY' : 'DRY-RUN'} wines=${wines.length} splitGroups=${groupsToUnify} rowsToRewrite=${ops.length} skippedKeyDrift=${skippedKeyDrift}`);

  if (apply && ops.length > 0) {
    const res = await WineDefinition.bulkWrite(ops, { ordered: false });
    console.log(`[unify-producer-spellings] modified=${res.modifiedCount}`);
    try {
      await require('../services/search').fullSync();
      console.log('[unify-producer-spellings] Meilisearch fullSync done');
    } catch (e) {
      console.warn('[unify-producer-spellings] Meili sync failed — run fullSync manually:', e.message);
    }
    console.log('[unify-producer-spellings] NOTE: run the embedding job (incremental) — producer is in the embedding text.');
  }

  await mongoose.disconnect();
})().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
