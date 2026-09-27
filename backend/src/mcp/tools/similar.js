// Semantic similarity via the EXISTING wine embeddings (plan §3.17).
// find_similar_wines costs Cellarion $0 per call: the reference wine is already
// embedded (on add / by the batch job), so this is a stored-vector lookup + one
// in-memory vector search (services/vectorStore) — no Voyage call, no LLM call.
// Free-text semantic_search_wines (which DOES embed the query) is
// deliberately Phase 3, not here.
//
// vectorStore is lazy-required to keep the tool registry's load path lean.
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
    'Given a registry wine_id (or, on an authenticated connection, one of the user\'s bottle_ids), returns wines with ' +
    'the closest taste/style profile from the shared registry, using vector similarity over wine embeddings. Call for ' +
    '"more like this", "what else is like my favourite Barolo", or to seed purchase ideas from a wine the user loves. ' +
    'Only wines that have been embedded are searchable — an empty result does not mean nothing similar exists. ' +
    `Ids must be 24-hex Mongo ids from search_registry or search_bottles — a name or slug is not an id. Returns at most ${MAX_SIMILAR}.`,
  // 'public' (plan §3.17): the reference wine is already embedded, so this is
  // a stored-vector lookup — $0 per call and safe on the anonymous
  // /api/mcp/public surface. The bottle_id input is guarded below (anonymous
  // callers have no bottles).
  scope: 'public',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    wine_id: z.string().optional().describe('Registry wine id (24-hex) from search_registry or a bottle\'s wine'),
    bottle_id: z.string().optional().describe('Alternatively: one of the user\'s bottle ids (24-hex). Needs an authenticated connection — not available on the public endpoint.'),
    // Deliberately UNBOUNDED at the schema layer, unlike the mutating tools'
    // numeric inputs. A strict .min/.max here makes the SDK reject the whole
    // call with -32602 before the handler runs — and an over-large `limit` is
    // not a malformed request, it is a request to be capped. The handler clamps
    // (that clamp was previously unreachable for out-of-range values), so
    // "20 similar wines" now returns 10 instead of failing. z.coerce absorbs
    // the string-number an agent may send. Counting note: an SDK-level -32602
    // never reaches budgetedHandler, so it lands in NO McpUsageStat counter —
    // rejections here were invisible in the usage stats, not merely uncounted.
    limit: z.coerce.number().int().optional().describe(`How many to return (1-${MAX_SIMILAR}, default 8; larger values are capped, not rejected)`),
  },
  handler: async (args, ctx) => {
    const vectorStore = require('../../services/vectorStore');
    const aiConfig = require('../../config/aiConfig');

    // Resolve the reference wine (and preferred vintage) from either input.
    let wineId = null;
    let preferVintage = null;
    if (args.bottle_id) {
      // Anonymous callers (public MCP) have no bottles — refuse before any
      // deref instead of leaking a confusing not_found.
      if (!ctx.user) {
        return fail('invalid_input', 'bottle_id needs an authenticated connection — on the public endpoint use wine_id (from search_registry).');
      }
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

    const cfg = aiConfig.get();
    const scope = { model: cfg.embeddingModel, indexVersion: cfg.vectorIndex };

    // Registry lockdown (2026-09-06, L3): the anonymous surface walks the
    // neighbour graph five wines at a time — enough for "more like this",
    // too slow to map the registry by adjacency.
    const maxHere = ctx?.anonymous || !ctx?.user ? 5 : MAX_SIMILAR;
    const limit = Math.min(Math.max(parseInt(args.limit, 10) || 8, 1), maxHere);
    let ranked;
    // One guard for the whole lookup — a failure must not escape as a raw
    // error. `unavailable` is the honest code for a backend outage
    // (MCP-audit M3): an agent must NOT self-throttle as if rate_limited.
    try {
      // The reference's stored vector: the same vintage when given, else the
      // newest vintage with one (a deterministic pick).
      const vector = await vectorStore.getVector(wineId, preferVintage, scope);
      if (!vector) {
        return ok('Reference wine has no embedding yet', [], {
          warnings: ['This wine has not been embedded yet (embeddings are created when bottles are added). Try search_registry for keyword matches instead.'],
        });
      }
      // One hit per wine (its best vintage), the reference itself left out.
      const hits = await vectorStore.search(vector, { ...scope, limit, excludeWineId: wineId, distinctWines: true });
      ranked = hits.map((h) => [h.wineDefinitionId, { score: h.score, vintage: h.vintage || null }]);
    } catch {
      return fail('unavailable', 'The similarity search is unavailable right now. Use search_registry for keyword matches; retrying later may help.');
    }
    if (ranked.length === 0) return ok('No similar wines found', []);

    const docs = await WineDefinition.find({ _id: { $in: ranked.map(([id]) => id) }, pendingIdentity: { $ne: true }, canary: { $ne: true } })
      .select('name producer slug country region appellation classification grapes type colour communityRating')
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
