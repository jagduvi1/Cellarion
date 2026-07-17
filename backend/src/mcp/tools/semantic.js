// semantic_search_wines (plan §3.17, the Phase-3 half of the RAG split):
// free-text meaning search over the EXISTING Qdrant wine embeddings. Unlike
// find_similar_wines ($0 — reuses a stored vector), a free-text query needs ONE
// Voyage query-embed, so this is the only MCP read with a real (fractional-cent)
// cost — defended in layers:
//   1. a per-user embed rate window (in-memory, mirrors the aiBurst default),
//   2. the shared per-user daily AI budget + global cap (services/aiBudget —
//      the same pool label-scan and enrichment draw from),
//   3. a query-vector cache, so repeats and rephrasings-into-identical-text
//      are free and never re-debited.
// Retrieval is cheap here; generation (the actual recommendation prose) happens
// in the CALLER's model for free — never proxy an LLM for this (§5.2).
const { z } = require('zod');
const Cellar = require('../../models/Cellar');
const Bottle = require('../../models/Bottle');
const WineDefinition = require('../../models/WineDefinition');
const { CONSUMED_STATUSES } = require('../../config/constants');
const { registerTool } = require('../registry');
const { ok, fail, wineSummary } = require('../toolUtil');

const MAX_RESULTS = 10;

// Query-vector cache: `${model}:${indexVersion}:${normalized query}` ->
// { at, vector }. Keyed by model + index so an admin switching the embedding
// provider (services/aiProvider era) can never serve wrong-dimension vectors
// from cache. A 2048-float vector is ~16 KB; 300 entries ≈ 5 MB. Eviction is
// oldest-first (Map = insertion order), not a wholesale clear — one user's
// churn must not force other users' repeats to re-debit their budgets. 1h TTL
// only bounds memory; embeddings of identical text are stable.
const vectorCache = new Map();
const VECTOR_TTL_MS = 60 * 60 * 1000;
const VECTOR_CACHE_MAX = 300;

// Per-user embed window: at most N NEW embeds (cache misses) per minute.
// Mirrors the aiBurst default (10/min) without wiring a config dependency —
// the daily budget above it is the admin-tunable knob.
const EMBEDS_PER_MINUTE = 10;
const embedWindow = new Map(); // userId -> { windowStart, count }

function takeEmbedSlot(userId) {
  const now = Date.now();
  const w = embedWindow.get(userId);
  if (!w || now - w.windowStart >= 60 * 1000) {
    if (embedWindow.size > 5000) {
      // Sweep expired windows only — never reset other users' LIVE windows.
      for (const [k, v] of embedWindow) {
        if (now - v.windowStart >= 60 * 1000) embedWindow.delete(k);
      }
    }
    embedWindow.set(userId, { windowStart: now, count: 1 });
    return true;
  }
  if (w.count >= EMBEDS_PER_MINUTE) return false;
  w.count += 1;
  return true;
}

registerTool({
  name: 'semantic_search_wines',
  title: 'Search wines by meaning (taste, mood, style)',
  description:
    'Meaning-based search over wine taste/style embeddings — describe a flavour, mood or style in free text ' +
    '("earthy and rustic", "crisp mineral white like Chablis", "something for a rainy evening") and get the ' +
    'closest wines. scope "registry" searches everything Cellarion knows (buying ideas); scope "mine" searches only ' +
    'wines the user owns. Use search_bottles/search_registry for NAME lookups — this tool is for when no name ' +
    'exists, only a description. Uses a small slice of the user\'s daily AI budget per new query (repeats are free); ' +
    'only embedded wines are findable.',
  scope: 'read',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    query: z.string().min(3).max(200).describe('The taste/style/mood description to search for'),
    search_scope: z.enum(['registry', 'mine']).default('registry').describe('"registry" = all wines; "mine" = only wines in the user\'s cellars'),
    limit: z.number().int().min(1).max(MAX_RESULTS).default(8),
  },
  handler: async (args, ctx) => {
    const vectorStore = require('../../services/vectorStore');
    const aiConfig = require('../../config/aiConfig');
    const { tryDebitAi } = require('../../services/aiBudget');

    const query = String(args.query || '').toLowerCase().replace(/\s+/g, ' ').trim();
    if (query.length < 3) return fail('invalid_input', 'query must be at least 3 characters.');
    const searchScope = args.search_scope || 'registry';
    const limit = Math.min(Math.max(parseInt(args.limit, 10) || 8, 1), MAX_RESULTS);

    // 1. Vector for the query — cache first, then budget + embed.
    const cfg = aiConfig.get();
    const cacheKey = `${cfg.embeddingModel || 'default'}:${cfg.vectorIndex}:${query}`;
    let vector;
    const hit = vectorCache.get(cacheKey);
    if (hit && Date.now() - hit.at < VECTOR_TTL_MS) {
      vector = hit.vector;
    } else {
      if (!takeEmbedSlot(String(ctx.user.id))) {
        return fail('rate_limited', 'Too many new semantic searches this minute — reuse recent queries or wait a moment.');
      }
      const debit = await tryDebitAi(String(ctx.user.id), { isDemo: !!ctx.user.isDemo });
      if (!debit.ok) {
        return fail('budget_exhausted',
          `The user's daily AI budget is used up (${debit.reason}); semantic search needs one AI call per new query. ` +
          `It resets in ${Math.ceil((debit.retryAfterSeconds || 0) / 3600)}h — use search_registry / search_bottles keywords meanwhile.`);
      }
      try {
        const { embedSingle } = require('../../services/embedding');
        vector = await embedSingle(query, { model: cfg.embeddingModel });
        if (!Array.isArray(vector)) throw new Error('embedding returned no vector');
      } catch (err) {
        await debit.refund();
        return fail('rate_limited', 'The embedding service is unavailable right now — use search_registry keywords; retrying later may help.');
      }
      if (vectorCache.size >= VECTOR_CACHE_MAX) {
        vectorCache.delete(vectorCache.keys().next().value); // oldest entry
      }
      vectorCache.set(cacheKey, { at: Date.now(), vector });
    }

    // 2. Optional "mine" filter: restrict hits to wines in the user's cellars.
    let filter;
    if (searchScope === 'mine') {
      const cellars = await Cellar.find({ user: ctx.user.id, deletedAt: null }).select('_id').lean();
      const wineIds = cellars.length
        ? await Bottle.distinct('wineDefinition', {
            cellar: { $in: cellars.map((c) => c._id) },
            status: { $nin: CONSUMED_STATUSES },
            wineDefinition: { $ne: null },
          })
        : [];
      if (wineIds.length === 0) {
        return ok('No embedded wines in the cellar to search', [], {
          warnings: ['The user owns no active bottles with registry wines — search scope "registry" still works.'],
        });
      }
      filter = { must: [{ key: 'wineDefinitionId', match: { any: wineIds.map((id) => String(id)) } }] };
    }

    // 3. Vector search + dedup to distinct wines (multiple vintages of one wine
    //    are separate points — keep the best-scoring one).
    const indexVersion = aiConfig.get().vectorIndex;
    const FETCH = (limit + 1) * 5;
    let hits;
    try {
      hits = await vectorStore.searchSimilar(indexVersion, vector, FETCH, filter ? { filter } : {});
    } catch {
      return fail('rate_limited', 'The similarity index is unavailable (it may be down or rebuilding). Use search_registry for keyword matches; retrying later may help.');
    }
    const best = new Map(); // wineDefinitionId -> { score, vintage }
    for (const h of hits || []) {
      const id = h.payload?.wineDefinitionId ? String(h.payload.wineDefinitionId) : null;
      if (!id) continue;
      if (!best.has(id)) best.set(id, { score: h.score, vintage: h.payload.vintage || null });
    }
    const ranked = [...best.entries()].slice(0, limit);
    if (ranked.length === 0) {
      return ok('No semantic matches', [], {
        warnings: ['Only wines with embeddings are searchable (created when bottles are added/enriched) — try different wording or search_registry keywords.'],
      });
    }

    const docs = await WineDefinition.find({ _id: { $in: ranked.map(([id]) => id) } })
      .select('name producer slug country region appellation classification grapes type communityRating')
      .populate(['country', 'region', 'grapes'])
      .lean();
    const byId = new Map(docs.map((d) => [String(d._id), d]));
    const data = ranked
      .filter(([id]) => byId.has(id))
      .map(([id, m]) => ({
        ...wineSummary(byId.get(id)),
        similarity: Math.round(m.score * 1000) / 1000,
        embedded_vintage: m.vintage,
      }));
    return ok(`${data.length} wine(s) matching "${args.query}" (${searchScope})`, data);
  },
});

module.exports = { takeEmbedSlot };
