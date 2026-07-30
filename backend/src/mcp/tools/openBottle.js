// Open-bottle (Coravin / preservation) tracking over MCP — the WRITE side of
// the open_bottle state that get_bottle and what_should_i_open_tonight already
// read (issue #835: the ranking logic depended on data MCP clients could not
// produce). Scope `consume`, like consume_bottle — opening and pouring are
// drinking actions, and the HA integration's consume token covers the fridge
// workflow ("I opened the Riesling, put a vacuum stopper in").
//
// The ops are the SAME implementation the REST routes run (services/bottleOps
// openBottle/pourFromBottle/closeBottle), so validation, freshness bookkeeping
// and audit cannot drift between surfaces. An open bottle stays ACTIVE and
// KEEPS its rack slot — it is still physically in the cellar.
//
// Idempotency: open_bottle and close_bottle are idempotent BY STATE (a repeat
// open of an already-open bottle reports the existing state instead of acting;
// same shape as restore_bottle) and need no key. pour_glass mutates on every
// call, so it carries the full idempotency_key claim/replay contract.
const { z } = require('zod');
const { registerTool } = require('../registry');
const { openBottle, pourFromBottle, closeBottle } = require('../../services/bottleOps');
// Constants come from the pure util, NOT bottleOps — test suites mock
// services/bottleOps, and z.enum(undefined) at require time would break them.
const {
  PRESERVATION_FRESHNESS_DAYS, PRESERVATION_METHODS, DEFAULT_POUR_ML, openBottleDeadline,
} = require('../../utils/openBottleUtils');
const { CONSUMED_STATUSES } = require('../../config/constants');
const { logAction, replay } = require('../actionLedger');
const { ok, fail, objectId, MSG_BOTTLE_NOT_FOUND, resolveBottleAccess } = require('../toolUtil');

const bottleLabel = (b) => `bottle ${b._id} (vintage ${b.vintage})`;

/**
 * Consumed bottles KEEP openedAt/preservationMethod/pours as drinking history
 * (Bottle schema), so every handler here must gate on status BEFORE trusting
 * openedAt — otherwise open_bottle would report a drunk bottle as "open and
 * drinkable" and close_bottle would erase preserved history (2026-07-30 audit).
 */
function consumedConflict(bottle, hint) {
  const when = bottle.consumedAt ? ` on ${new Date(bottle.consumedAt).toISOString().slice(0, 10)}` : '';
  return fail('conflict',
    `This bottle was already consumed (${bottle.consumedReason || bottle.status}${when}) — its open-bottle fields are ` +
    `preserved drinking history, not current state. ${hint} Use restore_bottle first if the consume was a mistake.`);
}

/** ml poured so far + remaining estimate from the bottle's size ('750ml' …). */
function pourTotals(bottle) {
  const poured = (bottle.pours || []).reduce((sum, p) => sum + (p.ml || 0), 0);
  const size = parseInt(bottle.bottleSize, 10);
  return {
    pours: (bottle.pours || []).length,
    poured_ml: poured,
    remaining_ml: Number.isFinite(size) && size > 0 ? Math.max(0, size - poured) : null,
  };
}

/** The open-state block shared by all three tools' responses. */
function openState(bottle) {
  if (!bottle.openedAt) return { open: false };
  return {
    open: true,
    opened_at: bottle.openedAt,
    preservation: bottle.preservationMethod || null,
    freshness_days: PRESERVATION_FRESHNESS_DAYS[bottle.preservationMethod] ?? 2,
    drink_by: openBottleDeadline(bottle),
    ...pourTotals(bottle),
  };
}

registerTool({
  name: 'open_bottle',
  title: 'Mark a bottle as opened (partially drunk, preserved)',
  description:
    'Marks an ACTIVE bottle as opened without consuming it — for a bottle the user opened, drank part of and is ' +
    'preserving (re-corked, vacuum, Coravin, inert gas, sparkling stopper). The bottle stays in the cellar and KEEPS ' +
    'its rack slot; what_should_i_open_tonight will rank it first ("finish those first") and the response includes the ' +
    'drink-by deadline for the chosen preservation method. Ask the user HOW they preserved it if unclear — the method ' +
    'sets the freshness window. opened_at backdates the opening ("opened it yesterday"). Calling it on an already-open ' +
    'bottle just reports the existing open state. To log the bottle as finished, use consume_bottle; to record glasses ' +
    'poured, use pour_glass. Reversible via undo_last.',
  scope: 'consume',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: {
    bottle_id: objectId.describe('Bottle id from search_bottles'),
    preservation_method: z.enum(PRESERVATION_METHODS).default('recorked')
      .describe('How the open bottle is kept: coravin (90d), inert-gas (7d), vacuum (4d), sparkling-stopper (2d), recorked (2d)'),
    opened_at: z.string().max(40).optional()
      .describe('When it was opened, ISO date/datetime (defaults to now; max 90 days back, never the future)'),
  },
  handler: async (args, ctx) => {
    const access = await resolveBottleAccess(ctx.user.id, args.bottle_id, 'editor');
    if (!access) return fail('not_found', MSG_BOTTLE_NOT_FOUND);
    const { bottle } = access;

    // BEFORE the already-open shortcut: a consumed bottle may still carry
    // openedAt as history and must never be reported as currently open.
    if (CONSUMED_STATUSES.includes(bottle.status)) {
      return consumedConflict(bottle, 'A consumed bottle cannot be opened.');
    }

    // Idempotent by state (issue #835): a repeat call reports the existing
    // open state instead of erroring — and records nothing new to undo.
    if (bottle.openedAt) {
      return ok(
        `${bottleLabel(bottle)} is already open since ${bottle.openedAt.toISOString().slice(0, 10)} (${bottle.preservationMethod || 'unknown method'}) — nothing changed`,
        { bottle_id: bottle._id, already_open: true, ...openState(bottle) }
      );
    }

    const result = await openBottle(bottle, {
      preservationMethod: args.preservation_method || 'recorked',
      openedAt: args.opened_at,
    }, ctx.req);
    if (result.error) {
      return fail(result.error.code === 'already_open' ? 'conflict' : 'invalid_input', result.error.message);
    }

    const state = openState(bottle);
    const envelope = {
      summary: `Opened ${bottleLabel(bottle)} — ${bottle.preservationMethod}, drink by ${state.drink_by.toISOString().slice(0, 10)}`,
      data: { bottle_id: bottle._id, ...state, undo: 'undo_last (or close_bottle) reverses this' },
    };
    await logAction(ctx, {
      tool: 'open_bottle',
      action: 'open',
      bottle: bottle._id,
      cellar: bottle.cellar,
      detail: { preservationMethod: bottle.preservationMethod, openedAt: bottle.openedAt },
      result: envelope,
    });
    return ok(envelope.summary, envelope.data);
  },
});

registerTool({
  name: 'pour_glass',
  title: 'Record glasses poured from an open bottle',
  description:
    `Records one or more glasses poured from a bottle (default one ${DEFAULT_POUR_ML} ml glass) and returns how much ` +
    'is left. If the bottle is not open yet it is opened implicitly first (preservation_method then applies, default ' +
    'recorked). Use this when the user pours a glass / a Coravin taste — NOT when they finish the bottle (that is ' +
    'consume_bottle). Pass an idempotency_key when retrying so a pour can never be recorded twice. Reversible via undo_last.',
  scope: 'consume',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  inputSchema: {
    bottle_id: objectId.describe('Bottle id from search_bottles'),
    glasses: z.number().int().min(1).max(10).default(1).describe('How many glasses to record'),
    ml: z.number().int().min(1).max(6000).optional().describe(`ml per glass (default ${DEFAULT_POUR_ML})`),
    preservation_method: z.enum(PRESERVATION_METHODS).optional()
      .describe('Only used when the bottle is not open yet (implicit open; default recorked)'),
    idempotency_key: z.string().max(100).optional().describe('Unique key: a retry with the same key returns the original result'),
  },
  handler: async (args, ctx) => {
    const replayed = await replay(ctx, args.idempotency_key, 'pour_glass');
    if (replayed) return replayed;

    const access = await resolveBottleAccess(ctx.user.id, args.bottle_id, 'editor');
    if (!access) return fail('not_found', MSG_BOTTLE_NOT_FOUND);
    const { bottle } = access;

    if (CONSUMED_STATUSES.includes(bottle.status)) {
      return consumedConflict(bottle, 'A consumed bottle cannot be poured from.');
    }

    // Implicit open (issue #835): "I just poured a glass of X" should not
    // require a separate open_bottle round-trip.
    let implicitOpen = false;
    if (!bottle.openedAt) {
      const opened = await openBottle(bottle, { preservationMethod: args.preservation_method || 'recorked' }, ctx.req);
      if (opened.error) return fail('invalid_input', opened.error.message);
      implicitOpen = true;
    }

    // ONE all-or-nothing service call for the whole batch (single save): the
    // per-glass loop this replaces committed up to 10 separate saves before
    // the ledger row, so a mid-batch failure left pours (and the implicit
    // open) persisted but unledgered — invisible to undo_last, and re-poured
    // by a same-key retry after the claim was released (2026-07-30 audit).
    const glasses = args.glasses || 1;
    let result;
    try {
      result = await pourFromBottle(bottle, { ml: args.ml, count: glasses }, ctx.req);
    } catch (err) {
      if (implicitOpen) await rollbackImplicitOpen(bottle, ctx.req);
      throw err; // server wrapper releases the idempotency claim — with the rollback, nothing persisted
    }
    if (result.error) {
      if (implicitOpen) await rollbackImplicitOpen(bottle, ctx.req);
      return fail('invalid_input', result.error.message);
    }

    const state = openState(bottle);
    const envelope = {
      summary: `Recorded ${glasses > 1 ? `${glasses} glasses` : 'a glass'} from ${bottleLabel(bottle)}` +
        `${implicitOpen ? ' (bottle marked open)' : ''}` +
        `${state.remaining_ml != null ? ` — about ${state.remaining_ml} ml left` : ''}`,
      data: { bottle_id: bottle._id, ...state, undo: 'undo_last reverses this pour' },
    };
    await logAction(ctx, {
      tool: 'pour_glass',
      action: 'pour',
      bottle: bottle._id,
      cellar: bottle.cellar,
      detail: {
        count: glasses, // the batch is all-or-nothing, so recorded = requested
        ml: args.ml || DEFAULT_POUR_ML,
        implicitOpen,
        ...(implicitOpen ? { openedAt: bottle.openedAt } : {}),
        poursAfter: state.pours,
      },
      idempotencyKey: args.idempotency_key || null,
      result: envelope,
    });
    return ok(envelope.summary, envelope.data);
  },
});

/**
 * Best-effort rollback of an implicit open whose pour then failed: without it
 * the open would stay committed with NO ledger row — invisible to undo_last
 * and the activity timeline. Re-loads the bottle (after a VersionError our
 * copy is stale) and clears the open state only while it is provably still
 * OUR untouched open (same openedAt, no pours). Never throws — if the
 * rollback loses a race, the leftover open is at least visible in the app.
 */
async function rollbackImplicitOpen(bottle, req) {
  try {
    const Bottle = require('../../models/Bottle');
    const fresh = await Bottle.findById(bottle._id);
    if (!fresh || !fresh.openedAt || (fresh.pours || []).length > 0) return;
    if (new Date(fresh.openedAt).getTime() !== new Date(bottle.openedAt).getTime()) return;
    await closeBottle(fresh, req);
  } catch { /* best-effort */ }
}

registerTool({
  name: 'close_bottle',
  title: 'Clear a bottle\'s open state (mistake undo)',
  description:
    'Clears a bottle\'s open-bottle state WITHOUT consuming it — for an accidental open_bottle, or a bottle that turned ' +
    'out untouched. Discards the recorded pours (undo_last brings them back). NOT for a finished bottle — that is ' +
    'consume_bottle, which keeps the open-bottle history on the consumption record.',
  scope: 'consume',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: { bottle_id: objectId.describe('Bottle id from search_bottles') },
  handler: async (args, ctx) => {
    const access = await resolveBottleAccess(ctx.user.id, args.bottle_id, 'editor');
    if (!access) return fail('not_found', MSG_BOTTLE_NOT_FOUND);
    const { bottle } = access;

    // A consumed bottle's open-bottle fields ARE the drinking history the
    // consumption record preserves — close_bottle must never wipe them.
    if (CONSUMED_STATUSES.includes(bottle.status)) {
      return consumedConflict(bottle, 'Its open-bottle history stays on the consumption record.');
    }

    const result = await closeBottle(bottle, ctx.req);
    if (result.error) {
      return fail('conflict',
        'This bottle is not marked open — nothing to close. If you just closed it, that is done; ' +
        'if the user finished it, use consume_bottle instead.');
    }

    const discarded = result.prevOpenState.pours.length;
    const envelope = {
      summary: `Closed ${bottleLabel(bottle)} — open state cleared${discarded ? ` (${discarded} recorded pour(s) discarded)` : ''}`,
      data: { bottle_id: bottle._id, open: false, pours_discarded: discarded, undo: 'undo_last restores the open state and its pours' },
    };
    await logAction(ctx, {
      tool: 'close_bottle',
      action: 'close',
      bottle: bottle._id,
      cellar: bottle.cellar,
      detail: { preservationMethod: result.prevOpenState.preservationMethod, pours: discarded },
      prev: result.prevOpenState,
      result: envelope,
    });
    return ok(envelope.summary, envelope.data);
  },
});
