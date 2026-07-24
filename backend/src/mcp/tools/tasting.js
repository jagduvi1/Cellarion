// capture_tasting_note (plan Phase 3) — the natural companion of drinking:
// ONE call writes a PRIVATE tasting-journal entry and optionally the bottle
// rating(s) in the same step. Two input forms, one journal entry either way:
//   bottle_id + note           — the classic single-bottle note
//   bottles: [{bottle_id, …}]  — several wines poured at ONE occasion (a
//                                dinner with six bottles is one entry with six
//                                pairings, never six copies of the same note)
// title / people / mood describe the occasion itself — the journal model
// always supported them; only this surface was narrower (support ticket).
// people is free-text NAMES ONLY: never linked to Cellarion accounts, and
// visibility is always private, so the mention-notification machinery in
// journalOps can never fire from a machine caller (the reason people-tagging
// was originally excluded here).
//
// One ledger row covers the entry AND every rating it set, so undo_last / the
// activity timeline revert the whole occasion together. Self-budgeted like
// bulk_add: one write slot per bottle (the multi form performs up to that
// many rating writes), charged only after all validation passes.
//
// The entry itself is written through services/journalOps.createEntry — the
// SAME sanitise/validate/create/audit pipeline the REST journal route uses,
// so the two surfaces cannot drift (one-impl rule, like bottleOps/rackOps).
const { z } = require('zod');
const { registerTool } = require('../registry');
const { updateBottleFields } = require('../../services/bottleOps');
const { createEntry, deleteEntry, OCCASIONS, MAX_PAIRINGS, MAX_PEOPLE } = require('../../services/journalOps');
const { resolveRating } = require('../../utils/ratingUtils');
const { stripHtml } = require('../../utils/sanitize');
const { logAudit } = require('../../services/audit');
const { ok, fail, objectId, MSG_BOTTLE_NOT_FOUND, resolveBottleAccess } = require('../toolUtil');
const { logAction, replay } = require('../actionLedger');
const { takeMutationSlot, ipKeyFor } = require('../mutationBudget');

const BOTTLE_ITEM = z.object({
  bottle_id: objectId.describe('The bottle poured (from search_bottles / list_history)'),
  dish: z.string().max(200).optional().describe('What THIS wine was drunk with, if mentioned'),
  notes: z.string().max(500).optional().describe('Impressions of THIS wine specifically'),
  rating: z.number().min(0).max(100).optional().describe('Optional rating to record on THIS bottle'),
  rating_scale: z.enum(['5', '20', '100']).optional().describe('Scale of this bottle\'s rating; defaults to 5-star'),
});

/** Apply one pre-validated rating change to its bottle. Returns { error? }. */
async function applyRatingChange(bottle, change, req) {
  if (change.field === 'rating') {
    // Pass the RESOLVED value+scale, not the raw args: resolveRating
    // defaulted a missing scale to '5' (what the envelope/ledger report),
    // while updateBottleFields would default it to the bottle's CURRENT
    // scale — "4" on a 100-scale bottle would store 4/100 yet report 4/5.
    return updateBottleFields(bottle, { rating: change.value, ratingScale: change.scale }, req);
  }
  bottle.consumedRating = change.value;
  bottle.consumedRatingScale = change.scale;
  await bottle.save();
  logAudit(req, 'bottle.update', { type: 'bottle', id: bottle._id, cellarId: bottle.cellar }, { via: 'mcp', fields: ['consumedRating'] });
  return {};
}

/** Best-effort restore of an applied change's previous values (compensation). */
async function rollbackRatingChange(bottle, change, req) {
  try {
    if (change.field === 'rating') {
      const result = await updateBottleFields(bottle, { rating: change.prev.rating, ratingScale: change.prev.ratingScale || undefined }, req);
      return !result.error;
    }
    bottle.consumedRating = change.prev.consumedRating ?? undefined;
    bottle.consumedRatingScale = change.prev.consumedRatingScale || undefined;
    await bottle.save();
    return true;
  } catch {
    return false;
  }
}

registerTool({
  name: 'capture_tasting_note',
  title: 'Capture a tasting note',
  description:
    'Writes a tasting note into the user\'s private journal and optionally records their rating(s) in the same step. ' +
    'Two forms: a single bottle (bottle_id + note — impressions, the dish, the occasion), or one shared occasion ' +
    '(bottles: every wine poured at one dinner/tasting → ONE journal entry with per-bottle dishes, notes and ratings ' +
    '— never one copy of the note per bottle). Optional title, people (first names only, never linked to accounts) ' +
    'and mood (1-5) describe the occasion. Works for active bottles (Coravin pours, pre-drink impressions → sets the ' +
    'bottle rating) and consumed ones (verdict after drinking → sets the consumed rating). Confirm the wording and ' +
    'ratings with the user first; one undo_last reverses the note and all ratings together. For marking a bottle as ' +
    'drunk use consume_bottle instead.',
  scope: 'write',
  // Charges the write budget ITSELF — one slot per bottle, after validation —
  // so the generic per-call charge in server.js must skip it (same contract
  // as bulk_add, MCP-audit M7: no double-count, no charge on replay/refusal).
  selfBudgeted: true,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  inputSchema: {
    bottle_id: objectId.optional().describe('Single-bottle form: the bottle the note is about (from search_bottles / list_history). Exactly one of bottle_id or bottles is required.'),
    bottles: z.array(BOTTLE_ITEM).min(1).max(MAX_PAIRINGS).optional().describe('Occasion form: every wine poured at ONE occasion — the whole evening becomes ONE journal entry. Exactly one of bottle_id or bottles is required.'),
    note: z.string().min(1).max(2000).optional().describe('The tasting impressions, as the user phrased them. Required with bottle_id; with bottles it is the shared note for the occasion (per-wine impressions go in bottles[].notes)'),
    rating: z.number().min(0).max(100).optional().describe('Optional rating to record on the bottle (single-bottle form only; use bottles[].rating otherwise)'),
    rating_scale: z.enum(['5', '20', '100']).optional().describe('Scale of `rating`; defaults to 5-star'),
    dish: z.string().max(200).optional().describe('What it was drunk with, if mentioned (single-bottle form only; use bottles[].dish otherwise)'),
    title: z.string().max(200).optional().describe('Optional title for the occasion, e.g. "Pizza night with the neighbours"'),
    people: z.array(z.string().min(1).max(100)).max(MAX_PEOPLE).optional().describe('Who was there — plain first names as the user said them; NEVER guessed, never linked to Cellarion accounts'),
    mood: z.number().int().min(1).max(5).optional().describe('How the occasion felt, 1 (poor) to 5 (great) — only when the user expressed it'),
    occasion: z.enum(OCCASIONS).optional().describe('Defaults to "tasting"'),
    date: z.string().optional().describe('ISO date of the tasting; defaults to now'),
    idempotency_key: z.string().max(100).optional(),
  },
  handler: async (args, ctx) => {
    const replayed = await replay(ctx, args.idempotency_key, 'capture_tasting_note');
    if (replayed) return replayed;

    const multi = Array.isArray(args.bottles);
    if (!multi && !args.bottle_id) {
      return fail('invalid_input', 'Provide bottle_id (one bottle) or bottles (every wine poured at one occasion → one entry).');
    }
    if (multi && args.bottle_id) {
      return fail('invalid_input', 'Provide either bottle_id or bottles, not both.');
    }
    if (multi && (args.rating !== undefined || args.rating_scale !== undefined || args.dish !== undefined)) {
      return fail('invalid_input', 'With bottles, put rating/rating_scale/dish inside each bottles[] item instead of top-level.');
    }
    if (!multi && args.note === undefined) {
      return fail('invalid_input', 'note is required with bottle_id.');
    }

    const items = multi
      ? args.bottles
      : [{ bottle_id: args.bottle_id, dish: args.dish, rating: args.rating, rating_scale: args.rating_scale }];
    if (new Set(items.map((i) => i.bottle_id.toLowerCase())).size !== items.length) {
      return fail('invalid_input', 'Each bottle can appear only once in bottles — merge duplicate lines into one item.');
    }

    let date = new Date();
    if (args.date !== undefined) {
      date = new Date(args.date);
      if (Number.isNaN(date.getTime())) return fail('invalid_input', 'date must be an ISO date, e.g. "2026-07-16".');
      if (date.getTime() > Date.now() + 86400000) return fail('invalid_input', 'date cannot be in the future.');
    }

    // Resolve access to EVERY bottle before any write — all-or-nothing.
    const resolved = [];
    for (const item of items) {
      const access = await resolveBottleAccess(ctx.user.id, item.bottle_id, 'editor');
      if (!access) {
        return fail('not_found', multi ? `Bottle ${item.bottle_id}: ${MSG_BOTTLE_NOT_FOUND}` : MSG_BOTTLE_NOT_FOUND);
      }
      resolved.push({ item, bottle: access.bottle, change: null });
    }

    // Validate ALL ratings BEFORE any write so a bad scale/value changes nothing.
    for (const r of resolved) {
      if (r.item.rating === undefined || r.item.rating === null) continue;
      const rr = resolveRating(r.item.rating, r.item.rating_scale);
      if (rr.error) return fail('invalid_input', multi ? `Bottle ${r.item.bottle_id}: ${rr.error}` : rr.error);
      const consumed = r.bottle.status !== 'active';
      r.change = {
        field: consumed ? 'consumedRating' : 'rating',
        value: rr.rating,
        scale: rr.ratingScale,
        prev: consumed
          ? { consumedRating: r.bottle.consumedRating ?? null, consumedRatingScale: r.bottle.consumedRatingScale || null }
          : { rating: r.bottle.rating ?? null, ratingScale: r.bottle.ratingScale || null },
      };
    }

    const noteText = args.note ? stripHtml(String(args.note)).slice(0, 2000).trim() : '';
    if (!multi && !noteText) return fail('invalid_input', 'note is empty after sanitisation.');
    const title = args.title ? stripHtml(String(args.title)).slice(0, 200).trim() : '';
    const people = (args.people || []).map((n) => stripHtml(String(n)).slice(0, 100).trim()).filter(Boolean);
    const pairings = resolved.map(({ item, bottle }) => ({
      bottle: String(bottle._id),
      dish: item.dish ? stripHtml(String(item.dish)).slice(0, 200).trim() : '',
      notes: item.notes ? stripHtml(String(item.notes)).slice(0, 500).trim() : '',
    }));
    if (multi && !noteText && !title && !pairings.some((p) => p.notes)) {
      return fail('invalid_input', 'Nothing to write: provide a shared note, a title, or per-bottle notes.');
    }

    // Whole occasion charged upfront, after validation: the single form costs
    // the same one slot the generic charge used to take; the occasion form
    // costs one per bottle. Replays and invalid input never reach this.
    if (!takeMutationSlot(String(ctx.user.id), items.length, ipKeyFor(ctx))) {
      return fail('rate_limited', `Not enough write budget left for ${items.length} bottle(s) this window — wait a few minutes, or log fewer bottles per call.`);
    }

    // 1. The journal entry — through the shared journalOps pipeline (private;
    //    people are plain names with user:null, so the mention-notification
    //    policy can never fire; the service re-sanitises, re-validates the
    //    bottle refs and writes the journal.create audit row). Entry first:
    //    if it is rejected, nothing has been written yet.
    const body = {
      date,
      occasion: args.occasion || 'tasting',
      notes: noteText,
      pairings,
      visibility: 'private',
    };
    if (title) body.title = title;
    if (people.length) body.people = people.map((name) => ({ name }));
    if (args.mood !== undefined) body.mood = args.mood;
    const created = await createEntry(ctx.user.id, body, ctx.req, {
      auditMeta: { via: 'mcp', ...(multi ? { bottleIds: pairings.map((p) => p.bottle) } : { bottleId: String(resolved[0].bottle._id) }) },
    });
    if (created.error) return fail('invalid_input', created.error.message);
    const entry = created.entry;

    // 2. The ratings (pre-validated above). All-or-nothing: a failure rolls
    //    back the already-applied ones and removes the just-created entry.
    //    THROWN failures (VersionError from a concurrent edit on the direct
    //    consumed-rating save, document deleted mid-flight) compensate exactly
    //    like returned ones — an escaping throw would strand the entry and the
    //    earlier ratings with no ledger row for undo, and the released
    //    idempotency claim would let a same-key retry double-write (audit
    //    2026-07-24 M1). Thrown = concurrency-shaped → `conflict`; returned =
    //    validation-shaped → `invalid_input`, as before.
    const applied = [];
    for (const r of resolved) {
      if (!r.change) continue;
      let result;
      try {
        result = await applyRatingChange(r.bottle, r.change, ctx.req);
      } catch (err) {
        result = { error: { thrown: true, message: err?.message || 'unexpected write failure.' } };
      }
      if (result.error) {
        let rollbackFailed = 0;
        for (const a of applied.reverse()) {
          if (!(await rollbackRatingChange(a.bottle, a.change, ctx.req))) rollbackFailed += 1;
        }
        await deleteEntry(ctx.user.id, entry._id, ctx.req, { auditMeta: { via: 'mcp', compensation: true } });
        return fail(result.error.thrown ? 'conflict' : 'invalid_input',
          `Could not set the rating${multi ? ` on bottle ${r.item.bottle_id}` : ''}: ${result.error.message} Nothing was saved.`
          + (rollbackFailed ? ` (${rollbackFailed} earlier rating(s) could not be rolled back — re-check them.)` : ''));
      }
      applied.push(r);
    }

    let envelope;
    if (!multi) {
      const { bottle, change } = resolved[0];
      envelope = {
        summary: `Tasting note saved for vintage ${bottle.vintage}${change ? ` (rating ${change.value}/${change.scale})` : ''}`,
        data: {
          journal_id: entry._id,
          bottle_id: bottle._id,
          rating_recorded: change ? { field: change.field, value: change.value, scale: change.scale } : null,
          undo: 'undo_last removes the note and restores the previous rating',
        },
      };
    } else {
      envelope = {
        summary: `Tasting note saved — ${items.length} wine(s) at one occasion${title ? ` ("${title}")` : ''}${applied.length ? `, ${applied.length} rating(s) recorded` : ''}`,
        data: {
          journal_id: entry._id,
          bottles: resolved.map(({ bottle, change }) => ({
            bottle_id: bottle._id,
            vintage: bottle.vintage,
            rating_recorded: change ? { field: change.field, value: change.value, scale: change.scale } : null,
          })),
          undo: 'undo_last removes the note and restores all previous ratings',
        },
      };
    }

    // One ledger row for the whole occasion. The single-bottle shape is kept
    // exactly as before (bottle/cellar/prev.field); occasion rows carry
    // detail.bottles + prev.ratings, which the reversal engine branches on.
    const cellarIds = new Set(resolved.map(({ bottle }) => String(bottle.cellar)));
    await logAction(ctx, {
      tool: 'capture_tasting_note',
      action: 'tasting_note',
      ...(multi
        ? {
          bottle: null,
          cellar: cellarIds.size === 1 ? resolved[0].bottle.cellar : null,
          detail: {
            journalId: String(entry._id),
            count: items.length,
            bottles: resolved.map(({ bottle, change }) => ({ bottle: String(bottle._id), rating_changed: !!change })),
          },
          prev: applied.length
            ? {
              ratings: resolved.filter((r) => r.change).map((r) => ({
                bottle: String(r.bottle._id),
                field: r.change.field,
                set: { value: r.change.value, scale: r.change.scale },
                ...r.change.prev,
              })),
            }
            : null,
        }
        : {
          bottle: resolved[0].bottle._id,
          cellar: resolved[0].bottle.cellar,
          detail: { journalId: String(entry._id), dish: pairings[0].dish || null, rating_changed: !!resolved[0].change },
          prev: resolved[0].change ? { field: resolved[0].change.field, ...resolved[0].change.prev } : null,
        }),
      idempotencyKey: args.idempotency_key || null,
      result: envelope,
    });
    return ok(envelope.summary, envelope.data);
  },
});

module.exports = {};
