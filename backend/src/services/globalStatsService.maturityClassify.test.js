/**
 * The SuperAdmin maturity figure classifies each (wine, vintage) pair inside
 * the aggregation pipeline, so it must give the same phase as
 * utils/maturityUtils.js#classifyMaturity gives the same reviewed profile.
 *
 * Aggregations need a real MongoDB, so the classify stage is read from the
 * REAL source (the way globalStatsService.maturityJoin.test.js reads it) and
 * run here by a small evaluator for the operators it uses. The evaluator keeps
 * MongoDB's comparison order, where a MISSING field sorts below null and null
 * below every number (measured on Mongo 7: `$eq: [<missing>, null]` is false,
 * `$ne: [<missing>, null]` and `$gt: [2026, <missing>]` are true). That is the
 * shape that matters: the sommelier writers $unset a cleared phase, so an
 * unset boundary is an absent field in the database, not a null.
 */
const fs = require('fs');
const { classifyMaturity } = require('../utils/maturityUtils');

const src = fs.readFileSync(require.resolve('./globalStatsService'), 'utf8');
const Y = new Date().getFullYear();
const FIELDS = ['earlyFrom', 'earlyUntil', 'peakFrom', 'peakUntil', 'lateFrom', 'lateUntil'];

function maturityPipeline() {
  const start = src.indexOf('const maturityRaw = await safeAggregate(Bottle, [');
  expect(start).toBeGreaterThan(-1);
  const open = src.indexOf('[', start);
  let depth = 0;
  let i = open;
  for (; i < src.length; i++) {
    if (src[i] === '[') depth++;
    else if (src[i] === ']') { depth--; if (depth === 0) break; }
  }
  // The pipeline literal reads two locals from its surroundings.
  const bottleMatch = {};
  const currentYear = Y;
  // eslint-disable-next-line no-eval
  return eval(src.slice(open, i + 1));
}

// ── Aggregation-expression evaluator ────────────────────────────────────────
// BSON order for the types in play: missing < null < number < string.
const rank = (v) => (v === undefined ? 0 : v === null ? 1 : typeof v === 'number' ? 2 : 3);
function cmp(a, b) {
  const d = rank(a) - rank(b);
  if (d !== 0 || rank(a) < 2) return d;
  return a < b ? -1 : a > b ? 1 : 0;
}
const truthy = (v) => !(v === undefined || v === null || v === false || v === 0);
const getPath = (obj, path) => path.split('.').reduce(
  (o, k) => (o !== null && typeof o === 'object' ? o[k] : undefined), obj);

function evaluate(expr, doc, vars = {}) {
  if (typeof expr === 'string') {
    if (expr.startsWith('$$')) {
      const [name, ...rest] = expr.slice(2).split('.');
      return rest.length ? getPath(vars[name], rest.join('.')) : vars[name];
    }
    return expr.startsWith('$') ? getPath(doc, expr.slice(1)) : expr;
  }
  if (expr === null || typeof expr !== 'object') return expr;
  const keys = Object.keys(expr);
  if (keys.length !== 1) throw new Error(`unsupported expression ${JSON.stringify(expr)}`);
  const op = keys[0];
  const arg = expr[op];
  const ev = (e) => evaluate(e, doc, vars);
  switch (op) {
    case '$and': return arg.every((e) => truthy(ev(e)));
    case '$or': return arg.some((e) => truthy(ev(e)));
    case '$eq': return cmp(ev(arg[0]), ev(arg[1])) === 0;
    case '$ne': return cmp(ev(arg[0]), ev(arg[1])) !== 0;
    case '$lt': return cmp(ev(arg[0]), ev(arg[1])) < 0;
    case '$lte': return cmp(ev(arg[0]), ev(arg[1])) <= 0;
    case '$gt': return cmp(ev(arg[0]), ev(arg[1])) > 0;
    case '$gte': return cmp(ev(arg[0]), ev(arg[1])) >= 0;
    case '$ifNull': {
      const v = ev(arg[0]);
      return v === null || v === undefined ? ev(arg[1]) : v;
    }
    case '$cond': return truthy(ev(arg.if)) ? ev(arg.then) : ev(arg.else);
    case '$switch': {
      for (const b of arg.branches) if (truthy(ev(b.case))) return ev(b.then);
      if (!('default' in arg)) throw new Error('$switch matched no branch and has no default');
      return ev(arg.default);
    }
    case '$let': {
      // Variables are evaluated in the outer scope, then bound for `in`.
      const bound = { ...vars };
      for (const [k, v] of Object.entries(arg.vars)) bound[k] = ev(v);
      return evaluate(arg.in, doc, bound);
    }
    default: throw new Error(`unsupported operator ${op}`);
  }
}

// ── The two classifiers ─────────────────────────────────────────────────────
const classifyExpr = (() => {
  const stage = maturityPipeline().find((s) => s.$addFields && s.$addFields.maturity);
  return stage.$addFields.maturity;
})();

// `window` lists the boundaries that are set. Shape 'absent' leaves the
// others out of the document (what the writers store); shape 'null' stores
// them as null.
function profileDoc(window, shape) {
  if (window === undefined) return undefined;
  const doc = { status: 'reviewed', relative: false, ...window };
  if (shape === 'null') for (const f of FIELDS) if (!(f in window)) doc[f] = null;
  return doc;
}

function pipelineBucket(window, shape) {
  const profile = profileDoc(window, shape);
  const row = { _id: { wd: 'wd1', v: '2015' }, n: 1 };
  if (profile !== undefined) row.profile = profile;
  return evaluate(classifyExpr, row);
}

function jsBucket(window, shape) {
  const profile = profileDoc(window, shape);
  const map = new Map(profile ? [['wd1:2015', profile]] : []);
  const r = classifyMaturity({ wineDefinition: 'wd1', vintage: '2015' }, map);
  if (r === null) return 'noProfile';
  return r === 'not-ready' ? 'notReady' : r;
}

describe('stats maturity classification matches classifyMaturity', () => {
  it('evaluates missing fields the way MongoDB does', () => {
    expect(evaluate({ $eq: ['$a', null] }, {})).toBe(false);
    expect(evaluate({ $ne: ['$a', null] }, {})).toBe(true);
    expect(evaluate({ $gt: [2026, '$a'] }, {})).toBe(true);
    expect(evaluate({ $ifNull: ['$a', null] }, {})).toBe(null);
  });

  const full = (o) => ({
    earlyFrom: Y + o, earlyUntil: Y + o + 2,
    peakFrom: Y + o + 3, peakUntil: Y + o + 6,
    lateFrom: Y + o + 7, lateUntil: Y + o + 10,
  });

  const cases = [
    ['open-ended late that began last year', { peakFrom: Y - 6, peakUntil: Y - 2, lateFrom: Y - 1 }, 'late'],
    ['open-ended late that begins this year', { peakFrom: Y - 6, peakUntil: Y - 1, lateFrom: Y }, 'late'],
    ['peakFrom only, in the past', { peakFrom: Y - 6 }, 'peak'],
    ['peakFrom only, in the future', { peakFrom: Y + 4 }, 'notReady'],
    ['earlyFrom only, begun', { earlyFrom: Y - 3 }, 'early'],
    ['early window past, nothing after it', { earlyFrom: Y - 6, earlyUntil: Y - 3 }, 'early'],
    ['peak window past, no late phase', { peakFrom: Y - 8, peakUntil: Y - 2 }, 'declining'],
    ['peakUntil only, ahead', { peakUntil: Y + 2 }, 'peak'],
    ['six phases, before the first', full(1), 'notReady'],
    ['six phases, in early', full(-1), 'early'],
    ['six phases, in peak', full(-4), 'peak'],
    ['six phases, in late', full(-8), 'late'],
    ['six phases, past the end', full(-12), 'declining'],
    ['a reviewed profile with no boundaries', {}, 'noProfile'],
    ['a late phase alone', { lateFrom: Y - 2, lateUntil: Y + 2 }, 'noProfile'],
    ['no reviewed profile', undefined, 'noProfile'],
  ];

  describe.each(['absent', 'null'])('unset boundaries %s', (shape) => {
    it.each(cases)('%s', (_label, window, expected) => {
      expect(jsBucket(window, shape)).toBe(expected);
      expect(pipelineBucket(window, shape)).toBe(expected);
    });

    it('agrees with classifyMaturity on every combination of set and unset boundaries', () => {
      const values = [undefined, Y - 1, Y, Y + 1];
      const mismatches = [];
      for (let k = 0; k < values.length ** FIELDS.length; k++) {
        const window = {};
        let rest = k;
        for (const f of FIELDS) {
          const v = values[rest % values.length];
          rest = Math.floor(rest / values.length);
          if (v !== undefined) window[f] = v;
        }
        const js = jsBucket(window, shape);
        const pipe = pipelineBucket(window, shape);
        if (js !== pipe) mismatches.push({ window, js, pipe });
      }
      expect(mismatches.slice(0, 5)).toEqual([]);
    });
  });
});
