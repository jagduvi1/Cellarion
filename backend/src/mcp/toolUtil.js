// Shared helpers for MCP tool handlers: uniform response envelope, the error
// taxonomy from MCP plan §5.4, and the standalone access checks (the service-
// context equivalents of middleware/cellarAccess + middleware/bottleAccess —
// same semantics, no req/res).
const { z } = require('zod');
const Cellar = require('../models/Cellar');
const Bottle = require('../models/Bottle');
const { getCellarRole } = require('../utils/cellarAccess');
const { isValidId } = require('../utils/validation');
const { CONSUMED_STATUSES } = require('../config/constants');

const ROLE_LEVELS = { viewer: 1, editor: 2, owner: 3 };

/** Shared zod shape for Mongo ids in tool input schemas. */
const objectId = z.string().regex(/^[a-f0-9]{24}$/i, 'must be a 24-hex id');

// Canonical not_found messages — identical wording for "missing" and "no
// access" (no existence oracle), with the recovery hint the model needs.
const MSG_CELLAR_NOT_FOUND = 'No such cellar, or you have no access to it. Use list_cellars for valid ids.';
const MSG_BOTTLE_NOT_FOUND = 'No such bottle, or you have no access to it. Find ids via search_bottles.';

/** Success envelope (§7): { summary, data, warnings?, page? } as one text part. */
function ok(summary, data, extra = {}) {
  return {
    content: [{ type: 'text', text: JSON.stringify({ summary, data, ...extra }) }],
  };
}

/**
 * Error envelope. `code` is from the §5.4 taxonomy: invalid_input | not_found |
 * forbidden_scope | budget_exhausted | conflict | rate_limited | busy. Messages
 * are written for the calling MODEL to self-correct from, not for humans.
 * `busy` (MCP-audit M1) = an identical idempotency_key request is mid-flight;
 * retry the SAME key shortly (distinct from `conflict`, which is not retryable).
 */
function fail(code, message) {
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error: { code, message } }) }],
  };
}

/**
 * Load a cellar and the caller's role in it. Returns { cellar, role } or null
 * when the cellar is missing, soft-deleted, or the caller is not owner/member.
 * Callers MUST treat null as not_found (never reveal that a foreign cellar
 * exists — same policy as requireCellarAccess).
 */
async function resolveCellarAccess(userId, cellarId, minRole = 'viewer') {
  // Callers pass both client-supplied strings AND document refs (ObjectId
  // instances, e.g. bottle.cellar / rack.cellar). isValidId is string-only, so
  // coerce first: String(ObjectId) is the 24-hex id, while any smuggled
  // object/array stringifies to something isValidId rejects — still fail-closed.
  const id = String(cellarId);
  if (!isValidId(id)) return null;
  const cellar = await Cellar.findById(id);
  if (!cellar || cellar.deletedAt) return null;
  const role = getCellarRole(cellar, userId);
  if (!role) return null;
  if ((ROLE_LEVELS[role] || 0) < (ROLE_LEVELS[minRole] || 0)) return null;
  return { cellar, role };
}

/**
 * Load a bottle plus its cellar and the caller's role — the standalone
 * equivalent of requireBottleAccess(minRole). Returns { bottle, cellar, role }
 * or null (missing bottle, deleted cellar, or no access — all not_found).
 */
async function resolveBottleAccess(userId, bottleId, minRole = 'viewer') {
  // Same coercion as resolveCellarAccess above: callers pass client strings
  // AND document refs (ObjectId instances, e.g. McpActionLog.bottle in
  // undo_last). String() of an ObjectId is its 24-hex id; a smuggled object
  // stringifies to something isValidId rejects — still fail-closed.
  const id = String(bottleId);
  if (!isValidId(id)) return null;
  const bottle = await Bottle.findById(id);
  if (!bottle) return null;
  const access = await resolveCellarAccess(userId, bottle.cellar, minRole);
  if (!access) return null;
  return { bottle, ...access };
}

/** All cellars the user owns or is a member of (lean). Mirrors cellars.js. */
function accessibleCellars(userId) {
  return Cellar.find({
    $or: [{ user: userId }, { 'members.user': userId }],
    deletedAt: null,
  }).lean();
}

/** Compact registry-wine summary. NEVER include normalizedKey/createdBy/productNumber. */
function wineSummary(wd) {
  if (!wd) return null;
  return {
    wine_id: wd._id,
    name: wd.name,
    producer: wd.producer || null,
    type: wd.type || null,
    country: wd.country?.name || null,
    region: wd.region?.name || null,
    appellation: wd.appellation || null,
    grapes: Array.isArray(wd.grapes) ? wd.grapes.map((g) => g.name).filter(Boolean) : [],
  };
}

/** Compact bottle line item for list responses. */
function bottleSummary(b) {
  return {
    bottle_id: b._id,
    wine: b.wineDefinition
      ? { name: b.wineDefinition.name, producer: b.wineDefinition.producer || null, type: b.wineDefinition.type || null }
      : { name: b.pendingWineRequest?.wineName || 'Unknown wine', pending_registry_review: true },
    vintage: b.vintage,
    status: b.status,
    cellar_id: b.cellar,
    price: b.price ?? null,
    currency: b.currency || null,
    rating: b.rating ?? null,
    rating_scale: b.rating != null ? b.ratingScale : undefined,
    drink_from: b.drinkFrom ?? null,
    drink_to: b.drinkTo ?? null,
    opened_at: b.openedAt || undefined,
  };
}

/**
 * Active (or consumed) bottle counts per cellar in one aggregation.
 * Shared by list_cellars and the cellar://snapshot resource so the two
 * surfaces can never disagree on what counts. Returns Map<cellarIdString, n>.
 * cellarIds must be ObjectIds (aggregate does not cast).
 */
async function countBottlesByCellar(cellarIds, { consumed = false } = {}) {
  const rows = await Bottle.aggregate([
    { $match: { cellar: { $in: cellarIds }, status: consumed ? { $in: CONSUMED_STATUSES } : { $nin: CONSUMED_STATUSES } } },
    { $group: { _id: '$cellar', n: { $sum: 1 } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), r.n]));
}

/**
 * True when a (lean) subdocument carries any real value. Mongoose materializes
 * default subdocs (e.g. a never-enriched aiProfile of all-nulls); those should
 * serialize as null over MCP, not as empty shells the model misreads as data.
 */
function hasContent(obj) {
  if (!obj || typeof obj !== 'object') return false;
  return Object.values(obj).some((v) => {
    if (v == null) return false;
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === 'object') return hasContent(v);
    return true;
  });
}

/** Clamp a limit/offset pair from validated zod input. */
function pageParams(args, defLimit, maxLimit) {
  const limit = Math.min(Math.max(parseInt(args.limit, 10) || defLimit, 1), maxLimit);
  const offset = Math.max(parseInt(args.offset, 10) || 0, 0);
  return { limit, offset };
}

module.exports = {
  ok,
  fail,
  objectId,
  MSG_CELLAR_NOT_FOUND,
  MSG_BOTTLE_NOT_FOUND,
  resolveCellarAccess,
  resolveBottleAccess,
  accessibleCellars,
  countBottlesByCellar,
  wineSummary,
  bottleSummary,
  pageParams,
  hasContent,
  ROLE_LEVELS,
};
