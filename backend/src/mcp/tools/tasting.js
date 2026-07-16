// capture_tasting_note (plan Phase 3) — the natural companion of drinking a
// bottle: one call writes a PRIVATE tasting-journal entry (dated, dish-tagged,
// linked to the bottle) and optionally the bottle's rating. Deliberately
// narrower than the REST journal: no people tagging (that carries PII +
// notification side-effects a machine caller has no business triggering) and
// visibility is always private. One ledger row covers both effects, so
// undo_last / the activity timeline revert the note AND the rating together.
//
// The entry itself is written through services/journalOps.createEntry — the
// SAME sanitise/validate/create/audit pipeline the REST journal route uses,
// so the two surfaces cannot drift (one-impl rule, like bottleOps/rackOps).
const { z } = require('zod');
const { registerTool } = require('../registry');
const { updateBottleFields } = require('../../services/bottleOps');
const { createEntry, deleteEntry, OCCASIONS } = require('../../services/journalOps');
const { resolveRating } = require('../../utils/ratingUtils');
const { stripHtml } = require('../../utils/sanitize');
const { logAudit } = require('../../services/audit');
const { ok, fail, objectId, MSG_BOTTLE_NOT_FOUND, resolveBottleAccess } = require('../toolUtil');
const { logAction, replay } = require('../actionLedger');

registerTool({
  name: 'capture_tasting_note',
  title: 'Capture a tasting note',
  description:
    'Writes a tasting note for one of the user\'s bottles into their private journal — impressions, the dish it was ' +
    'drunk with, the occasion — and optionally records their rating on the bottle in the same step. Works for active ' +
    'bottles (Coravin pours, pre-drink impressions → sets the bottle rating) and consumed ones (verdict after ' +
    'drinking → sets the consumed rating). Confirm the wording and rating with the user first; one undo_last ' +
    'reverses note and rating together. For marking a bottle as drunk use consume_bottle instead.',
  scope: 'write',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  inputSchema: {
    bottle_id: objectId.describe('The bottle the note is about (from search_bottles / list_history)'),
    note: z.string().min(1).max(2000).describe('The tasting impressions, as the user phrased them'),
    rating: z.number().min(0).max(100).optional().describe('Optional rating to record on the bottle'),
    rating_scale: z.enum(['5', '20', '100']).optional().describe('Scale of `rating`; defaults to 5-star'),
    dish: z.string().max(200).optional().describe('What it was drunk with, if mentioned'),
    occasion: z.enum(OCCASIONS).optional().describe('Defaults to "tasting"'),
    date: z.string().optional().describe('ISO date of the tasting; defaults to now'),
    idempotency_key: z.string().max(100).optional(),
  },
  handler: async (args, ctx) => {
    const replayed = await replay(ctx, args.idempotency_key);
    if (replayed) return replayed;

    const access = await resolveBottleAccess(ctx.user.id, args.bottle_id, 'editor');
    if (!access) return fail('not_found', MSG_BOTTLE_NOT_FOUND);
    const { bottle } = access;

    let date = new Date();
    if (args.date !== undefined) {
      date = new Date(args.date);
      if (Number.isNaN(date.getTime())) return fail('invalid_input', 'date must be an ISO date, e.g. "2026-07-16".');
      if (date.getTime() > Date.now() + 86400000) return fail('invalid_input', 'date cannot be in the future.');
    }

    // Validate the rating BEFORE any write so a bad scale/value changes nothing.
    let ratingChange = null; // { field, prev: {...}, value, scale }
    if (args.rating !== undefined && args.rating !== null) {
      const r = resolveRating(args.rating, args.rating_scale);
      if (r.error) return fail('invalid_input', r.error);
      const consumed = bottle.status !== 'active';
      ratingChange = {
        field: consumed ? 'consumedRating' : 'rating',
        value: r.rating,
        scale: r.ratingScale,
        prev: consumed
          ? { consumedRating: bottle.consumedRating ?? null, consumedRatingScale: bottle.consumedRatingScale || null }
          : { rating: bottle.rating ?? null, ratingScale: bottle.ratingScale || null },
      };
    }

    const noteText = stripHtml(String(args.note)).slice(0, 2000).trim();
    if (!noteText) return fail('invalid_input', 'note is empty after sanitisation.');
    const dish = args.dish ? stripHtml(String(args.dish)).slice(0, 200).trim() : '';

    // 1. The journal entry — through the shared journalOps pipeline (private,
    //    no people; the service re-sanitises, re-validates the bottle ref and
    //    writes the journal.create audit row). Entry first: if it is rejected,
    //    nothing has been written yet.
    const created = await createEntry(ctx.user.id, {
      date,
      occasion: args.occasion || 'tasting',
      notes: noteText,
      pairings: [{ bottle: String(bottle._id), dish }],
      visibility: 'private',
    }, ctx.req, { auditMeta: { via: 'mcp', bottleId: String(bottle._id) } });
    if (created.error) return fail('invalid_input', created.error.message);
    const entry = created.entry;

    // 2. The rating (pre-validated above). If it still fails, compensate by
    //    removing the just-created entry — the tool's effects are all-or-nothing.
    if (ratingChange) {
      if (ratingChange.field === 'rating') {
        const result = await updateBottleFields(bottle, { rating: args.rating, ratingScale: args.rating_scale }, ctx.req);
        if (result.error) {
          await deleteEntry(ctx.user.id, entry._id, ctx.req, { auditMeta: { via: 'mcp', compensation: true } });
          return fail('invalid_input', `Could not set the rating: ${result.error.message} Nothing was saved.`);
        }
      } else {
        bottle.consumedRating = ratingChange.value;
        bottle.consumedRatingScale = ratingChange.scale;
        await bottle.save();
        logAudit(ctx.req, 'bottle.update', { type: 'bottle', id: bottle._id, cellarId: bottle.cellar }, { via: 'mcp', fields: ['consumedRating'] });
      }
    }

    const envelope = {
      summary: `Tasting note saved for vintage ${bottle.vintage}${ratingChange ? ` (rating ${ratingChange.value}/${ratingChange.scale})` : ''}`,
      data: {
        journal_id: entry._id,
        bottle_id: bottle._id,
        rating_recorded: ratingChange ? { field: ratingChange.field, value: ratingChange.value, scale: ratingChange.scale } : null,
        undo: 'undo_last removes the note and restores the previous rating',
      },
    };
    await logAction(ctx, {
      tool: 'capture_tasting_note',
      action: 'tasting_note',
      bottle: bottle._id,
      cellar: bottle.cellar,
      detail: { journalId: String(entry._id), dish: dish || null, rating_changed: !!ratingChange },
      prev: ratingChange ? { field: ratingChange.field, ...ratingChange.prev } : null,
      idempotencyKey: args.idempotency_key || null,
      result: envelope,
    });
    return ok(envelope.summary, envelope.data);
  },
});

module.exports = {};
