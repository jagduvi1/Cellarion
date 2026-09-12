/**
 * ONE definition of "may this caller see this registry wine".
 *
 * A pendingIdentity row is a half-identified wine that exists only because its
 * creator's bottle had to save. It is registry content to nobody yet, so the
 * rule — copied from the authenticated wine detail (routes/wines.js) and the
 * resolver's `pendingBlocked` (services/findOrCreateWine.js) — is:
 *
 *   • not pending            → visible to everyone
 *   • pending + you made it  → visible (your bottle page has to render)
 *   • pending + you curate   → visible (somm/admin: completing it is the job)
 *   • pending + anyone else  → NOT visible, reported as the same not-found a
 *                              missing id gets, so its existence never leaks
 *
 * It lives here rather than being re-typed at each call site because the
 * security audit found NINE routes that validated "wine exists" with a bare
 * findById/exists: reviews, wishlist, recommendations, wine reports, wine
 * requests, bottles, and the MCP write/bulk/wine-list tools. A rule spelled out
 * nine times is a rule nine places can forget.
 *
 * Expressed as a QUERY FILTER, not a post-filter: `pendingIdentity` and
 * `createdBy` are never in a caller's projection (SAFE_SELECT-style inclusive
 * selects omit both), and a post-filter reading an absent field is exactly the
 * dead gate this audit found in mcp/tools/wines.js — `undefined === true` is
 * false, so the check never fires. Mongo decides instead.
 */

const WineDefinition = require('../models/WineDefinition');
const { isValidId } = require('../utils/validation');

const CURATION_ROLES = ['somm', 'admin'];

/** somm/admin — the roles whose job is completing pending rows. */
const isCurator = (roles) => Array.isArray(roles) && roles.some((r) => CURATION_ROLES.includes(r));

/**
 * The one clause that keeps PRIVATE DRAFTS out of a query (support ticket
 * 2026-09-12). A draft is `pendingIdentity: true` as well (model invariant),
 * so every pending exclusion already hides it; this constant is for the
 * surfaces that deliberately INCLUDE pending rows — the curation queue, the
 * curator scan reads, the admin wine loads — and must still not see a draft.
 * Spread it, never re-type it.
 */
const DRAFT_EXCLUDED = { draft: { $ne: true } };

/**
 * The pending-identity clause for a WineDefinition query, for one viewer.
 *
 * Curation sees every pending row — completing them is the job — but NOT
 * another user's private draft: a draft is nobody's registry content yet, not
 * even a curator's. So the curator clause is a draft exclusion (plus the
 * curator's own drafts), and the plain clause is unchanged: a signed-in
 * caller's own pending rows already include their own drafts.
 *
 * `noDrafts` narrows further to "no draft at all, not even the caller's":
 * for the surfaces that SHARE or PUBLISH (reviews, recommendations, reports,
 * the correction queue, public registry data, the bridge) a draft is
 * unattachable by design — it is edited directly and published first.
 *
 * Callers that already use `$or` must merge with `$and` rather than
 * spreading — none of the current ones do.
 *
 * @param {{userId?: string, roles?: string[]}} [viewer]
 * @param {{noDrafts?: boolean}} [opts]
 */
function wineVisibilityFilter(viewer = {}, { noDrafts = false } = {}) {
  let clause;
  if (isCurator(viewer.roles)) {
    const alternatives = [DRAFT_EXCLUDED];
    if (viewer.userId) alternatives.push({ draft: true, createdBy: viewer.userId });
    clause = { $or: alternatives };
  } else {
    const alternatives = [{ pendingIdentity: { $ne: true } }];
    if (viewer.userId) alternatives.push({ pendingIdentity: true, createdBy: viewer.userId });
    clause = { $or: alternatives };
  }
  return noDrafts ? { ...clause, ...DRAFT_EXCLUDED } : clause;
}

/**
 * Is this ALREADY-LOADED wine visible to this viewer? For the defensive gates
 * where the document is in hand (rows attached before the write-time gates
 * existed). Needs `pendingIdentity` + `createdBy` on the doc — a projection
 * that omits them makes every row look non-pending, so prefer the filter.
 *
 * @param {{pendingIdentity?: boolean, createdBy?: any}|null} wine
 * @param {{userId?: string, roles?: string[]}} [viewer]
 */
function canSeeWine(wine, viewer = {}) {
  if (!wine) return false;
  // A draft is creator-only — before the curator branch, on purpose.
  if (wine.draft === true) return Boolean(viewer.userId) && String(wine.createdBy) === String(viewer.userId);
  if (wine.pendingIdentity !== true) return true;
  if (isCurator(viewer.roles)) return true;
  return Boolean(viewer.userId) && String(wine.createdBy) === String(viewer.userId);
}

/**
 * Decision 2 of the draft design: a draft is also visible to the members of
 * a shared cellar that holds a bottle of it — their bottle page has to
 * render. READ surfaces only; a member can look, never edit or publish.
 * Lazy requires keep this module's dependency tree at one model for the
 * nine gates that never need it.
 */
async function isDraftVisibleViaSharedCellar(wineId, userId) {
  if (!userId) return false;
  const Cellar = require('../models/Cellar');
  const Bottle = require('../models/Bottle');
  // The cellar's OWNER is `user`, not a member (utils/cellarAccess) — an
  // editor adding their draft bottle into someone else's cellar must leave
  // that owner able to read it too (audit 2026-09-12).
  const cellarIds = await Cellar.find({ $or: [{ user: userId }, { 'members.user': userId }], deletedAt: null }).distinct('_id');
  if (cellarIds.length === 0) return false;
  return Boolean(await Bottle.exists({ wineDefinition: wineId, cellar: { $in: cellarIds } }));
}

/**
 * Load one registry wine IF this viewer may see it — the shared replacement for
 * `WineDefinition.findById(id)` on every "does this wine exist" check. Returns
 * null both for a missing id and for a hidden one, on purpose: the caller's
 * existing not-found branch is then also the correct leak-free answer.
 *
 * @param {string} id                24-hex wine id (validated by the caller)
 * @param {object} [opts]
 * @param {string} [opts.userId]     viewer — req.user.id / ctx.user.id
 * @param {string[]} [opts.roles]    viewer roles — req.user.roles / ctx.user.roles
 * @param {string} [opts.select]     projection, as passed to .select()
 * @param {string|string[]|object} [opts.populate]
 * @param {boolean} [opts.lean=false]
 * @param {boolean} [opts.noDrafts=false]  exclude drafts entirely, even the
 *   caller's own — share/publish surfaces (see wineVisibilityFilter)
 * @param {boolean} [opts.viaSharedCellar=false]  READ surfaces: a draft the
 *   caller cannot see as creator is still returned when a shared cellar they
 *   belong to holds a bottle of it
 * @returns {Promise<object|null>}
 */
async function findVisibleWine(id, opts = {}) {
  const { userId, roles, select, populate, lean = false, noDrafts = false, viaSharedCellar = false } = opts;
  // Enforce the id contract HERE rather than trusting nine call sites to have
  // done it: one caller forgetting would let an operator object reach the
  // filter. A bad id is simply not-visible, which is the same answer this
  // helper already gives for a hidden or missing wine.
  if (!isValidId(String(id))) return null;
  const build = (filter) => {
    let q = WineDefinition.findOne(filter);
    if (select) q = q.select(select);
    if (populate) q = q.populate(populate);
    if (lean) q = q.lean();
    return q;
  };
  const wine = await build({ _id: String(id), ...wineVisibilityFilter({ userId, roles }, { noDrafts }) });
  if (wine || !viaSharedCellar || noDrafts) return wine;
  // A miss on a read surface: the one other way in is a shared cellar's bottle.
  if (!(await isDraftVisibleViaSharedCellar(String(id), userId))) return null;
  return build({ _id: String(id), draft: true });
}

module.exports = {
  CURATION_ROLES,
  DRAFT_EXCLUDED,
  isCurator,
  wineVisibilityFilter,
  canSeeWine,
  isDraftVisibleViaSharedCellar,
  findVisibleWine,
};
