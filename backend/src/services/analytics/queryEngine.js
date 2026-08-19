/**
 * The analytics query engine (#987 Phase 0).
 *
 * One entry point, runQuery(), consumed by every analytics surface (table,
 * CSV, charts, saved views). Two modes:
 *   rows    — flat bottle rows with the chosen columns (the spreadsheet)
 *   grouped — aggregated buckets (every chart and pivot)
 *
 * Design invariants — each exists because of a documented failure mode:
 *
 *  SECURITY   Nothing from the request body reaches a pipeline uninterpreted.
 *             A filter names a catalogue key + a whitelisted operator; the
 *             value is CAST per the field's declared type and rejected if it
 *             does not fit. The query is data, never code.
 *  SCOPE      The first $match is always the server-derived cellar scope —
 *             the caller's own cellars plus shared memberships, intersected
 *             with any client-supplied list (narrow, never widen). The
 *             consumed-bottle choice is explicit and echoed back, never a
 *             silent editorial default.
 *  MONEY      Monetary measures convert per-row (USD-based rates snapshot)
 *             before aggregating and report the target currency plus how many
 *             rows could not convert — convertCurrency() returning null used
 *             to silently shrink totals while counts stayed whole.
 *  RATINGS    5/20/100-scale ratings normalize to 0–100 per-row before any
 *             aggregation, via an expression GENERATED from ratingUtils'
 *             anchor table so pipeline math can never drift from
 *             toNormalized() (a parity test pins them together).
 *  BOUNDS     maxTimeMS on every aggregation; hard row/bucket caps; at most
 *             two dimensions; every applied cap reported in the envelope.
 *             No allowDiskUse — prod runs a 640 MB backend.
 *  IDENTITY   Aggregate for identity and ordering, find() for hydration
 *             (the routes/cellars.js pattern), with _id as sort tiebreaker so
 *             pagination never duplicates or skips on tied values.
 */

const mongoose = require('mongoose');
const Bottle = require('../../models/Bottle');
const Cellar = require('../../models/Cellar');
const PersonalDataEntry = require('../../models/PersonalDataEntry');
const RegistryDataValue = require('../../models/RegistryDataValue');
const { resolveField, opsForType } = require('./fieldCatalogue');
const { validateValue } = require('../../utils/personalDataTypes');
const { ANCHORS, COL, toNormalized, fromNormalized } = require('../../utils/ratingUtils');
const { getOrCreateDailySnapshot, convertCurrency } = require('../../utils/exchangeRates');
const { classifyMaturity, buildProfileMap } = require('../../utils/maturityUtils');

const MAX_TIME_MS = 5000;
const ROWS_LIMIT_MAX = 200;
const BUCKET_CAP = 200;
const MAX_DIMENSIONS = 2;
const MAX_FILTERS = 12;
const KV_MATCH_CAP = 5000; // a KV filter matching more rows than this is refused

class QueryError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ── Scope ──────────────────────────────────────────────────────────────────

/**
 * All cellars the caller can read (owner or member), optionally narrowed by a
 * client-supplied id list. Returns [{_id, name}] — names ride along for the
 * envelope so the UI can always show WHAT is in scope.
 */
async function deriveScope(userId, requestedCellarIds) {
  const mine = await Cellar.find({
    deletedAt: null,
    $or: [{ user: userId }, { 'members.user': userId }],
  }).select('name').lean();
  if (requestedCellarIds === 'all' || requestedCellarIds === undefined || requestedCellarIds === null) {
    return mine;
  }
  if (!Array.isArray(requestedCellarIds)) throw new QueryError(400, 'scope.cellars must be "all" or an array of cellar ids');
  const wanted = new Set(requestedCellarIds.map(String));
  const scoped = mine.filter((c) => wanted.has(String(c._id)));
  if (!scoped.length) throw new QueryError(400, 'scope.cellars matched none of your cellars');
  return scoped;
}

const BOTTLE_SCOPES = {
  active: { status: 'active' },
  consumed: { status: { $in: ['drank', 'gifted', 'sold', 'other'] } },
  all: {},
};

// ── Filter compilation ─────────────────────────────────────────────────────

/** Cast one filter value for a STATIC field. KV fields go through validateValue. */
function castStatic(field, raw) {
  switch (field.type) {
    case 'text': {
      // Strict on shape: an object here is someone probing for operator
      // injection — String({$ne:null}) would "work" as '[object Object]',
      // which is a silent lie, not a rejection.
      if (typeof raw !== 'string' && typeof raw !== 'number') {
        throw new QueryError(400, `Filter on ${field.key}: expected text`);
      }
      const s = String(raw).trim();
      if (!s) throw new QueryError(400, `Filter on ${field.key}: a value is required`);
      if (s.length > 200) throw new QueryError(400, `Filter on ${field.key}: value too long`);
      return s;
    }
    case 'integer': {
      // Number('') and Number(null) are both 0 — an absent value must be a
      // 400, never a silent zero bound (audit 2026-08-19 F8).
      if (raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '')) {
        throw new QueryError(400, `Filter on ${field.key}: a value is required`);
      }
      const n = Number(raw);
      if (!Number.isInteger(n)) throw new QueryError(400, `Filter on ${field.key}: expected a whole number`);
      return n;
    }
    case 'decimal': {
      if (raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '')) {
        throw new QueryError(400, `Filter on ${field.key}: a value is required`);
      }
      const n = typeof raw === 'number' ? raw : Number(String(raw).trim().replace(',', '.'));
      if (!Number.isFinite(n)) throw new QueryError(400, `Filter on ${field.key}: expected a number`);
      return n;
    }
    case 'boolean': {
      if (typeof raw === 'boolean') return raw;
      throw new QueryError(400, `Filter on ${field.key}: expected true or false`);
    }
    case 'date': {
      const s = String(raw ?? '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new QueryError(400, `Filter on ${field.key}: expected YYYY-MM-DD`);
      const d = new Date(`${s}T00:00:00Z`);
      if (Number.isNaN(d.getTime())) throw new QueryError(400, `Filter on ${field.key}: not a valid date`);
      return d;
    }
    case 'enum': {
      const s = String(raw ?? '').trim();
      if (!(field.enumOptions || []).includes(s)) {
        throw new QueryError(400, `Filter on ${field.key}: expected one of ${(field.enumOptions || []).join(', ')}`);
      }
      return s;
    }
    default:
      throw new QueryError(400, `Filter on ${field.key}: unsupported type`);
  }
}

function castKv(field, raw) {
  const res = validateValue(field.keyDoc, raw);
  if (!res.ok) throw new QueryError(400, `Filter on "${field.label}": ${res.error}`);
  return res.value;
}

/**
 * STATIC date fields hold real event timestamps (createdAt, consumedAt,
 * openedAt), while the filter value names a calendar DAY. Comparing the raw
 * midnight instant made 'eq' match nothing and inclusive upper bounds drop
 * the entire named day (audit 2026-08-19 F2) — so date predicates expand to
 * day ranges. KV date values are canonical 'YYYY-MM-DD' strings and never
 * come through here.
 */
function datePredicate(field, op, value, castOne) {
  const dayAfter = (d) => new Date(d.getTime() + 86400000);
  switch (op) {
    case 'eq': { const d = castOne(value); return { $gte: d, $lt: dayAfter(d) }; }
    case 'gte': return { $gte: castOne(value) };
    case 'gt': { const d = castOne(value); return { $gte: dayAfter(d) }; }
    case 'lt': return { $lt: castOne(value) };
    case 'lte': { const d = castOne(value); return { $lt: dayAfter(d) }; }
    case 'between': {
      if (!Array.isArray(value) || value.length !== 2) {
        throw new QueryError(400, `Filter on ${field.key}: "between" takes [min, max]`);
      }
      return { $gte: castOne(value[0]), $lt: dayAfter(castOne(value[1])) };
    }
    default:
      throw new QueryError(400, `Filter on ${field.key}: operator "${op}" not allowed for dates`);
  }
}

/** op + cast value(s) → a Mongo comparison for one path. */
function predicate(field, op, value, castOne) {
  const allowed = opsForType(field.type);
  if (!allowed.includes(op)) {
    throw new QueryError(400, `Filter on ${field.key}: operator "${op}" not allowed for type ${field.type}`);
  }
  if (field.type === 'date' && (field.source === 'bottle' || field.source === 'wine')) {
    return datePredicate(field, op, value, castOne);
  }
  switch (op) {
    case 'eq': return castOne(value);
    case 'neq': return { $ne: castOne(value) };
    case 'gt': return { $gt: castOne(value) };
    case 'gte': return { $gte: castOne(value) };
    case 'lt': return { $lt: castOne(value) };
    case 'lte': return { $lte: castOne(value) };
    case 'between': {
      if (!Array.isArray(value) || value.length !== 2) {
        throw new QueryError(400, `Filter on ${field.key}: "between" takes [min, max]`);
      }
      return { $gte: castOne(value[0]), $lte: castOne(value[1]) };
    }
    case 'contains': {
      const s = castOne(value);
      return { $regex: escapeRegex(s), $options: 'i' };
    }
    case 'in': {
      if (!Array.isArray(value) || !value.length || value.length > 20) {
        throw new QueryError(400, `Filter on ${field.key}: "in" takes 1–20 values`);
      }
      return { $in: value.map(castOne) };
    }
    default:
      throw new QueryError(400, `Unknown operator "${op}"`);
  }
}

/**
 * A taxonomy filter (country/region/grape) resolves the typed NAME against
 * the small indexed taxonomy collection first, then matches the ref ids.
 * eq/in resolve case-insensitively exact; contains resolves by substring.
 */
async function taxonomyIds(field, op, value) {
  const Model = mongoose.model(field.taxonomyModel);
  const names = op === 'in' ? value : [value];
  if (!Array.isArray(names) || !names.length || names.length > 20) {
    throw new QueryError(400, `Filter on ${field.key}: 1–20 values`);
  }
  const patterns = names.map((n) => {
    const s = String(n ?? '').trim();
    if (!s || s.length > 100) throw new QueryError(400, `Filter on ${field.key}: bad value`);
    return op === 'contains'
      ? new RegExp(escapeRegex(s), 'i')
      : new RegExp(`^${escapeRegex(s)}$`, 'i');
  });
  const docs = await Model.find({ name: { $in: patterns } }).select('_id').limit(500).lean();
  return docs.map((d) => d._id);
}

/**
 * Evaluate one whitelisted operator against an already-cast entry value in
 * JS — the personal-KV filter resolves precedence before Mongo ever sees a
 * condition, so the predicate has to run here too. Mirrors predicate()'s
 * semantics exactly; a mismatch between the two is a bug the KV filter tests
 * exist to catch.
 */
function evalKvPredicate(op, castValue, entryValue) {
  switch (op) {
    case 'eq': return entryValue === castValue;
    case 'neq': return entryValue !== castValue;
    case 'gt': return entryValue > castValue;
    case 'gte': return entryValue >= castValue;
    case 'lt': return entryValue < castValue;
    case 'lte': return entryValue <= castValue;
    case 'between': return entryValue >= castValue[0] && entryValue <= castValue[1];
    case 'contains': return typeof entryValue === 'string' && entryValue.toLowerCase().includes(String(castValue).toLowerCase());
    case 'in': return Array.isArray(castValue) && castValue.includes(entryValue);
    default: return false;
  }
}

/** Cast the filter value(s) once for JS evaluation, per the op's shape. */
function castKvForEval(field, op, value) {
  const castOne = (raw) => castKv(field, raw);
  if (op === 'between') {
    if (!Array.isArray(value) || value.length !== 2) {
      throw new QueryError(400, `Filter on "${field.label}": "between" takes [min, max]`);
    }
    return [castOne(value[0]), castOne(value[1])];
  }
  if (op === 'in') {
    if (!Array.isArray(value) || !value.length || value.length > 20) {
      throw new QueryError(400, `Filter on "${field.label}": "in" takes 1–20 values`);
    }
    return value.map(castOne);
  }
  if (op === 'contains') {
    const s = castOne(value);
    if (typeof s !== 'string') throw new QueryError(400, `Filter on "${field.label}": expected text`);
    return s;
  }
  return castOne(value);
}

/**
 * A KV filter resolves ENTRY rows first (indexed), then narrows the bottle
 * match — never a $lookup per filter.
 *
 * Personal entries apply the SAME precedence the display, sort, group and
 * measure paths apply — bottle entry beats wine-vintage beats wine-null
 * (audit 2026-08-19 F1: filtering on any-level matches admitted rows whose
 * EFFECTIVE value contradicted the user's own filter). So: all of the
 * caller's entries for the key are fetched predicate-free, the predicate
 * runs in JS per entry, and the condition is layered — a failing
 * higher-precedence entry vetoes a matching lower one:
 *   include: matching bottle entries; matching wine-vintage entries;
 *            matching wine-null entries MINUS vintages a failing
 *            wine-vintage entry overrides
 *   exclude: bottles with a FAILING bottle-level entry, always
 */
async function kvCondition(field, op, value, userId) {
  if (field.source === 'registry') {
    // One published value per (wine, key) — no precedence to resolve, the
    // predicate can stay in the query.
    const valuePred = predicate(field, op, value, (raw) => castKv(field, raw));
    const rows = await RegistryDataValue.find({
      key: field.keyId, status: 'published', value: valuePred,
    }).select('wineDefinition').limit(KV_MATCH_CAP + 1).lean();
    if (rows.length > KV_MATCH_CAP) {
      throw new QueryError(422, `Filter on "${field.label}" matches too many wines — narrow it first`);
    }
    return { wineDefinition: { $in: rows.map((r) => r.wineDefinition) } };
  }

  const cast = castKvForEval(field, op, value);
  const rows = await PersonalDataEntry.find({
    author: userId, key: field.keyId,
  }).select('targetType bottle wineDefinition vintage value').limit(KV_MATCH_CAP + 1).lean();
  if (rows.length > KV_MATCH_CAP) {
    throw new QueryError(422, `Filter on "${field.label}" matches too many entries — narrow it first`);
  }

  const bottleMatch = [];
  const bottleFail = [];
  const wvMatch = [];               // { wineDefinition, vintage }
  const wvFailByWine = new Map();   // wineId -> [vintage, ...]
  const wnMatch = [];               // wineId
  for (const r of rows) {
    const hit = evalKvPredicate(op, cast, r.value);
    if (r.targetType === 'bottle') (hit ? bottleMatch : bottleFail).push(r.bottle);
    else if (r.vintage) {
      if (hit) wvMatch.push({ wineDefinition: r.wineDefinition, vintage: r.vintage });
      else {
        const k = String(r.wineDefinition);
        if (!wvFailByWine.has(k)) wvFailByWine.set(k, []);
        wvFailByWine.get(k).push(r.vintage);
      }
    } else if (hit) wnMatch.push(r.wineDefinition);
  }

  const or = [];
  if (bottleMatch.length) or.push({ _id: { $in: bottleMatch } });
  or.push(...wvMatch);
  for (const wid of wnMatch) {
    const failVints = wvFailByWine.get(String(wid));
    or.push(failVints
      ? { wineDefinition: wid, vintage: { $nin: failVints } }
      : { wineDefinition: wid });
  }
  // No matching entries → a condition that matches nothing (honest empty
  // result, not an error).
  if (!or.length) return { _id: { $in: [] } };
  const include = { $or: or };
  return bottleFail.length
    ? { $and: [include, { _id: { $nin: bottleFail } }] }
    : include;
}

/**
 * Compile the request's filters into pipeline conditions, split by where they
 * apply: before the wine $lookup (bottle paths, KV pre-resolutions) or after
 * it (wd.* paths).
 */
async function compileFilters(filters, userId) {
  if (filters === undefined) return { pre: [], post: [], exprFilters: [], needsWine: false };
  if (!Array.isArray(filters) || filters.length > MAX_FILTERS) {
    throw new QueryError(400, `filters must be an array of at most ${MAX_FILTERS}`);
  }
  const pre = [];
  const post = [];
  const exprFilters = [];
  let needsWine = false;
  for (const f of filters) {
    if (!f || typeof f !== 'object' || typeof f.field !== 'string' || typeof f.op !== 'string') {
      throw new QueryError(400, 'Each filter needs { field, op, value }');
    }
    const field = await resolveField(f.field, userId);
    if (!field) throw new QueryError(400, `Unknown field "${f.field}"`);
    if (!field.filterable) throw new QueryError(400, `Field "${f.field}" is not filterable`);

    if (field.normalized) {
      // Ratings filter in STARS against the converted expression (audit F3):
      // the raw stored values mix three scales, so a raw comparison ranks a
      // 60-point Parker above a 5-star bottle.
      const castStars = (raw) => {
        const n = castStatic({ ...field, type: 'decimal' }, raw);
        if (n < 0 || n > 5) throw new QueryError(400, `Filter on ${field.key}: stars run 0–5`);
        return n;
      };
      exprFilters.push({
        expr: ratingConversionExpr(field.path, field.scalePath, '5'),
        pred: predicate({ ...field, type: 'decimal' }, f.op, f.value, castStars),
      });
    } else if (field.source === 'personal' || field.source === 'registry') {
      pre.push(await kvCondition(field, f.op, f.value, userId));
    } else if (field.source === 'taxonomy') {
      if (!['eq', 'in', 'contains', 'neq'].includes(f.op)) {
        throw new QueryError(400, `Filter on ${field.key}: operator "${f.op}" not supported`);
      }
      const ids = await taxonomyIds(field, f.op === 'neq' ? 'eq' : f.op, f.value);
      const path = field.path; // wd.country / wd.region / wd.grapes
      needsWine = true;
      if (f.op === 'neq') post.push({ [path]: { $nin: ids } });
      else post.push({ [path]: { $in: ids } });
    } else if (field.source === 'wine') {
      const cond = { [field.path]: predicate(field, f.op, f.value, (raw) => castStatic(field, raw)) };
      needsWine = true;
      post.push(cond);
    } else if (field.source === 'bottle') {
      pre.push({ [field.path]: predicate(field, f.op, f.value, (raw) => castStatic(field, raw)) });
    } else {
      throw new QueryError(400, `Field "${f.field}" cannot be filtered`);
    }
  }
  return { pre, post, exprFilters, needsWine };
}

/** The $addFields+$match stage pairs for expression filters (ratings). */
function exprFilterStages(exprFilters) {
  return exprFilters.flatMap((ef, i) => [
    { $addFields: { [`_f${i}`]: ef.expr } },
    { $match: { [`_f${i}`]: ef.pred } },
  ]);
}

// ── Generated normalization expressions ────────────────────────────────────

/**
 * Piecewise-linear rating conversion as an aggregation expression, generated
 * from ratingUtils.ANCHORS — the same table toNormalized/fromNormalized read.
 * `toKey` picks the target column: 'norm' (0–100) or '5' (stars — the one
 * scale this surface speaks after audit F3). A direct from→to piecewise
 * equals the toNormalized∘fromNormalized composition because both walk the
 * same anchor rows; the parity tests pin that.
 */
function ratingConversionExpr(valuePath, scalePath, toKey = '5') {
  const perScale = (scaleKey) => {
    const fromCol = COL[scaleKey];
    const toCol = COL[toKey];
    const v = `$${valuePath}`;
    // Below first anchor / above last anchor clamp; between: linear blend.
    const segs = [];
    for (let i = 0; i < ANCHORS.length - 1; i++) {
      const lo = ANCHORS[i][fromCol];
      const hi = ANCHORS[i + 1][fromCol];
      const nLo = ANCHORS[i][toCol];
      const nHi = ANCHORS[i + 1][toCol];
      segs.push({
        case: { $lte: [v, hi] },
        then: {
          $add: [nLo, {
            $multiply: [
              { $divide: [{ $subtract: [v, lo] }, hi - lo] },
              nHi - nLo,
            ],
          }],
        },
      });
    }
    return {
      $switch: {
        branches: [
          { case: { $lte: [v, ANCHORS[0][fromCol]] }, then: ANCHORS[0][toCol] },
          ...segs,
        ],
        default: ANCHORS[ANCHORS.length - 1][toCol],
      },
    };
  };
  return {
    $cond: [
      { $or: [{ $eq: [`$${valuePath}`, null] }, { $eq: [{ $type: `$${valuePath}` }, 'missing'] }] },
      null,
      {
        $switch: {
          branches: [
            { case: { $eq: [`$${scalePath}`, '20'] }, then: perScale('20') },
            { case: { $eq: [`$${scalePath}`, '100'] }, then: perScale('100') },
          ],
          default: perScale('5'),
        },
      },
    ],
  };
}

/** Back-compat alias for the 0–100 form (parity tests pin it). */
function normalizedRatingExpr(valuePath, scalePath) {
  return ratingConversionExpr(valuePath, scalePath, 'norm');
}

/**
 * Currency conversion as an aggregation expression generated from the day's
 * USD-based rates map. Unknown currency → null (counted separately).
 */
function convertedPriceExpr(valuePath, currencyPath, rates, target) {
  if (!rates || !rates[target]) return { expr: null, reason: 'no_rates' };
  const branches = Object.entries(rates)
    .filter(([, r]) => typeof r === 'number' && r > 0)
    .map(([code, r]) => ({
      case: { $eq: [`$${currencyPath}`, code] },
      then: { $multiply: [`$${valuePath}`, rates[target] / r] },
    }));
  return {
    expr: {
      $cond: [
        { $or: [{ $eq: [`$${valuePath}`, null] }, { $eq: [{ $type: `$${valuePath}` }, 'missing'] }] },
        null,
        { $switch: { branches, default: null } },
      ],
    },
  };
}

// ── Pipeline assembly ──────────────────────────────────────────────────────

const WINE_LOOKUP = [
  { $lookup: { from: 'winedefinitions', localField: 'wineDefinition', foreignField: '_id', as: 'wd' } },
  { $unwind: { path: '$wd', preserveNullAndEmptyArrays: true } },
];

/**
 * R-B: join ONE key/value field's resolved value into the pipeline as
 * `$<alias>`, so KV fields can be sorted, grouped and aggregated server-side.
 * Personal entries apply the same precedence as the bottle page — bottle
 * entry beats a vintage-scoped wine entry beats a vintage-null wine entry —
 * enforced by the _prio sort inside the sub-pipeline. Registry reads the one
 * published row per (wine, key). Both sub-pipelines are $limit 1 and run on
 * indexed keys, bounded by the outer maxTimeMS like everything else.
 */
function kvJoinStages(field, alias, userId) {
  const keyOid = new mongoose.Types.ObjectId(field.keyId);
  if (field.source === 'registry') {
    return [
      {
        $lookup: {
          from: 'registrydatavalues',
          let: { wid: '$wineDefinition' },
          pipeline: [
            { $match: { $expr: { $and: [
              { $eq: ['$wineDefinition', '$$wid'] },
              { $eq: ['$key', keyOid] },
              { $eq: ['$status', 'published'] },
            ] } } },
            { $limit: 1 },
            { $project: { _id: 0, value: 1 } },
          ],
          as: `${alias}_j`,
        },
      },
      { $addFields: { [alias]: { $first: `$${alias}_j.value` } } },
    ];
  }
  const userOid = new mongoose.Types.ObjectId(String(userId));
  return [
    {
      $lookup: {
        from: 'personaldataentries',
        let: { bid: '$_id', wid: '$wineDefinition', vint: '$vintage' },
        pipeline: [
          { $match: { $expr: { $and: [
            { $eq: ['$author', userOid] },
            { $eq: ['$key', keyOid] },
            { $or: [
              { $eq: ['$bottle', '$$bid'] },
              { $and: [
                { $eq: ['$wineDefinition', '$$wid'] },
                { $in: ['$vintage', [null, '$$vint']] },
              ] },
            ] },
          ] } } },
          { $addFields: { _prio: { $switch: {
            branches: [
              { case: { $eq: ['$targetType', 'bottle'] }, then: 0 },
              { case: { $ne: ['$vintage', null] }, then: 1 },
            ],
            default: 2,
          } } } },
          { $sort: { _prio: 1 } },
          { $limit: 1 },
          { $project: { _id: 0, value: 1 } },
        ],
        as: `${alias}_j`,
      },
    },
    { $addFields: { [alias]: { $first: `$${alias}_j.value` } } },
  ];
}

/** Taxonomy sort: join the small name collection and sort by the name. */
function taxonomySortStages(field, alias) {
  return [
    { $lookup: { from: field.taxonomyCollection, localField: field.path, foreignField: '_id', as: `${alias}_j` } },
    { $addFields: { [alias]: { $first: `$${alias}_j.name` } } },
  ];
}

function baseMatch(scopeCellarIds, bottleScope, preConds) {
  const match = {
    cellar: { $in: scopeCellarIds },
    ...BOTTLE_SCOPES[bottleScope],
  };
  return preConds.length ? { $and: [match, ...preConds] } : match;
}

// ── rows mode ──────────────────────────────────────────────────────────────

async function runRows({ userId, scopeCellars, bottleScope, filters, sort, limit, offset, columns }) {
  const { pre, post, exprFilters, needsWine: filterNeedsWine } = await compileFilters(filters, userId);

  // Sort: one field, validated; default = newest first. _id tiebreaker always.
  // Taxonomy and KV sorts join their value in first (R-B) — the join stages
  // run after the filters so they touch only the surviving rows.
  let sortStage = { createdAt: -1, _id: 1 };
  let sortJoin = [];
  let sortField = null;
  if (sort) {
    if (!sort.field || !['asc', 'desc'].includes(sort.dir || 'asc')) {
      throw new QueryError(400, 'sort takes { field, dir: "asc"|"desc" }');
    }
    sortField = await resolveField(sort.field, userId);
    if (!sortField) throw new QueryError(400, `Unknown sort field "${sort.field}"`);
    if (!sortField.sortable) throw new QueryError(400, `Field "${sort.field}" is not sortable`);
    const dir = sort.dir === 'desc' ? -1 : 1;
    if (sortField.source === 'taxonomy') {
      sortJoin = taxonomySortStages(sortField, '_sortVal');
      sortStage = { _sortVal: dir, _id: 1 };
    } else if (sortField.source === 'personal' || sortField.source === 'registry') {
      sortJoin = kvJoinStages(sortField, '_sortVal', userId);
      sortStage = { _sortVal: dir, _id: 1 };
    } else if (sortField.normalized) {
      // Ratings order by the star-converted value (audit F3), same scale as
      // the filter and the displayed column.
      sortJoin = [{ $addFields: { _sortVal: ratingConversionExpr(sortField.path, sortField.scalePath, '5') } }];
      sortStage = { _sortVal: dir, _id: 1 };
    } else {
      sortStage = { [sortField.path]: dir, _id: 1 };
    }
  }
  const needsWine = filterNeedsWine
    || (sortField && (sortField.source === 'taxonomy' || (sortField.path || '').startsWith('wd.')));

  const cellarIds = scopeCellars.map((c) => c._id);
  const pageLimit = Math.min(Math.max(1, limit || 50), ROWS_LIMIT_MAX);
  const pageOffset = Math.max(0, offset || 0);

  const pipeline = [
    { $match: baseMatch(cellarIds, bottleScope, pre) },
    ...(needsWine ? WINE_LOOKUP : []),
    ...(post.length ? [{ $match: { $and: post } }] : []),
    ...exprFilterStages(exprFilters),
    ...sortJoin,
    { $sort: sortStage },
    {
      $facet: {
        ids: [{ $skip: pageOffset }, { $limit: pageLimit }, { $project: { _id: 1 } }],
        total: [{ $count: 'n' }],
      },
    },
  ];

  const [facet] = await Bottle.aggregate(pipeline).option({ maxTimeMS: MAX_TIME_MS });
  const pageIds = (facet?.ids || []).map((r) => r._id);
  const total = facet?.total?.[0]?.n || 0;

  const rows = await hydrateRows({ userId, pageIds, columns, scopeCellars });
  return {
    mode: 'rows',
    total,
    page: { limit: pageLimit, offset: pageOffset, returned: rows.length },
    rows,
  };
}

/** find() + populate for the page, then per-column value extraction. */
async function hydrateRows({ userId, pageIds, columns, scopeCellars }) {
  if (!pageIds.length) return [];
  const fields = [];
  for (const key of columns) {
    const f = await resolveField(key, userId);
    if (!f) throw new QueryError(400, `Unknown column "${key}"`);
    fields.push(f);
  }

  const bottles = await Bottle.find({ _id: { $in: pageIds } })
    .populate({
      path: 'wineDefinition',
      select: 'name producer type appellation classification country region grapes',
      populate: [
        { path: 'country', select: 'name' },
        { path: 'region', select: 'name' },
        { path: 'grapes', select: 'name' },
      ],
    })
    .lean();
  const byId = new Map(bottles.map((b) => [String(b._id), b]));
  const ordered = pageIds.map((id) => byId.get(String(id))).filter(Boolean);
  const cellarNames = new Map(scopeCellars.map((c) => [String(c._id), c.name]));

  // KV hydration: two indexed queries for the whole page.
  const personalFields = fields.filter((f) => f.source === 'personal');
  const registryFields = fields.filter((f) => f.source === 'registry');
  const wineIds = [...new Set(ordered.map((b) => String(b.wineDefinition?._id || b.wineDefinition)).filter(Boolean))];

  let personalEntries = [];
  if (personalFields.length) {
    personalEntries = await PersonalDataEntry.find({
      author: userId,
      key: { $in: personalFields.map((f) => f.keyId) },
      $or: [
        { targetType: 'bottle', bottle: { $in: pageIds } },
        { targetType: 'wine', wineDefinition: { $in: wineIds } },
      ],
    }).lean();
  }
  let registryValues = [];
  if (registryFields.length) {
    registryValues = await RegistryDataValue.find({
      key: { $in: registryFields.map((f) => f.keyId) },
      status: 'published',
      wineDefinition: { $in: wineIds },
    }).lean();
  }
  const registryByWineKey = new Map(registryValues.map((v) => [`${v.wineDefinition}:${v.key}`, v.value]));

  // Personal precedence per (bottle, key): bottle entry > wine entry matching
  // the bottle's vintage > wine entry with no vintage — the bottle page rule.
  const personalValue = (bottle, keyId) => {
    let wineNull;
    let wineVint;
    for (const e of personalEntries) {
      if (String(e.key) !== String(keyId)) continue;
      if (e.targetType === 'bottle' && String(e.bottle) === String(bottle._id)) return e.value;
      if (e.targetType === 'wine' && String(e.wineDefinition) === String(bottle.wineDefinition?._id || bottle.wineDefinition)) {
        if (e.vintage && e.vintage === bottle.vintage) wineVint = e.value;
        else if (!e.vintage) wineNull = e.value;
      }
    }
    return wineVint !== undefined ? wineVint : wineNull;
  };

  // Maturity status only when asked for — profile map is one query.
  const wantsMaturity = fields.some((f) => f.key === 'maturity.status');
  const profileMap = wantsMaturity ? await buildProfileMap(ordered) : null;

  const iso = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d ?? null);
  const extract = (b, f) => {
    switch (f.source) {
      case 'bottle': {
        const v = f.path.split('.').reduce((o, k) => (o == null ? o : o[k]), b);
        if (f.normalized) {
          // Ratings display in STARS (audit F3), the same scale the filter
          // takes and the sort orders by — one decimal, honest across a
          // cellar whose rows mix 5/20/100-scale entries.
          if (v == null) return null;
          const stars = fromNormalized(toNormalized(v, b[f.scalePath]), '5');
          return stars == null ? null : Math.round(stars * 10) / 10;
        }
        return f.type === 'date' ? iso(v) : v ?? null;
      }
      case 'wine': {
        const v = b.wineDefinition ? b.wineDefinition[f.path.replace(/^wd\./, '')] : null;
        return v ?? null;
      }
      case 'taxonomy': {
        const rel = f.path.replace(/^wd\./, '');
        const v = b.wineDefinition ? b.wineDefinition[rel] : null;
        if (Array.isArray(v)) return v.map((x) => x?.name).filter(Boolean);
        return v?.name ?? null;
      }
      case 'computed': {
        if (f.key === 'bottle.cellar') return cellarNames.get(String(b.cellar)) ?? null;
        if (f.key === 'maturity.status') return classifyMaturity(b, profileMap) ?? 'unknown';
        return null;
      }
      case 'personal': {
        const v = personalValue(b, f.keyId);
        return v === undefined ? null : v;
      }
      case 'registry': {
        const wid = String(b.wineDefinition?._id || b.wineDefinition);
        const v = registryByWineKey.get(`${wid}:${f.keyId}`);
        return v === undefined ? null : v;
      }
      default:
        return null;
    }
  };

  return ordered.map((b) => {
    const values = {};
    for (const f of fields) values[f.key] = extract(b, f);
    return { id: String(b._id), values };
  });
}

// ── grouped mode ───────────────────────────────────────────────────────────

async function runGrouped({ userId, scopeCellars, bottleScope, filters, dimensions, measures }) {
  const { pre, post, exprFilters, needsWine: filterNeedsWine } = await compileFilters(filters, userId);

  // ZERO dimensions is the KPI shape (dashboards, R-E): one bucket holding
  // the whole scoped set — "total bottles", "total value", "average rating".
  if (!Array.isArray(dimensions) || dimensions.length > MAX_DIMENSIONS) {
    throw new QueryError(400, `grouped mode takes 0–${MAX_DIMENSIONS} dimensions (0 = one summary bucket)`);
  }
  if (!Array.isArray(measures) || !measures.length || measures.length > 5) {
    throw new QueryError(400, 'grouped mode takes 1–5 measures');
  }

  let needsWine = filterNeedsWine;
  const joinStages = [];
  const dimFields = [];
  const dimExprs = [];
  for (let i = 0; i < (dimensions || []).length; i++) {
    const f = await resolveField(dimensions[i], userId);
    if (!f) throw new QueryError(400, `Unknown dimension "${dimensions[i]}"`);
    if (!f.groupable) throw new QueryError(400, `Field "${dimensions[i]}" cannot be grouped`);
    if (f.source === 'personal' || f.source === 'registry') {
      // R-B: group by the joined KV value (non-numeric keys only, per the
      // catalogue flag — numeric readings would bucket per distinct value).
      joinStages.push(...kvJoinStages(f, `_d${i}v`, userId));
      dimExprs.push(`$_d${i}v`);
    } else {
      if (f.path && f.path.startsWith('wd.')) needsWine = true;
      dimExprs.push(`$${f.path}`);
    }
    dimFields.push(f);
  }

  // Measures: {field: '*', agg: 'count'} or {field, agg}.
  const rates = (await getOrCreateDailySnapshot().catch(() => null))?.rates || null;
  const measureSpecs = [];
  let currencyMeta = null;
  for (let i = 0; i < measures.length; i++) {
    const m = measures[i] || {};
    if (m.field === '*' || m.agg === 'count') {
      measureSpecs.push({ out: `m${i}`, label: 'count', stage: { $sum: 1 } });
      continue;
    }
    const f = await resolveField(m.field, userId);
    if (!f) throw new QueryError(400, `Unknown measure field "${m.field}"`);
    if (!(f.aggregations || []).includes(m.agg)) {
      throw new QueryError(400, `Field "${m.field}" does not support "${m.agg}"`);
    }
    if (f.source === 'personal' || f.source === 'registry') {
      // R-B: numeric KV measures aggregate the joined value. The $isNumber
      // guard keeps a stray non-numeric entry (possible on rows written
      // before a key existed, or via import) out of the accumulator instead
      // of poisoning it.
      joinStages.push(...kvJoinStages(f, `_m${i}v`, userId));
      measureSpecs.push({
        out: `m${i}`, label: `${m.agg}(${f.label})`, agg: m.agg,
        valueExpr: { $cond: [{ $isNumber: `$_m${i}v` }, `$_m${i}v`, null] },
        field: f,
      });
      continue;
    }
    let valueExpr = `$${f.path}`;
    if (f.unit === 'currency') {
      currencyMeta = currencyMeta || { fields: [] };
      currencyMeta.fields.push({ i, path: f.path, currencyPath: 'currency' });
      valueExpr = null; // filled in below once the target currency is known
    } else if (f.normalized) {
      // Stars, not the 0–100 normal form (audit F3) — the same scale the
      // filter takes, the sort orders by and the column displays.
      valueExpr = ratingConversionExpr(f.path, f.scalePath, '5');
    }
    measureSpecs.push({ out: `m${i}`, label: `${m.agg}(${f.key})`, agg: m.agg, valueExpr, field: f });
  }

  // Target currency: caller's explicit choice, else the modal currency among
  // their scoped bottles, else USD. Reported in the envelope either way.
  let targetCurrency = null;
  let unconvertibleRows = 0;
  const cellarIds = scopeCellars.map((c) => c._id);
  if (currencyMeta) {
    const [top] = await Bottle.aggregate([
      { $match: { cellar: { $in: cellarIds }, price: { $ne: null } } },
      { $group: { _id: '$currency', n: { $sum: 1 } } },
      { $sort: { n: -1, _id: 1 } },
      { $limit: 1 },
    ]).option({ maxTimeMS: MAX_TIME_MS });
    targetCurrency = top?._id || 'USD';
    for (const cf of currencyMeta.fields) {
      const { expr } = convertedPriceExpr(cf.path, cf.currencyPath, rates, targetCurrency);
      const spec = measureSpecs[cf.i];
      spec.valueExpr = expr; // null when no rates → measure yields null
    }
    // Count rows whose price exists but cannot convert — over the SAME
    // filtered population as the buckets (audit F5: counting before the
    // wine-side and expression filters overstated the exclusions).
    if (rates && rates[targetCurrency]) {
      const known = Object.keys(rates);
      const [uc] = await Bottle.aggregate([
        { $match: baseMatch(cellarIds, bottleScope, pre) },
        ...(needsWine ? WINE_LOOKUP : []),
        ...(post.length ? [{ $match: { $and: post } }] : []),
        ...exprFilterStages(exprFilters),
        { $match: { price: { $ne: null }, currency: { $nin: known } } },
        { $count: 'n' },
      ]).option({ maxTimeMS: MAX_TIME_MS });
      unconvertibleRows = uc?.n || 0;
    }
  }

  const groupId = {};
  dimFields.forEach((f, i) => { groupId[`d${i}`] = dimExprs[i]; });

  const groupStage = { _id: groupId };
  for (const spec of measureSpecs) {
    if (spec.stage) groupStage[spec.out] = spec.stage;
    else if (spec.valueExpr === null) { spec.noRates = true; groupStage[spec.out] = { $sum: 1 }; } // overwritten to null in the mapping
    else groupStage[spec.out] = { [`$${spec.agg}`]: spec.valueExpr };
  }

  const pipeline = [
    { $match: baseMatch(cellarIds, bottleScope, pre) },
    ...(needsWine ? WINE_LOOKUP : []),
    ...(post.length ? [{ $match: { $and: post } }] : []),
    ...exprFilterStages(exprFilters),
    ...joinStages,
    { $group: groupStage },
    { $sort: { m0: -1, _id: 1 } },
    { $limit: BUCKET_CAP + 1 },
  ];

  const raw = await Bottle.aggregate(pipeline).option({ maxTimeMS: MAX_TIME_MS });
  const capped = raw.length > BUCKET_CAP;
  const buckets = raw.slice(0, BUCKET_CAP);

  // Taxonomy dimension ids → names (small: at most BUCKET_CAP ids per dim).
  for (let i = 0; i < dimFields.length; i++) {
    const f = dimFields[i];
    // The cellar dimension groups by the cellar ObjectId — resolve to names
    // from the scope set, which by construction contains every id that can
    // appear (audit F4: raw hex ids were the bucket labels).
    if (f.key === 'bottle.cellar') {
      const names = new Map(scopeCellars.map((c) => [String(c._id), c.name]));
      for (const b of buckets) {
        const v = b._id[`d${i}`];
        b._id[`d${i}`] = v == null ? null : (names.get(String(v)) || String(v));
      }
      continue;
    }
    if (f.source !== 'taxonomy') continue;
    const Model = mongoose.model(f.taxonomyModel);
    const ids = [...new Set(buckets.map((b) => String(b._id[`d${i}`])).filter((x) => x && x !== 'null'))];
    const docs = await Model.find({ _id: { $in: ids } }).select('name').lean();
    const names = new Map(docs.map((d) => [String(d._id), d.name]));
    for (const b of buckets) {
      const v = b._id[`d${i}`];
      b._id[`d${i}`] = v == null ? null : (names.get(String(v)) || String(v));
    }
  }

  return {
    mode: 'grouped',
    buckets: buckets.map((b) => ({
      dimensions: dimFields.map((f, i) => b._id[`d${i}`] ?? null),
      measures: measureSpecs.map((s) => (s.noRates || b[s.out] === undefined ? null : b[s.out])),
    })),
    measureLabels: measureSpecs.map((s) => s.label),
    dimensionKeys: dimFields.map((f) => f.key),
    ...(capped ? { capped: { type: 'buckets', at: BUCKET_CAP } } : {}),
    ...(targetCurrency ? { currency: { target: targetCurrency, unconvertibleRows, ratesAvailable: !!(rates && rates[targetCurrency]) } } : {}),
  };
}

// ── entry point ────────────────────────────────────────────────────────────

/**
 * @param {string} userId
 * @param {object} q  { scope: {cellars, bottles}, mode, filters, columns,
 *                      sort, limit, offset, dimensions, measures }
 */
async function runQuery(userId, q = {}) {
  const scopeReq = q.scope || {};
  const bottleScope = scopeReq.bottles || 'active';
  if (!BOTTLE_SCOPES[bottleScope]) {
    throw new QueryError(400, 'scope.bottles must be active, consumed or all');
  }
  const scopeCellars = await deriveScope(userId, scopeReq.cellars);

  const envelopeScope = {
    cellars: scopeCellars.map((c) => ({ id: String(c._id), name: c.name })),
    bottles: bottleScope,
  };

  if (q.mode === 'grouped') {
    const out = await runGrouped({
      userId, scopeCellars, bottleScope,
      filters: q.filters, dimensions: q.dimensions, measures: q.measures,
    });
    return { ...out, scope: envelopeScope };
  }

  const columns = Array.isArray(q.columns) && q.columns.length ? q.columns : ['wine.producer', 'wine.name', 'bottle.vintage'];
  if (columns.length > 30) throw new QueryError(400, 'At most 30 columns');
  const out = await runRows({
    userId, scopeCellars, bottleScope,
    filters: q.filters, sort: q.sort, limit: q.limit, offset: q.offset, columns,
  });
  return { ...out, scope: envelopeScope };
}

module.exports = {
  runQuery,
  QueryError,
  // exported for unit tests
  deriveScope, compileFilters, normalizedRatingExpr, ratingConversionExpr, convertedPriceExpr,
  MAX_TIME_MS, ROWS_LIMIT_MAX, BUCKET_CAP,
};
