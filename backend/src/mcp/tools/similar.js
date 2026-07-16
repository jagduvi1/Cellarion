// Semantic similarity via the EXISTING Qdrant wine embeddings (plan §3.17).
// find_similar_wines costs Cellarion $0 per call: the reference wine is already
// embedded (on add / by the batch job), so this is a point lookup + one vector
// search — no Voyage call, no LLM call. Free-text semantic_search_wines (which
// DOES embed the query) is deliberately Phase 3, not here.
//
// vectorStore + WineEmbedding are lazy-required: vectorStore reads embedding
// config at require time and this keeps the tool registry's load path lean.
const { z } = require('zod');
const WineDefinition = require('../../models/WineDefinition');
const { registerTool } = require('../registry');
const { isValidId } = require('../../utils/validation');
const { ok, fail, resolveBottleAccess, wineSummary } = require('../toolUtil');

const MAX_SIMILAR = 10;

registerTool({
  name: 'find_similar_wines',
  title: 'Find similar wines ("more like this")',
  description:
    'Given a registry wine_id (or one of the user\'s bottle_ids), returns wines with the closest taste/style profile ' +
    'from the shared registry, using vector similarity over wine embeddings. Call for "more like this", "what else is ' +
    'like my favourite Barolo", or to seed purchase ideas from a wine the user loves. Only wines that have been ' +
    'embedded are searchable — an empty result does not mean nothing similar exists.',
  scope: 'read',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    wine_id: z.string().optional().describe('Registry wine id (from search_registry or a bottle\'s wine)'),
    bottle_id: z.string().optional().describe('Alternatively: one of the user\'s bottle ids'),
    limit: z.number().int().min(1).max(MAX_SIMILAR).default(8),
  },
  handler: async (args, ctx) => {
    const WineEmbedding = require('../../models/WineEmbedding');
    const vectorStore = require('../../services/vectorStore');
    const aiConfig = require('../../config/aiConfig');

    // Resolve the reference wine (and preferred vintage) from either input.
    let wineId = null;
    let preferVintage = null;
    if (args.bottle_id) {
      const access = await resolveBottleAccess(ctx.user.id, args.bottle_id);
      if (!access) return fail('not_found', 'No such bottle, or you have no access to it. Find ids via search_bottles.');
      wineId = access.bottle.wineDefinition ? String(access.bottle.wineDefinition) : null;
      preferVintage = access.bottle.vintage || null;
      if (!wineId) return fail('not_found', 'That bottle has no registry wine yet (pending review) — similarity needs a registry wine.');
    } else if (args.wine_id) {
      if (!isValidId(args.wine_id)) return fail('invalid_input', 'wine_id must be a 24-hex Mongo id.');
      wineId = args.wine_id;
    } else {
      return fail('invalid_input', 'Provide wine_id or bottle_id.');
    }

    const indexVersion = aiConfig.get().vectorIndex;
    // Prefer the embedding of the same vintage; fall back to any 'ok' one.
    const embQuery = { wineDefinition: wineId, indexVersion, status: 'ok' };
    let emb = preferVintage
      ? await WineEmbedding.findOne({ ...embQuery, vintage: preferVintage }).lean()
      : null;
    if (!emb) emb = await WineEmbedding.findOne(embQuery).lean();
    if (!emb || !emb.qdrantPointId) {
      return ok('Reference wine has no embedding yet', [], {
        warnings: ['This wine has not been embedded yet (embeddings are created when bottles are added). Try search_registry for keyword matches instead.'],
      });
    }

    let points;
    try {
      points = await vectorStore.getPoints(indexVersion, [emb.qdrantPointId]);
    } catch {
      return fail('rate_limited', 'The similarity index is temporarily unavailable — try again shortly or use search_registry.');
    }
    const vector = points?.[0]?.vector;
    if (!Array.isArray(vector)) {
      return ok('Reference embedding unavailable', [], {
        warnings: ['The stored embedding could not be loaded. Use search_registry for keyword matches.'],
      });
    }

    const limit = Math.min(Math.max(parseInt(args.limit, 10) || 8, 1), MAX_SIMILAR);
    // Over-fetch: hits include the reference wine itself and one hit per
    // embedded vintage of the same wine — dedup to distinct wines below.
    const hits = await vectorStore.searchSimilar(indexVersion, vector, (limit + 1) * 3);
    const best = new Map(); // wineDefinitionId -> { score, vintage }
    for (const h of hits) {
      const id = h.payload?.wineDefinitionId ? String(h.payload.wineDefinitionId) : null;
      if (!id || id === String(wineId)) continue;
      if (!best.has(id)) best.set(id, { score: h.score, vintage: h.payload.vintage || null });
    }
    const ranked = [...best.entries()].slice(0, limit);
    if (ranked.length === 0) return ok('No similar wines found', []);

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
    return ok(`${data.length} similar wine(s)`, data);
  },
});
