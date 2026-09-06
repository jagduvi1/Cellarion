// Shared wine-registry read tools. Privilege parity with REST: GET /api/wines
// caps non-admin searches at 10 results (USER_SEARCH_LIMIT) — the MCP tool
// enforces the same cap, so a token never out-privileges the web UI.
//
// services/search is required lazily (ESM meilisearch — see tools/bottles.js).
const { z } = require('zod');
const WineDefinition = require('../../models/WineDefinition');
const { registerTool } = require('../registry');
const { isValidId } = require('../../utils/validation');
const { ok, fail, wineSummary, hasContent } = require('../toolUtil');
const { siteBaseUrl } = require('../../utils/siteUrl');
const { decorateGrapes } = require('../../utils/grapeDisplay');
const { publicProfileSummary } = require('../../services/registryTiering');
const { gateMcpRead, CAP_MESSAGE } = require('../../services/registryReadTracker');

const REGISTRY_LIMIT = 10; // == USER_SEARCH_LIMIT in routes/wines.js

// Fields safe to expose: never normalizedKey / createdBy / productNumber*.
const SAFE_SELECT = 'name producer slug country region appellation classification grapes type communityRating aiProfile lwin';

// Registry reads on this surface are 'public' scope — served to any token and
// to the anonymous /api/mcp/public surface — so there is no caller identity to
// compare against a pending row's creator. The rule is therefore absolute here:
// pendingIdentity rows are not registry content until they are completed.
// (Pending rows are not in Meilisearch either; this covers the Mongo paths.)
const VISIBLE = { nonWine: { $ne: true }, pendingIdentity: { $ne: true } };
// Search never returns a canary (registry lockdown L4: a customer must not be
// able to find a wine that does not exist); get_wine by id still serves one,
// because a direct fetch is the path a copier walks.
const SEARCH_VISIBLE = { ...VISIBLE, canary: { $ne: true } };

registerTool({
  name: 'search_registry',
  title: 'Search the shared wine registry',
  description:
    'Searches Cellarion\'s shared wine database (vintage-neutral wines, community data) by name, producer, region or ' +
    'grape. Returns up to 10 matches. Call to identify a wine the user mentions, before recommending, or to check ' +
    'whether a wine exists in the registry. This searches ALL known wines — use search_bottles for what the user owns.',
  // 'public': registry data is public-site content (every wine has a public
  // URL) — served to ANY authenticated token and to the anonymous
  // /api/mcp/public surface (Phase 6).
  scope: 'public',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    query: z.string().min(2).max(200).describe('Wine name, producer, appellation or grape'),
  },
  handler: async (args) => {
    const searchService = require('../../services/search');
    let wines = [];
    let viaEngine = false;
    if (searchService.getIsAvailable()) {
      try {
        const res = await searchService.search(args.query, { limit: REGISTRY_LIMIT });
        const docs = await WineDefinition.find({ _id: { $in: res.ids }, ...SEARCH_VISIBLE })
          .select(SAFE_SELECT).populate(['country', 'region', 'grapes']).lean();
        const byId = new Map(docs.map((d) => [String(d._id), d]));
        wines = res.ids.map((id) => byId.get(String(id))).filter(Boolean);
        viaEngine = true;
      } catch { /* fall through to Mongo text search */ }
    }
    if (!viaEngine) {
      wines = await WineDefinition.find(
        { $text: { $search: args.query }, ...SEARCH_VISIBLE },
        { score: { $meta: 'textScore' } }
      )
        .select(SAFE_SELECT).sort({ score: { $meta: 'textScore' } })
        .limit(REGISTRY_LIMIT).populate(['country', 'region', 'grapes']).lean();
    }
    const data = wines.map((w) => ({
      ...wineSummary(w),
      classification: w.classification || null,
      community_rating: w.communityRating?.reviewCount ? w.communityRating : null,
    }));
    return ok(`${data.length} registry match(es) (max ${REGISTRY_LIMIT})`, data);
  },
});

registerTool({
  name: 'get_wine',
  title: 'Get one registry wine',
  description:
    'Full registry record for one wine: producer, region, appellation, classification, grapes, community rating, and ' +
    'the AI tasting profile when the wine has been enriched. Vintage-neutral (bottles carry the vintage). ' +
    'Call after search_registry when the user wants depth on a specific wine.',
  // 'public' — same rationale as search_registry: this is the public wine
  // page's data over MCP.
  scope: 'public',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: { wine_id: z.string().describe('Registry wine id from search_registry or a bottle\'s wine') },
  handler: async (args, ctx) => {
    if (!isValidId(args.wine_id)) return fail('invalid_input', 'wine_id must be a 24-hex Mongo id.');
    // The exclusion is a QUERY clause, not a post-filter on the result. A
    // post-filter here was DEAD CODE (security audit): SAFE_SELECT is an
    // INCLUSIVE projection and does not list pendingIdentity, so under .lean()
    // the field is always undefined and `undefined === true` never fired —
    // this tool is 'public' scope, served by the UNAUTHENTICATED
    // /api/mcp/public surface, so that gate was the only thing standing between
    // an anonymous caller and a stranger's half-identified wine. nonWine rides
    // along in the same clause (it was never filtered here either). Compare
    // publicContent.js's drink_window_for, which selects the flag it tests.
    const raw = await WineDefinition.findOne({ _id: args.wine_id, ...VISIBLE })
      .select(SAFE_SELECT).populate(['country', 'region', 'grapes']).lean();
    // Same not_found a missing id gets, so a hidden row's existence never leaks.
    if (!raw) {
      return fail('not_found', 'No registry wine with that id. Find wines via search_registry.');
    }
    // Grapes surface as the regionally correct label for THIS wine's place
    // ("Tinta Roriz" on a Douro Port) — storage stays canonical, and the
    // grapes field keeps its array-of-strings shape.
    const w = decorateGrapes(raw);
    // Registry lockdown (2026-09-06): every read is counted per reader per
    // day; an anonymous address past the daily distinct cap is refused. The
    // anonymous surface gets the prose-only profile (L3) — the structured
    // dataset stays with signed-in connections.
    const anonymous = !!ctx?.anonymous || !ctx?.user;
    const gate = await gateMcpRead(ctx, w._id);
    if (!gate.allowed) return fail('rate_limited', CAP_MESSAGE);
    const profile = hasContent(w.aiProfile) ? w.aiProfile : null;
    return ok(`${w.name}${w.producer ? ` — ${w.producer}` : ''}`, {
      ...wineSummary(w),
      classification: w.classification || null,
      lwin7: w.lwin?.lwin7 || null,
      community_rating: w.communityRating?.reviewCount ? w.communityRating : null,
      tasting_profile: anonymous ? publicProfileSummary(profile) : profile,
      public_url: w.slug ? `${siteBaseUrl()}/wines/${w.slug}` : null,
    });
  },
});
