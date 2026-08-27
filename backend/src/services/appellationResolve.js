/**
 * Canonical appellation SPELLING at mint time (registry strategy 2026-07-29,
 * R2 — the write-time half; the seed script and the unmatched review queue
 * are the other halves).
 *
 * Wines store the appellation as a free string, and `appellation_wrong` was
 * the single largest category of the 2026-07-26 registry audit (231 rows):
 * with no membership list, every writer invents its own spelling and every
 * rule that reasons about appellations has to guess grammatically (the
 * "Clairette de Die" false positive — "Die" read as a German article instead
 * of the Drôme town, PR #850).
 *
 * This resolver is the Grape treatment, not the Country treatment: when the
 * typed appellation matches a curated Appellation doc (by normalized name or
 * synonym), the doc's canonical display spelling is adopted — so variants
 * collapse into ONE string on wines and the membership list actually governs
 * what the registry shows. When nothing matches, the free text is kept
 * verbatim: appellations are genuinely open-ended (new AVAs and DOCs appear,
 * and oddities like "Vin de France" are legitimate), so an unknown value is
 * REVIEWED (admin unmatched queue), never rejected — a user adding a bottle
 * must not be blocked by taxonomy.
 *
 * MEMBERSHIP-GATED DECORATION STRIPPING (2026-08-12). Some label decorations
 * cannot be stripped BLINDLY by normalizeAppellation, because the tokens
 * collide with real place names: a trailing "do" is a Spanish/Portuguese tier
 * mark in "Yecla DO" and an ordinary word inside "Ribera del Duero"-style
 * names, and "Appellation … Contrôlée" wraps a name that is itself the
 * appellation. utils/normalize therefore leaves them alone on purpose — a
 * blind strip there would corrupt legitimate names with no way to tell.
 *
 * The resolver CAN strip them, because it does not have to be right on its
 * own: a stripped variant is only ever ADOPTED when it matches a curated doc,
 * and what gets stored is the DOC's canonical spelling, never the stripped raw
 * string. Membership is the safety net — a real name that happens to end in a
 * stripped token simply matches nothing and passes through verbatim, exactly
 * as before. That asymmetry is why the stripping lives here and not in
 * utils/normalize, whose output is stored unconditionally.
 *
 * Found in prod: a somm proposal wrote appellation "Yecla DO" through the
 * proposal-approval path — the trailing "DO" survived normalizeAppellation
 * (deliberately) and no resolver ran, so a decorated variant of the curated
 * "Yecla" landed on the wine and fragmented it from every sibling.
 */
const Appellation = require('../models/Appellation');
const { normalizeAppellationKey } = require('../utils/normalize');

// The AOC/AOP wrapper, in the accent-folded, punctuation-stripped shape
// normalizeAppellationKey produces ("Contrôlée" → 'controlee', "d'Origine" →
// 'dorigine'). Trailing-only for the tier adjective and leading-only for the
// "Appellation" head, matching how the phrase is actually written on labels.
const AOC_TRAILING_TOKENS = new Set(['controlee', 'protegee']);

/** Trailing "DO" tier mark — the one normalizeAppellation cannot safely drop. */
const stripTrailingDo = (tokens) =>
  tokens.length > 1 && tokens[tokens.length - 1] === 'do' ? tokens.slice(0, -1) : null;

/**
 * "Appellation [d'Origine] X Contrôlée/Protégée" → X. Returns null when the
 * input carries no wrapper, so the caller only pays for a lookup when there is
 * actually something to try.
 */
function stripAocWrapper(tokens) {
  const out = tokens.slice();
  let stripped = false;
  if (out.length > 1 && out[0] === 'appellation') {
    out.shift();
    stripped = true;
    // "d'Origine" folds to one token; a spaced "d Origine" folds to two.
    if (out.length > 1 && out[0] === 'dorigine') out.shift();
    else if (out.length > 2 && out[0] === 'd' && out[1] === 'origine') out.splice(0, 2);
  }
  while (out.length > 1 && AOC_TRAILING_TOKENS.has(out[out.length - 1])) {
    out.pop();
    stripped = true;
  }
  return stripped && out.length > 0 ? out : null;
}

/**
 * Lookup keys to try, most faithful first: the string as typed, then the
 * decoration-stripped variants. First MATCH wins, so a curated name that
 * genuinely ends in "DO" is found by the exact key and never reaches the
 * stripped one.
 */
function candidateKeys(normalizedKey) {
  const tokens = normalizedKey.split(' ').filter(Boolean);
  const noDo = stripTrailingDo(tokens);
  const noAoc = stripAocWrapper(tokens);
  const variants = [tokens, noDo, noAoc];
  // Both decorations at once, from whichever side stripped first.
  if (noDo) variants.push(stripAocWrapper(noDo));
  if (noAoc) variants.push(stripTrailingDo(noAoc));
  const keys = [];
  for (const v of variants) {
    if (!v || v.length === 0) continue;
    const key = v.join(' ');
    if (key && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

/**
 * @returns {Promise<{found: boolean, name: string|null}>} found=false means no
 *   curated doc carries this key (try the next variant); found=true with a
 *   null name means curated docs matched but DISAGREE — the key IS known, so
 *   stripping further would be guessing, and the caller keeps the input.
 */
async function lookupCanonical(key) {
  // Docs can share a name across countries (the unique index is per-country);
  // adopt only when EVERY curated doc agrees on the display spelling — when
  // even the curated docs disagree, the typed spelling is not obviously
  // wrong and is left alone. limit(4) with an agree-all check (audit
  // 2026-07-29 A5: limit(2) could see two agreeing docs and miss a third
  // that disagrees); .sort keeps the answer deterministic across query
  // plans. Adoption is re-capped at 200 chars — the doc name is admin
  // input with its own validation, but the mint chokepoint's field cap must
  // hold regardless of where the string came from (audit A1).
  const docs = await Appellation.find({
    $or: [{ normalizedName: key }, { normalizedSynonyms: key }],
  }).select('name').sort({ _id: 1 }).limit(4).lean();
  if (docs.length === 0) return { found: false, name: null };
  if (docs.every(d => d.name === docs[0].name)) return { found: true, name: docs[0].name.slice(0, 200) };
  return { found: true, name: null };
}

/**
 * @param {string} rawAppellation  tier-stripped, trimmed appellation string
 * @returns {Promise<string>} canonical spelling when curated, else the input.
 *   Never throws — on lookup failure the input is kept; a mint must not fail
 *   over taxonomy.
 */
async function resolveCanonicalAppellation(rawAppellation) {
  if (!rawAppellation) return rawAppellation;
  const normalized = normalizeAppellationKey(rawAppellation);
  if (!normalized) return rawAppellation;
  try {
    for (const key of candidateKeys(normalized)) {
      const hit = await lookupCanonical(key);
      if (hit.found) return hit.name === null ? rawAppellation : hit.name;
    }
    return rawAppellation;
  } catch (err) {
    console.warn('[appellationResolve] lookup failed (non-fatal, keeping input):', err.message);
    return rawAppellation;
  }
}

/**
 * Does this appellation string resolve to a curated entry that PLACES the
 * wine — i.e. one carrying a region link? (Somm ticket 6a8eb2a9: the
 * producer-suspect narrowing — "a négociant bottling in Graves still has a
 * knowable house behind it".)
 *
 * The test is deliberately about the CURATED ENTRY's geography, not about
 * the field being populated: "Vin de France" is curated but nationwide
 * (region null) → false; "Qualitätswein" is a quality tier, not curated →
 * false — both were named by the somm as rows a naive non-empty check would
 * wrongly clear. Multi-doc keys (same name across countries) must agree:
 * EVERY matched doc needs a region, mirroring lookupCanonical's
 * all-must-agree stance — suppressing a suspicion is a publish decision, so
 * ambiguity counts as no.
 *
 * Never throws; a lookup failure returns false — a flag must not be
 * suppressed over taxonomy trouble.
 */
async function appellationHasGeography(rawAppellation) {
  if (!rawAppellation) return false;
  const normalized = normalizeAppellationKey(rawAppellation);
  if (!normalized) return false;
  try {
    for (const key of candidateKeys(normalized)) {
      const docs = await Appellation.find({
        $or: [{ normalizedName: key }, { normalizedSynonyms: key }],
      }).select('region').sort({ _id: 1 }).limit(4).lean();
      if (docs.length === 0) continue; // unknown key — try the next variant
      return docs.every(d => d.region != null);
    }
    return false;
  } catch (err) {
    console.warn('[appellationResolve] geography lookup failed (non-fatal, keeping flag):', err.message);
    return false;
  }
}

// candidateKeys is exported for services/taxonomyReview: the unmatched queue
// must consider a string COVERED when any of its stripped variants matches a
// curated doc (release-audit F2) — otherwise "Yecla DO" sits in the queue,
// an admin promotes it, and the minted doc's exact-match hit permanently
// disables the very stripping that would have folded it. One key function,
// two consumers, no drift.
module.exports = { resolveCanonicalAppellation, candidateKeys, appellationHasGeography };
