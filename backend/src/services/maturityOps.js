/**
 * Maturity-queue status transitions.
 *
 * Why this exists: a curator working the queue meets wine+vintage pairs that
 * cannot be curated at all. A user types a vintage the wine was never released
 * for — most often while testing the app, sometimes a purchase or disgorgement
 * year mistaken for a vintage — and the pair sits in the queue forever. The two
 * existing exits are both wrong for it: marking it reviewed invents a drink
 * window on data shared with every owner of that wine, and there is no discard.
 *
 * Deferring is the third exit. It takes the row out of the queue with the phase
 * values left empty, and schedules its return for when the vintage plausibly
 * exists — so if the wine IS later released for that year, the pair comes back
 * to a somm instead of being lost.
 *
 * THE one implementation, shared by the REST route (routes/somm/maturity.js)
 * and the MCP tool (mcp/tools/somm.js defer_vintage_maturity) so the two
 * surfaces cannot drift on validation, provenance or the undo snapshot — the
 * same reason wineProfileOps/bottleOps exist. Pure and save-free: callers own
 * the write and the audit entry.
 */

// A wine from harvest year Y is essentially never on the market before Y+2:
// even en primeur, which is SOLD earlier, delivers around then. That is the
// default the curator gets without having to reason about it.
const DEFAULT_DEFER_YEARS_AFTER_VINTAGE = 2;

// A defer must buy a real pause. Without this floor, deferring a pair whose
// vintage year is already past would compute a date behind us and the row
// would come straight back on the next queue load — a no-op that looks like a
// bug to the curator who just used it.
const MIN_DEFER_YEARS = 1;

// Anything beyond this is a typo (a four-digit year in the wrong field, a
// mis-parsed date), not a judgement about wine.
const MAX_DEFER_YEARS = 50;

const REASON_MAX = 500;

/** '2018' → 2018. NV, Unknown and anything not a bare 4-digit year → null. */
function parseVintageYear(vintage) {
  const m = /^\d{4}$/.exec(String(vintage ?? '').trim());
  return m ? parseInt(m[0], 10) : null;
}

function addYears(date, years) {
  return new Date(Date.UTC(
    date.getUTCFullYear() + years,
    date.getUTCMonth(),
    date.getUTCDate(),
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
    date.getUTCMilliseconds()
  ));
}

/**
 * When should this pair come back on its own?
 *
 * Vintage year + 2, floored at one year from now. NV/Unknown/junk vintages have
 * no year to reason from, so they get the floor.
 *
 * @param {string} vintage  canonical vintage ('2018', 'NV', …)
 * @param {Date}   [now]
 * @returns {Date}
 */
function computeDefaultDeferUntil(vintage, now = new Date()) {
  const floor = addYears(now, MIN_DEFER_YEARS);
  const year = parseVintageYear(vintage);
  if (year === null) return floor;
  const releaseGuess = new Date(Date.UTC(year + DEFAULT_DEFER_YEARS_AFTER_VINTAGE, 0, 1));
  return releaseGuess > floor ? releaseGuess : floor;
}

/**
 * The query for one queue view.
 *
 * The whole return mechanism lives here: a deferred row whose date has passed
 * IS pending again, decided on read. Nothing schedules it, so nothing can fail
 * to run — and the row keeps an honest record of having been deferred.
 *
 * A due row appears in Pending and NOT in Deferred, so it can never be worked
 * on from two views at once.
 *
 * @param {string} status  'pending' | 'reviewed' | 'deferred' | anything else = all
 * @param {Date}   [now]
 */
function buildQueueFilter(status, now = new Date()) {
  if (status === 'pending') {
    return {
      $or: [
        { status: 'pending' },
        { status: 'deferred', deferredUntil: { $ne: null, $lte: now } },
      ],
    };
  }
  if (status === 'deferred') {
    return {
      status: 'deferred',
      $or: [
        { deferredUntil: null },            // indefinite — only a curator brings it back
        { deferredUntil: { $gt: now } },
      ],
    };
  }
  if (status === 'reviewed') return { status: 'reviewed' };
  return {};
}

/** True once a deferred row's date has passed (it is back in the pending queue). */
function isDeferralDue(profile, now = new Date()) {
  if (!profile || profile.status !== 'deferred') return false;
  return !!profile.deferredUntil && new Date(profile.deferredUntil) <= now;
}

/**
 * Validate the requested return date.
 *
 * Three inputs, deliberately distinct:
 *   undefined  → use the computed default (the curator did not choose)
 *   null / ''  → indefinite (the curator says this vintage does not exist)
 *   ISO date   → that date
 *
 * @returns {{ok: true, value: Date|null}|{ok: false, error: string}}
 */
function parseDeferUntil(input, vintage, now = new Date()) {
  if (input === undefined) return { ok: true, value: computeDefaultDeferUntil(vintage, now) };
  if (input === null || input === '') return { ok: true, value: null };

  const date = input instanceof Date ? new Date(input.getTime()) : new Date(String(input));
  if (isNaN(date.getTime())) {
    return { ok: false, error: 'deferUntil must be an ISO date (YYYY-MM-DD), or null to defer indefinitely' };
  }
  if (date <= now) {
    return { ok: false, error: 'deferUntil must be in the future' };
  }
  if (date > addYears(now, MAX_DEFER_YEARS)) {
    return { ok: false, error: `deferUntil cannot be more than ${MAX_DEFER_YEARS} years from now` };
  }
  return { ok: true, value: date };
}

/** @returns {{ok: true, value: string}|{ok: false, error: string}} */
function parseDeferReason(input) {
  if (input === undefined || input === null || input === '') return { ok: true, value: '' };
  if (typeof input !== 'string') return { ok: false, error: 'reason must be a string' };
  const text = input.trim();
  if (text.length > REASON_MAX) {
    return { ok: false, error: `reason must be ${REASON_MAX} characters or fewer` };
  }
  return { ok: true, value: text };
}

/**
 * May this row be deferred?
 *
 * A reviewed row is not in the queue and already carries a curated window that
 * users see; hiding it behind a deferral would silently retire real data. Reset
 * it first — that is an explicit, audited step.
 *
 * @returns {{ok: true}|{ok: false, error: string}}
 */
function canDefer(profile) {
  if (profile?.status === 'reviewed') {
    return { ok: false, error: 'This vintage is already reviewed — reset it to pending before deferring it.' };
  }
  return { ok: true };
}

/** The fields an undo needs to put back, captured before mutation. */
function snapshotDeferral(profile) {
  return {
    status: profile.status,
    deferredUntil: profile.deferredUntil || null,
    deferredReason: profile.deferredReason || '',
    deferredBy: profile.deferredBy ? String(profile.deferredBy) : null,
    deferredAt: profile.deferredAt || null,
  };
}

/** Restore a snapshot verbatim (undo). Mirrors applyDefer's surface. */
function restoreDeferral(profile, snap) {
  profile.status = snap?.status || 'pending';
  profile.deferredUntil = snap?.deferredUntil || null;
  profile.deferredReason = snap?.deferredReason || '';
  profile.deferredBy = snap?.deferredBy || null;
  profile.deferredAt = snap?.deferredAt || null;
  return profile;
}

/**
 * Take the pair out of the queue without curating it. Does NOT save.
 *
 * The phase values are deliberately untouched: a deferral is "no judgement
 * yet", and writing empty windows would be a judgement.
 */
function applyDefer(profile, { until, reason = '', userId, now = new Date() }) {
  profile.status = 'deferred';
  profile.deferredUntil = until || null;
  profile.deferredReason = reason || '';
  profile.deferredBy = userId || null;
  profile.deferredAt = now;
  return profile;
}

/** Drop any deferral state, leaving status alone. Used when a row is reviewed
 *  or reset, so a curated/pending row can never carry a stale return date. */
function clearDeferral(profile) {
  profile.deferredUntil = null;
  profile.deferredReason = '';
  profile.deferredBy = null;
  profile.deferredAt = null;
  return profile;
}

/** Send a deferred row back to the queue by hand (does NOT save). */
function returnToQueue(profile) {
  clearDeferral(profile);
  profile.status = 'pending';
  return profile;
}

module.exports = {
  DEFAULT_DEFER_YEARS_AFTER_VINTAGE,
  MIN_DEFER_YEARS,
  MAX_DEFER_YEARS,
  REASON_MAX,
  parseVintageYear,
  computeDefaultDeferUntil,
  buildQueueFilter,
  isDeferralDue,
  parseDeferUntil,
  parseDeferReason,
  canDefer,
  snapshotDeferral,
  restoreDeferral,
  applyDefer,
  clearDeferral,
  returnToQueue,
};
