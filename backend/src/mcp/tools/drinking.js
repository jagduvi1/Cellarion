// "What should I drink" tools (plan Phase 3): what_should_i_open_tonight and
// pair_with_dish. Both are candidate-shortlist generators — they select
// ready-to-drink bottles with the structured facts a sommelier would weigh
// (maturity + urgency, taste profile, rating, price, rack position, open-
// bottle state) and let the CALLING model make the actual choice. No LLM runs
// here (§5.2): the server curates data, the caller reasons.
//
// Selection/enrichment/scoring live in services/drinkingService.js — ONE
// implementation shared with any future UI feature (one-impl rule). This file
// is the MCP adapter: access resolution, zod schemas, envelopes.
const { z } = require('zod');
const Cellar = require('../../models/Cellar');
const { registerTool } = require('../registry');
const { cachedResult } = require('../resultCache');
const { ok, fail, objectId, MSG_CELLAR_NOT_FOUND, resolveCellarAccess } = require('../toolUtil');

const WINE_TYPES = ['red', 'white', 'rosé', 'sparkling', 'dessert', 'fortified'];
const MAX_LIMIT = 15;

/**
 * Resolve the cellar scope for candidate selection: the user's OWN cellars by
 * default (cellar-view semantics, like search_bottles); an explicit cellar_id
 * may be any cellar they can view. Returns { cellarIds, cellarName } or
 * { error } (an MCP fail envelope).
 */
async function resolveScope(ctx, args) {
  if (args.cellar_id) {
    const access = await resolveCellarAccess(ctx.user.id, args.cellar_id);
    if (!access) return { error: fail('not_found', MSG_CELLAR_NOT_FOUND) };
    return { cellarIds: [access.cellar._id], cellarName: access.cellar.name };
  }
  const cellars = await Cellar.find({ user: ctx.user.id, deletedAt: null }).select('_id').lean();
  return { cellarIds: cellars.map((c) => c._id), cellarName: null };
}

/** Both tools disclose what readiness screening did, not just what it kept. */
function notReadyNote(sel) {
  const { APPROACHING_YEARS } = require('../../services/drinkingService');
  const parts = [];
  if (sel.approaching) {
    parts.push(`${sel.approaching} bottle(s) are within ${APPROACHING_YEARS} year(s) of their drink window and are included as ` +
      'readiness "approaching" (see years_until_window) — youthful rather than wrong; weigh them yourself.');
  }
  parts.push(`${sel.notReady} bottle(s) further from their window excluded.`);
  return parts.join(' ');
}

registerTool({
  name: 'what_should_i_open_tonight',
  title: 'Tonight\'s candidates (ready to drink)',
  description:
    'Ready-to-drink candidates from the user\'s cellar, best-first: already-open bottles (finish those first), then ' +
    'bottles in closing drink windows, then peak-maturity bottles — each with taste profile, rating, price, drink ' +
    'window and exact rack position. Call for "what should I open/drink tonight", picking a bottle for an occasion, ' +
    'or any drink-now decision. YOU choose for the occasion and explain why; the list is ranked by readiness only. ' +
    'Bottles within 2 years of their drink window come last as readiness "approaching" (with years_until_window); ' +
    'identical bottles are one entry with a bottles count. ' +
    'Reserved ("spoken for") bottles are excluded — they are being held for someone or something.',
  scope: 'read',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    wine_type: z.enum(WINE_TYPES).optional().describe('Only this style, if the user specified one'),
    cellar_id: objectId.optional().describe('Restrict to one cellar (default: all own cellars)'),
    max_price: z.number().min(0).optional().describe('Only bottles at or under this price (in `currency`)'),
    currency: z.string().regex(/^[A-Za-z]{3}$/).optional().describe('Currency for max_price; defaults to the user\'s preference'),
    limit: z.number().int().min(1).max(MAX_LIMIT).default(8),
  },
  handler: (args, ctx) => cachedResult(
    'tonight', String(ctx.user.id),
    JSON.stringify([args.wine_type, args.cellar_id, args.max_price, args.currency, args.limit]),
    async () => {
    const { readyCandidates, serializeCandidates, groupSameWine } = require('../../services/drinkingService');
    const scope = await resolveScope(ctx, args);
    if (scope.error) return scope.error;
    const limit = Math.min(Math.max(parseInt(args.limit, 10) || 8, 1), MAX_LIMIT);
    const sel = await readyCandidates(ctx.user.id, scope.cellarIds, {
      wineType: args.wine_type, maxPrice: args.max_price, currency: args.currency,
    });
    const reservedNote = sel.reservedExcluded
      ? [`${sel.reservedExcluded} reserved ("spoken for") bottle(s) excluded — they are being held and are not drink-now candidates.`]
      : [];
    if (sel.ranked.length === 0) {
      return ok('No ready-to-drink bottles matched', [], {
        warnings: [
          `${sel.notReady} bottle(s) are not ready yet; ${sel.considered} matched the filters in total.`,
          ...reservedNote,
          ...(sel.priceWarning ? [sel.priceWarning] : []),
        ],
      });
    }
    const data = await serializeCandidates(groupSameWine(sel.ranked), sel.profileMap, scope.cellarIds, limit);
    const openCount = data.filter((c) => c.readiness === 'open').length;
    const urgentCount = data.filter((c) => c.readiness === 'declining' || c.readiness === 'late').length;
    return ok(
      // Same screened-total lead as pair_with_dish — and it must be the
      // UNFILTERED total (release-audit M-2): with wine_type/max_price set,
      // `considered` is the post-filter pool, and leading with it re-created
      // the very "the AI can only see part of my cellar" misreading this line
      // exists to kill.
      `Screened ${sel.totalActive} active bottle(s)` +
        `${sel.considered !== sel.totalActive ? ` (${sel.considered} matched the filters)` : ''}; ` +
        `${data.length} candidate(s)${scope.cellarName ? ` in "${scope.cellarName}"` : ''}` +
        `${openCount ? ` — ${openCount} already open` : ''}${urgentCount ? `, ${urgentCount} in closing windows` : ''}`,
      data,
      {
        warnings: [
          `Ranked by readiness, not by occasion — weigh price, occasion and taste yourself. ${notReadyNote(sel)}`,
          ...reservedNote,
          ...(sel.priceWarning ? [sel.priceWarning] : []),
        ],
      }
    );
  }),
});

registerTool({
  name: 'pair_with_dish',
  title: 'Cellar candidates for a dish',
  description:
    'Bottles from the user\'s OWN cellar that fit a dish: matches the dish against each wine\'s stored food-pairing ' +
    'and flavour data (keyword evidence, listed per match) and returns ready-to-drink candidates with full taste ' +
    'profiles, plus a style spread of other ready bottles so every style is on the table, and cellar_composition ' +
    '(every bottle counted by type and grape). Near-ready bottles (within 2 years of their window) are included as ' +
    'readiness "approaching"; taste.source/confidence say whether a profile is a sommelier\'s or an AI estimate. ' +
    'Call for "what goes with X", menu planning, or dinner-party picks. The keyword matches are HINTS — apply real pairing judgement over ' +
    'the taste profiles yourself. For buying ideas outside the cellar use semantic_search_wines instead.',
  scope: 'read',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    dish: z.string().min(2).max(200).describe('The dish, e.g. "duck confit", "grilled salmon with lemon"'),
    cellar_id: objectId.optional().describe('Restrict to one cellar (default: all own cellars)'),
    limit: z.number().int().min(1).max(MAX_LIMIT).default(8),
  },
  handler: (args, ctx) => cachedResult(
    'pair', String(ctx.user.id),
    JSON.stringify([String(args.dish || '').toLowerCase(), args.cellar_id, args.limit]),
    async () => {
    const { readyCandidates, serializeCandidates, scoreDishMatches, groupSameWine } = require('../../services/drinkingService');
    const scope = await resolveScope(ctx, args);
    if (scope.error) return scope.error;
    const limit = Math.min(Math.max(parseInt(args.limit, 10) || 8, 1), MAX_LIMIT);
    const sel = await readyCandidates(ctx.user.id, scope.cellarIds, {});
    if (sel.ranked.length === 0) {
      return ok('No ready-to-drink bottles to pair', [], {
        warnings: [
          `${sel.notReady} bottle(s) are not ready yet. Suggest the user widens the pool or looks at the registry.`,
          ...(sel.reservedExcluded ? [`${sel.reservedExcluded} reserved ("spoken for") bottle(s) excluded.`] : []),
        ],
      });
    }

    const scoreOf = await scoreDishMatches(args.dish, sel.ranked);
    // One slot per wine + vintage: identical bottles are one candidate.
    const grouped = groupSameWine(sel.ranked);
    const matched = grouped
      .filter((r) => scoreOf.has(String(r.b._id)))
      .sort((a, b) => scoreOf.get(String(b.b._id)).score - scoreOf.get(String(a.b._id)).score || a.rank - b.rank);
    const rest = grouped.filter((r) => !scoreOf.has(String(r.b._id)));

    // Style spread: best-readiness wine or two per wine type from the rest,
    // so the model can pair by style knowledge even with zero keyword hits.
    // Every type's first pick comes before any type's second, and the cap
    // never drops below the number of types — a 3-slot cap filled by two reds
    // and a sparkling once hid every white in the cellar (ticket 6aad5481).
    const perType = new Map();
    for (const r of rest) {
      const t = r.b.wineDefinition?.type || 'unknown';
      const arr = perType.get(t) || [];
      if (arr.length < 2) { arr.push(r); perType.set(t, arr); }
    }
    const firsts = [...perType.values()].map((arr) => arr[0]);
    const spread = [...firsts, ...[...perType.values()].flatMap((arr) => arr.slice(1))];

    const matchedOut = await serializeCandidates(matched, sel.profileMap, scope.cellarIds, Math.min(matched.length, limit));
    for (const c of matchedOut) {
      const s = scoreOf.get(String(c.bottle_id));
      c.match = { score: s.score, matched_on: s.terms };
    }
    const spreadLimit = Math.max(limit - matchedOut.length, 3, firsts.length);
    const spreadOut = await serializeCandidates(spread, sel.profileMap, scope.cellarIds, spreadLimit);

    return ok(
      // Lead with the screened total (support ticket 2026-08-12 "IA bottles
      // known false"): this tool reads the WHOLE cellar and returns a shortlist,
      // but a summary that only counts the shortlist reads as "the AI can see
      // 11 of my 72 bottles" to the person the answer is relayed to.
      `Screened all ${sel.totalActive} active bottle(s) in the cellar; returning a shortlist — ` +
        `${matchedOut.length} keyword match(es) for "${args.dish}", ${spreadOut.length} style-spread candidate(s). ` +
        'Tell the user the whole cellar was considered.',
      { matched: matchedOut, style_spread: spreadOut, cellar_composition: sel.composition },
      {
        warnings: [
          'Keyword matches come from stored pairing/flavour text — evidence, not verdicts. Wines without an enriched taste profile never keyword-match; judge those from grape, region and type.',
          'cellar_composition counts EVERY active bottle by type and grape — if a style that suits the dish is there but not shortlisted, find it with search_bottles.',
          'taste.source "ai" profiles are estimates (see taste.confidence); treat their sweetness and body as unverified.',
          notReadyNote(sel),
          ...(sel.reservedExcluded ? [`${sel.reservedExcluded} reserved ("spoken for") bottle(s) excluded — they are being held and are not candidates.`] : []),
        ],
      }
    );
  }),
});

module.exports = {};
