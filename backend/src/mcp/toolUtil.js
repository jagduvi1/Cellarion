// Shared helpers for MCP tool handlers: uniform response envelope, the error
// code taxonomy (fail), and the standalone access checks (the service-
// context equivalents of middleware/cellarAccess + middleware/bottleAccess —
// same semantics, no req/res).
const { z } = require('zod');
const Cellar = require('../models/Cellar');
const Bottle = require('../models/Bottle');
const { getCellarRole } = require('../utils/cellarAccess');
const { compactPlace } = require('../utils/wallGeometry');
const { isValidId } = require('../utils/validation');
const { CONSUMED_STATUSES, NOT_IN_CELLAR_STATUSES } = require('../config/constants');

const ROLE_LEVELS = { viewer: 1, editor: 2, owner: 3 };

/** Shared zod shape for Mongo ids in tool input schemas. */
const objectId = z.string().regex(/^[a-f0-9]{24}$/i, 'must be a 24-hex id');

// Canonical not_found messages — identical wording for "missing" and "no
// access" (no existence oracle), with the recovery hint the model needs.
const MSG_CELLAR_NOT_FOUND = 'No such cellar, or you have no access to it. Use list_cellars for valid ids.';
const MSG_BOTTLE_NOT_FOUND = 'No such bottle, or you have no access to it. Find ids via search_bottles.';

/** Success envelope: { summary, data, warnings?, page? } as one text part. */
function ok(summary, data, extra = {}) {
  return {
    content: [{ type: 'text', text: JSON.stringify({ summary, data, ...extra }) }],
  };
}

/**
 * Error envelope. `code` is from one fixed taxonomy: invalid_input | not_found |
 * forbidden_scope | budget_exhausted | conflict | rate_limited | busy |
 * unavailable. Messages are written for the calling MODEL to self-correct from,
 * not for humans.
 * `busy` = an identical idempotency_key request is mid-flight;
 * retry the SAME key shortly (distinct from `conflict`, which is not retryable).
 * `unavailable` = a backend dependency (vector search/embeddings/
 * image service) is temporarily down or rebuilding — retry later; slowing the
 * call cadence does NOT help (distinct from `rate_limited`, which it is not).
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
/**
 * The classification taxonomy rows a wine carries, for the API: [{ name,
 * kind }], only when they were populated (an id-only array answers []).
 * `classification` (the joined string) stays beside it for older clients.
 */
const { classificationsOut } = require('../services/classificationOps');
const { labelSweetnessOut, labelSweetnessFields, sweetnessStyleFields, wineDisplayName } = require('../services/sweetnessOps');

/**
 * A wine's sweetness reading (services/sweetnessCategory readSweetnessCategories:
 * { category, basis } or null) as two keys. sweetness_category is dry |
 * off-dry | medium-sweet | sweet on one scale for still and sparkling wines,
 * null when the record states none; sweetness_category_basis says what it
 * rests on (label | name | style | tier | type).
 */
const sweetnessCategoryOut = (read) => ({
  sweetness_category: read ? read.category : null,
  sweetness_category_basis: read ? read.basis : null,
});

function wineSummary(wd, { termLoaded = false, styleLoaded = false, sweetness } = {}) {
  if (!wd) return null;
  return {
    wine_id: wd._id,
    name: wd.name,
    // label_sweetness ({ name, band, scale, regulated } or null — the sweetness
    // the LABEL states, never the tasting profile's estimate) and display_name
    // (the name as the label reads it), BOTH only when the caller's read
    // selected and populated the field (termLoaded): then a row that predates
    // the field reads as null, like a row that states none. A read that did
    // not load it carries neither key, so a missing key means "not on this
    // surface", never "no term" (services/sweetnessOps.labelSweetnessFields).
    ...labelSweetnessFields(wd, { loaded: termLoaded }),
    // sweetness_style ({ name, band, scale, regulated, source, source_url } or
    // null — the term the wine is KNOWN by when its label states none, named
    // by the producer or the trade; descriptive, never identity) only when the
    // caller asked for the field and populated its term (styleLoaded: true,
    // or 'shaped' when a shaper already gave the outgoing shape — see
    // services/sweetnessOps.sweetnessStyleFields): the path is select: false,
    // so a read that did not ask carries no key, and neither does a style this
    // read cannot vouch for.
    ...sweetnessStyleFields(wd, { loaded: styleLoaded }),
    // sweetness_category and its basis only when the caller looked the reading
    // up and passed it (`sweetness`: the reading, or null for a wine that
    // states none): a summary built without it carries neither key.
    ...(sweetness === undefined ? {} : sweetnessCategoryOut(sweetness)),
    producer: wd.producer || null,
    type: wd.type || null,
    // 'other' = a drink that is not wine (cider, beer, spirits), kept in the
    // user's cellar outside the shared wine registry; 'wine' otherwise.
    category: wd.nonWine === true ? 'other' : 'wine',
    // Only a sparkling/dessert/fortified wine carries one (utils/wineColour) —
    // included when set, so the common still wine pays nothing for it.
    ...(wd.colour ? { colour: wd.colour } : {}),
    country: wd.country?.name || null,
    region: wd.region?.name || null,
    appellation: wd.appellation || null,
    // Callers that ran the wine through utils/grapeDisplay.decorateGrapes
    // (get_wine, resolve_wine) surface the regionally correct label here
    // ("Tinta Roriz" on a Douro Port); undecorated callers keep the canonical
    // name — same array-of-strings shape either way.
    grapes: Array.isArray(wd.grapes) ? wd.grapes.map((g) => g.displayName || g.name).filter(Boolean) : [],
  };
}

/** Compact bottle line item for list responses. */
function bottleSummary(b) {
  const { isReserved } = require('../utils/reservationUtils');
  return {
    bottle_id: b._id,
    wine: b.wineDefinition
      ? {
          name: b.wineDefinition.name, producer: b.wineDefinition.producer || null, type: b.wineDefinition.type || null,
          ...(b.wineDefinition.nonWine === true ? { category: 'other' } : {}),
          ...(b.wineDefinition.colour ? { colour: b.wineDefinition.colour } : {}),
          // The user's private draft wine (publish_wine to share it).
          ...(b.wineDefinition.draft === true ? { draft: true } : {}),
        }
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
    // The peak pair is writable through update_bottle, so every read carries
    // it too — an assistant that sets it must be able to see it again.
    peak_from: b.peakFrom ?? null,
    peak_until: b.peakUntil ?? null,
    opened_at: b.openedAt || undefined,
    // Only present when the bottle is "spoken for" — keeps unreserved rows lean.
    reserved: isReserved(b)
      ? { for: b.reservedFor || null, until: b.reservedUntil ?? null }
      : undefined,
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
    { $match: { cellar: { $in: cellarIds }, status: consumed ? { $in: CONSUMED_STATUSES } : { $nin: NOT_IN_CELLAR_STATUSES } } },
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

// The curator roles, one list for the whole app (services/wineVisibility):
// a tool declares `requireRole: SOMM_ROLES` so the registry never advertises
// it to other callers, and re-checks inside the handler with requireSomm —
// two layers that can only drift safely.
const { CURATION_ROLES: SOMM_ROLES } = require('../services/wineVisibility');

/** The in-handler role re-check of a sommelier tool: null when allowed, else the refusal envelope. */
function requireSomm(ctx) {
  const roles = ctx.user?.roles || [];
  return SOMM_ROLES.some((r) => roles.includes(r))
    ? null
    : fail('forbidden_scope', 'This tool needs the sommelier (or admin) role.');
}

/** Clamp a limit/offset pair from validated zod input. */
function pageParams(args, defLimit, maxLimit) {
  const limit = Math.min(Math.max(parseInt(args.limit, 10) || defLimit, 1), maxLimit);
  const offset = Math.max(parseInt(args.offset, 10) || 0, 0);
  return { limit, offset };
}

// A correction proposal's fields as the tools' arguments spell them. The
// proposal stores the sweetness style as sweetnessStyle { term, source, url };
// the tools take and answer sweetness_style { term, source, source_url }, so
// what one tool reports can be sent to another as it stands.
const proposalFieldName = (f) => (f === 'sweetnessStyle' ? 'sweetness_style' : f);
function proposalFieldsOut(pf) {
  const plain = pf && typeof pf.toObject === 'function' ? pf.toObject() : pf;
  if (!plain || !plain.sweetnessStyle) return plain || null;
  const { sweetnessStyle: s, ...rest } = plain;
  return { ...rest, sweetness_style: { term: s.term, source: s.source, source_url: s.url } };
}

// What belongs in the three registry fields every add/correct tool takes —
// one text, so no tool schema drifts from the rule.
const FIELD_DESCRIPTIONS = {
  region: 'The wine region NAME where THIS wine is grown (e.g. "Piedmont", "Barossa Valley") — never assumed from where the producer is based.',
  appellation: 'The appellation as its register names it, WITHOUT the regulatory mark: "Barolo" not "Barolo DOCG", "Pauillac" not "Pauillac AOC". Premier/Grand Cru stays only where it is part of the legal name ("Chablis Premier Cru", "Saint-Émilion Grand Cru"). Never a quality tier, and never a production method ("Méthode Traditionnelle", "Metodo Classico", "Méthode Cap Classique"): the appellation is the origin, null when the label names none.',
  classification: 'A quality tier granted ON TOP of the appellation, named as the registry\'s classification list has it (list_classifications): Riserva, Gran Reserva, Grand Cru Classé, Cru Bourgeois, Premier Cru in Champagne, a German Prädikat (Kabinett, Spätlese), VDP Grosse Lage … Several tiers comma-separated ("Spätlese, VDP Grosse Lage"). NEVER the regulatory mark (DOCG, DOC, AOC, IGT, AVA) — that follows from the appellation and is dropped on write; a word the list lacks is refused with the known tiers.',
  labelSweetness: 'The sweetness the LABEL states, as printed — trocken, halbtrocken, feinherb, Brut Nature, Extra Brut, Brut, Extra Dry, amabile, meio seco … — named as list_sweetness_terms has it (a listed spelling is accepted). ONE term. The server knows the scale from the wine\'s type: "trocken" on a Sekt is the sec band, on a still wine the dry band. The printed word only: never derived from a Kabinett/Spätlese tier, never the tasting profile\'s dry/off-dry/sweet estimate, and no term when the label states none. Fortified wines carry none.',
  sweetnessStyle: 'The sweetness term the wine is KNOWN by when its LABEL prints none (feinherb, fruchtsüß, edelsüß …), as { term, source, source_url }: `term` as list_sweetness_terms has it; `source` "producer" (the producer\'s own wording) or "trade" (a merchant, a critic, a wine database); `source_url` the page that names this term for this wine (evidence_url is used when it is left out; one of the two is required). A term with a legal definition (regulated: true: trocken, halbtrocken, Brut …) only from the producer. Never a taste impression, never worked out from a Kabinett/Spätlese tier or the alcohol, and never a word the label itself prints. Descriptive: no part of the wine\'s identity.',
};

/**
 * A bottle's place in a wall rack (rackGeometry.slotPlace) as the tools give
 * it: only the keys that say something (wallGeometry.compactPlace). A pile:
 * { box, kind, section, slot } (no section in an open bin; slot 1 is the
 * lowest bottle). A rack or shelves box: { box, kind, row, col }. null stays
 * null (not a wall, or no such slot).
 */
const wallSpot = compactPlace;

/** The same place as words for a summary line: "box B2, left pile, 3 from the bottom". */
function wallText(place) {
  if (!place) return '';
  if (place.row != null) {
    return `box ${place.box}, ${place.kind === 'shelves' ? 'shelf' : 'row'} ${place.row}, ${place.col} from the left`;
  }
  return `box ${place.box}, ${place.section ? `${place.section} pile, ` : ''}${place.slot} from the bottom`;
}

module.exports = {
  wallSpot,
  wallText,
  classificationsOut,
  labelSweetnessOut,
  labelSweetnessFields,
  sweetnessStyleFields,
  wineDisplayName,
  FIELD_DESCRIPTIONS,
  proposalFieldName,
  proposalFieldsOut,
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
  SOMM_ROLES,
  requireSomm,
};
