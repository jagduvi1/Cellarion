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

const CURATION_ROLES = ['somm', 'admin'];

/** somm/admin — the roles whose job is completing pending rows. */
const isCurator = (roles) => Array.isArray(roles) && roles.some((r) => CURATION_ROLES.includes(r));

/**
 * The pending-identity clause for a WineDefinition query, for one viewer.
 *
 * Returns `{}` for curation (they see everything) so the clause can always be
 * spread into a filter. Callers that already use `$or` must merge with `$and`
 * rather than spreading — none of the current ones do.
 *
 * @param {{userId?: string, roles?: string[]}} [viewer]
 */
function wineVisibilityFilter(viewer = {}) {
  if (isCurator(viewer.roles)) return {};
  const alternatives = [{ pendingIdentity: { $ne: true } }];
  if (viewer.userId) alternatives.push({ pendingIdentity: true, createdBy: viewer.userId });
  return { $or: alternatives };
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
  if (wine.pendingIdentity !== true) return true;
  if (isCurator(viewer.roles)) return true;
  return Boolean(viewer.userId) && String(wine.createdBy) === String(viewer.userId);
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
 * @returns {Promise<object|null>}
 */
async function findVisibleWine(id, opts = {}) {
  const { userId, roles, select, populate, lean = false } = opts;
  let q = WineDefinition.findOne({ _id: id, ...wineVisibilityFilter({ userId, roles }) });
  if (select) q = q.select(select);
  if (populate) q = q.populate(populate);
  if (lean) q = q.lean();
  return q;
}

module.exports = {
  CURATION_ROLES,
  isCurator,
  wineVisibilityFilter,
  canSeeWine,
  findVisibleWine,
};
