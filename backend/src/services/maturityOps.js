// Drink-window (maturity) curation, the one body behind both doors: the REST
// routes in routes/somm/maturity.js (the web somm page) and the MCP tools in
// mcp/tools/somm.js (set_vintage_maturity, reset_maturity_row,
// remove_from_maturity_queue), plus the undo inverses mcp/revert.js applies.
//
// A WineVintageProfile row is one wine+vintage pair. Setting its window marks
// it reviewed with the curator's stamp; withdrawing (reset) clears it back to
// pending; removing deletes a pending stub outright (the next bottle add
// re-seeds it). Every write moves the wine owners' data version, because
// their maturity statistics change with the window, and audits under the
// action strings both doors share. Each door keeps its own input parsing and
// wording; it passes `via` so the audit row says which door was used.
//
// NV vintages store the window as year-offsets after each bottle's purchase
// year (relative), since there is no vintage to anchor absolute years to.
//
// This module stays free of Express and of the MCP envelope.

const WineVintageProfile = require('../models/WineVintageProfile');
const { logAudit } = require('./audit');
const { bumpWineOwners } = require('./dataVersion');

const PHASE_FIELDS = ['earlyFrom', 'earlyUntil', 'peakFrom', 'peakUntil', 'lateFrom', 'lateUntil'];
const PHASE_PAIRS = [['earlyFrom', 'earlyUntil'], ['peakFrom', 'peakUntil'], ['lateFrom', 'lateUntil']];

/** The wine id of a profile whether or not wineDefinition is populated. */
const wineIdOf = (profile) => profile.wineDefinition?._id || profile.wineDefinition;

/** The vintage string the profiles store: trimmed, and "nv" in any case as NV. */
function canonicalVintage(raw) {
  const v = String(raw).trim();
  return /^nv$/i.test(v) ? 'NV' : v;
}

/** Relative offsets 0–100 for an NV row, absolute years 1900–2200 otherwise. */
function windowRange(profile) {
  const relative = profile.vintage === 'NV';
  return relative ? { relative, min: 0, max: 100 } : { relative, min: 1900, max: 2200 };
}

/**
 * The six phases the row would hold after a patch: each incoming value
 * (undefined = keep the stored one, null = clear) checked against the row's
 * range, then every RETAINED value checked too, then the ordering. Returns
 * { ok: true, next } or { ok: false, code, message } with code 'invalid_input'
 * or 'conflict'. Caller: set_vintage_maturity (the web PUT keeps its own
 * validator, which checks only the fields sent).
 *
 * The retained-value check is what keeps a profile that predates the relative
 * flag — absolute years stored under vintage NV — from being half-rewritten:
 * the save flips relative, which would silently reread a carried-forward 2024
 * as "2024 years after purchase". Such a row has to be rewritten whole.
 */
function mergeWindow(profile, incoming) {
  const { relative, min, max } = windowRange(profile);
  const rangeWord = relative ? 'NV uses relative offsets 0–100' : 'years 1900–2200';
  const next = {};
  for (const f of PHASE_FIELDS) {
    const v = incoming[f];
    if (v === undefined) { next[f] = profile[f] ?? null; continue; }
    if (v === null) { next[f] = null; continue; }
    if (v < min || v > max) {
      return { ok: false, code: 'invalid_input', message: `${f}: ${v} out of range (${rangeWord})` };
    }
    next[f] = v;
  }
  for (const f of PHASE_FIELDS) {
    if (incoming[f] !== undefined) continue;
    const v = next[f];
    if (v != null && (v < min || v > max)) {
      return {
        ok: false,
        code: 'conflict',
        message: `${f}=${v} retained from the stored profile is outside the ${relative ? 'NV offset range 0–100' : 'year range 1900–2200'} — ` +
          'this profile still carries values in the other unit. Rewrite all six phases in this call (pass null to clear a phase).',
      };
    }
  }
  for (const [from, until] of PHASE_PAIRS) {
    if (next[from] != null && next[until] != null && next[until] < next[from]) {
      return { ok: false, code: 'invalid_input', message: `${until} cannot be before ${from}` };
    }
  }
  if (next.earlyFrom != null && next.peakFrom != null && next.peakFrom < next.earlyFrom) {
    return { ok: false, code: 'invalid_input', message: 'peak_from cannot be before early_from' };
  }
  if (next.peakFrom != null && next.lateFrom != null && next.lateFrom < next.peakFrom) {
    return { ok: false, code: 'invalid_input', message: 'late_from cannot be before peak_from' };
  }
  return { ok: true, next };
}

/**
 * Everything an undo needs to put the row back verbatim: the six phases
 * (null when unset), the note, and the review state. Both set and reset
 * record this shape, so one undo branch restores either.
 */
function windowSnapshot(profile) {
  return {
    ...PHASE_FIELDS.reduce((acc, f) => ((acc[f] = profile[f] ?? null), acc), {}),
    sommNotes: profile.sommNotes ?? null,
    status: profile.status,
    relative: !!profile.relative,
    setBy: profile.setBy ? String(profile.setBy) : null,
    setAt: profile.setAt || null,
  };
}

/**
 * Write a validated window onto the row: the six phases from `next` (null
 * clears), the note when given (undefined leaves it), reviewed with the
 * curator's stamp and the row's relative flag. Saves, moves the owners'
 * data version, audits somm.maturity.review. Returns the relative flag.
 */
async function applyWindow(profile, next, { sommNotes, actorId, req, via }) {
  for (const f of PHASE_FIELDS) profile[f] = next[f] === null ? undefined : next[f];
  if (sommNotes !== undefined) profile.sommNotes = sommNotes;
  const { relative } = windowRange(profile);
  profile.relative = relative;
  profile.status = 'reviewed';
  profile.setBy = actorId;
  profile.setAt = new Date();
  await profile.save();
  bumpWineOwners([wineIdOf(profile)]);
  logAudit(req, 'somm.maturity.review',
    { type: 'wine', id: wineIdOf(profile) },
    { vintage: profile.vintage, relative, ...(via ? { via } : {}) });
  return relative;
}

/**
 * Withdraw a reviewed window: every phase and the note cleared, pending
 * again, the reviewer stamp dropped. The caller has checked the row is
 * reviewed. Saves, moves the owners' data version, audits somm.maturity.reset.
 */
async function resetWindow(profile, { reason, req, via } = {}) {
  for (const f of PHASE_FIELDS) profile[f] = undefined;
  profile.sommNotes = '';
  profile.status = 'pending';
  profile.setBy = null;
  profile.setAt = null;
  await profile.save();
  bumpWineOwners([wineIdOf(profile)]);
  logAudit(req, 'somm.maturity.reset',
    { type: 'wine', id: wineIdOf(profile) },
    { vintage: profile.vintage, ...(reason ? { reason } : {}), ...(via ? { via } : {}) });
}

/**
 * Delete a pending row the wine was never released in. Nothing is remembered
 * on purpose: the next bottle add of this wine+vintage re-seeds the row. The
 * caller has checked the row is not reviewed. Audits somm.maturity.remove.
 */
async function removePendingRow(profile, { reason, req, via } = {}) {
  await WineVintageProfile.deleteOne({ _id: profile._id });
  logAudit(req, 'somm.maturity.remove',
    { type: 'wine', id: wineIdOf(profile) },
    { vintage: profile.vintage, ...(reason ? { reason } : {}), ...(via ? { via } : {}) });
}

/**
 * Undo of applyWindow and resetWindow: re-apply a windowSnapshot field for
 * field, then save (a VersionError is thrown to the caller) and move the
 * owners' data version. The audit row stays with the caller, whose action
 * string depends on what is being undone.
 */
async function restoreWindow(profile, prev) {
  for (const f of PHASE_FIELDS) {
    profile[f] = prev[f] === null || prev[f] === undefined ? undefined : prev[f];
  }
  profile.sommNotes = prev.sommNotes === null ? undefined : prev.sommNotes;
  profile.status = prev.status || 'pending';
  profile.relative = !!prev.relative;
  profile.setBy = prev.setBy || null;
  profile.setAt = prev.setAt || null;
  await profile.save();
  bumpWineOwners([wineIdOf(profile)]);
}

/**
 * Undo of removePendingRow: the pending stub comes back by upsert on the
 * unique (wineDefinition, vintage) index, so a bottle add that re-seeded it
 * in the meantime is simply found. A direct upsert rather than the seeding
 * helper, which swallows errors: an undo must fail loudly so its ledger row
 * can be unclaimed and retried.
 */
async function reseedPendingRow({ wineDefinition, vintage }) {
  await WineVintageProfile.findOneAndUpdate(
    { wineDefinition, vintage },
    { $setOnInsert: { wineDefinition, vintage, status: 'pending' } },
    { upsert: true }
  );
}

module.exports = {
  PHASE_FIELDS,
  wineIdOf,
  canonicalVintage,
  windowRange,
  mergeWindow,
  windowSnapshot,
  applyWindow,
  resetWindow,
  removePendingRow,
  restoreWindow,
  reseedPendingRow,
};
