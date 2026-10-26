// Shared wine-registry read tools. Privilege parity with REST: GET /api/wines
// caps non-admin searches at 10 results (USER_SEARCH_LIMIT) — the MCP tool
// enforces the same cap, so a token never out-privileges the web UI.
//
// services/search is required lazily (ESM meilisearch — see tools/index.js).
const { z } = require('zod');
const WineDefinition = require('../../models/WineDefinition');
const { registerTool } = require('../registry');
const { isValidId } = require('../../utils/validation');
const { ok, fail, wineSummary, hasContent, objectId } = require('../toolUtil');
const { siteBaseUrl } = require('../../utils/siteUrl');
const { decorateGrapes } = require('../../utils/grapeDisplay');
const { publicProfileSummary } = require('../../services/registryTiering');
const { gateMcpRead, CAP_MESSAGE } = require('../../services/registryReadTracker');
const { absoluteImageUrl, isInlineImage } = require('../../services/photoState');
const { findOwnHiddenWineIds, isOwnHiddenWine } = require('../../services/ownHiddenWines');

// A caller's own quarantined drink (services/ownHiddenWines): not in the
// shared registry, so it says so wherever it is returned.
const OWN_HIDDEN_NOTE = 'Not in the shared registry: a drink other than wine that only this user has. They can still '
  + 'add bottles of it — pass this wine_id to add_bottle.';

const REGISTRY_LIMIT = 10; // == USER_SEARCH_LIMIT in routes/wines.js

// Fields safe to expose: never normalizedKey / createdBy / productNumber*.
// `draft` is selected so get_wine can SAY a row is the caller's private draft
// (the query below already guarantees only the creator can reach one).
const SAFE_SELECT = 'name producer slug country region appellation classification grapes type colour communityRating aiProfile lwin image imageCredit draft';

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
    'whether a wine exists in the registry. This searches ALL known wines — use search_bottles for what the user owns. ' +
    'A signed-in user\'s own drinks that are not wine (beer, cider, soft drinks — hidden from the shared registry) are ' +
    'listed first with only_in_your_cellar: true, so they can add more of them.',
  // 'public': registry data is public-site content (every wine has a public
  // URL) — served to ANY authenticated token and to the anonymous
  // /api/mcp/public surface (Phase 6).
  scope: 'public',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    query: z.string().min(2).max(200).describe('Wine name, producer, appellation or grape'),
  },
  handler: async (args, ctx) => {
    const searchService = require('../../services/search');
    let wines = [];
    let viaEngine = false;
    // The caller's own quarantined drinks first — never on the anonymous
    // surface, never anyone else's.
    let ownHidden = [];
    if (ctx?.user && !ctx.anonymous) {
      try {
        const ids = await findOwnHiddenWineIds(ctx.user.id, args.query);
        if (ids.length) {
          ownHidden = await WineDefinition.find({ _id: { $in: ids }, nonWine: true })
            .select(SAFE_SELECT).populate(['country', 'region', 'grapes']).lean();
        }
      } catch { /* the registry search still answers */ }
    }
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
    const data = [
      ...ownHidden.map((w) => ({ ...wineSummary(w), only_in_your_cellar: true, note: OWN_HIDDEN_NOTE })),
      ...wines.map((w) => ({
        ...wineSummary(w),
        classification: w.classification || null,
        community_rating: w.communityRating?.reviewCount ? w.communityRating : null,
      })),
    ];
    const ownPart = ownHidden.length ? ` + ${ownHidden.length} of the user's own drink(s) not in the registry` : '';
    return ok(`${wines.length} registry match(es) (max ${REGISTRY_LIMIT})${ownPart}`, data);
  },
});

registerTool({
  name: 'get_wine',
  title: 'Get one registry wine',
  description:
    'Full registry record for one wine: producer, region, appellation, classification, grapes, community rating, ' +
    'the AI tasting profile when the wine has been enriched, and the registry image (url + credit) when one is ' +
    'published — null means the wine has no public picture yet; to see the picture yourself, call get_photo with ' +
    'the wine_id. Vintage-neutral (bottles carry the vintage). For signed-in callers, pending_correction says ' +
    'whether a correction suggestion is awaiting review on this wine (one is allowed per wine, across all users), ' +
    'which fields it covers and whether it is the caller\'s own — check it before composing suggest_wine_correction. ' +
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
    // Registry lockdown (2026-09-06): every read is counted per reader per
    // day; an anonymous address past the daily distinct cap is refused. The
    // anonymous surface gets the prose-only profile (L3) — the structured
    // dataset stays with signed-in connections.
    const anonymous = !!ctx?.anonymous || !ctx?.user;
    // A signed-in caller may read their OWN private draft (support ticket
    // 2026-09-12) — the one exception to the absolute pending exclusion, and
    // it is in the QUERY, keyed on the creator, so nobody else's draft can
    // ever match. The anonymous surface keeps the absolute rule.
    const visible = anonymous
      ? VISIBLE
      : { nonWine: { $ne: true }, $or: [{ pendingIdentity: { $ne: true } }, { draft: true, createdBy: ctx.user.id }] };
    let raw = await WineDefinition.findOne({ _id: args.wine_id, ...visible })
      .select(SAFE_SELECT).populate(['country', 'region', 'grapes']).lean();
    // The caller's own quarantined drink: search_registry lists it for them,
    // so reading it by id works too. Anyone else gets the same not_found.
    let ownHidden = false;
    if (!raw && !anonymous && await isOwnHiddenWine(ctx.user.id, args.wine_id)) {
      raw = await WineDefinition.findOne({ _id: args.wine_id, nonWine: true })
        .select(SAFE_SELECT).populate(['country', 'region', 'grapes']).lean();
      ownHidden = !!raw;
    }
    // Same not_found a missing id gets, so a hidden row's existence never leaks.
    if (!raw) {
      return fail('not_found', 'No registry wine with that id. Find wines via search_registry.');
    }
    // Grapes surface as the regionally correct label for THIS wine's place
    // ("Tinta Roriz" on a Douro Port) — storage stays canonical, and the
    // grapes field keeps its array-of-strings shape.
    const w = decorateGrapes(raw);
    const gate = await gateMcpRead(ctx, w._id);
    if (!gate.allowed) return fail('rate_limited', CAP_MESSAGE);
    const profile = hasContent(w.aiProfile) ? w.aiProfile : null;
    // Support ticket 2026-09-12: the one-pending-per-wine rule was only
    // discoverable by composing a correction and having it refused. Signed-in
    // callers see the queue state (fields + whether it is theirs; never whose
    // otherwise, never the proposed values). Omitted for the anonymous
    // surface — queue state is not public-site content.
    // A draft has no queue state: it is edited directly, never corrected.
    const pendingCorrection = anonymous || w.draft === true
      ? undefined
      : await require('../../services/wineProposalOps').pendingForWine(w._id, ctx.user.id);
    return ok(`${w.name}${w.producer ? ` — ${w.producer}` : ''}`, {
      ...wineSummary(w),
      classification: w.classification || null,
      lwin7: w.lwin?.lwin7 || null,
      community_rating: w.communityRating?.reviewCount ? w.communityRating : null,
      tasting_profile: anonymous ? publicProfileSummary(profile) : profile,
      // The same picture the public wine page shows; a caller's own pending
      // photos are on get_bottle → photos, never here. The credit stays with
      // signed-in callers, as on the REST public projection; an inline data:
      // image is not shipped (up to 500 kB) — the page shows it.
      image: w.image
        ? {
            url: absoluteImageUrl(w.image),
            ...(isInlineImage(w.image) ? { inline: true, see: 'public_url' } : {}),
            ...(anonymous ? {} : { credit: w.imageCredit || null }),
          }
        : null,
      // A draft has no public page and no queue state: it is the caller's own
      // record. Neither does an own quarantined drink.
      public_url: w.draft === true || ownHidden ? null : (w.slug ? `${siteBaseUrl()}/wines/${w.slug}` : null),
      ...(ownHidden ? { only_in_your_cellar: true, note: OWN_HIDDEN_NOTE } : {}),
      ...(anonymous ? {} : { pending_correction: w.draft === true ? null : pendingCorrection }),
      // (a draft answers null above: nothing to read, nothing to file)
      ...(w.draft === true ? {
        draft: true,
        draft_note: 'This is the user\'s PRIVATE DRAFT — not in the shared registry yet. Edit it with update_wine_draft; publish it with publish_wine (list_wine_drafts shows every draft with its deadline).',
      } : {}),
    });
  },
});

// ── The Other category on the user's word ────────────────────────────────────
registerTool({
  name: 'mark_not_wine',
  title: 'Move a drink that is not wine to the Other category',
  description:
    'For a cider, beer, spirit or soft drink the user keeps under a wine record: moves the record out of the shared ' +
    'wine registry into the user\'s Other category. Their bottles, racks and notes stay as they are; the drink keeps ' +
    'no wine type and gets no drink window or tasting profile. Applies at once when at most three members hold ' +
    'bottles of it; otherwise it files a curator proposal and the answer says so. Only a member holding a bottle of ' +
    'it may call this. NOT undoable via undo_last — an admin restores a row that was wine after all. For a drink the ' +
    'user is adding now, pass category "other" on add_bottle new_wine instead.',
  scope: 'write',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: {
    wine_id: objectId.describe('The record\'s wine_id, from get_bottle or search_bottles'),
  },
  handler: async (args, ctx) => {
    const { markNotWineByMember } = require('../../services/nonWineOps');
    const r = await markNotWineByMember({ wineId: args.wine_id, userId: ctx.user.id, req: ctx.req, via: 'mcp' });
    if (!r.ok) {
      const code = r.code === 'not_found' ? 'not_found' : r.code === 'forbidden' ? 'forbidden' : 'invalid_input';
      return fail(code, r.message);
    }
    const note = {
      applied: 'Moved to Other: it has left the shared wine registry and stays in the user\'s cellar.',
      already: 'This record is already in the Other category.',
      filed: `${r.holders} members hold bottles of it, so a curator will decide; nothing changed yet.`,
      pending: 'A curator proposal to mark it as not wine is already waiting; nothing changed yet.',
    }[r.status];
    return ok({ wine_id: String(args.wine_id), status: r.status, category: r.category, note });
  },
});
