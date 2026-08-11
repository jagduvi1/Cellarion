// Registry-safe write tools (plan §5.1 — the two-step resolve→add contract):
// resolve_wine [read] / add_bottle [write] / update_bottle [write].
//
// Registry integrity is the design center here. add_bottle can only reference
// an EXISTING registry wine (wine_id) or go through findOrCreateWine — the
// same #674-hardened chokepoint every other surface uses (producer-in-name
// strip, sibling match, fuzzy scoring, soft-zone). MCP is deliberately
// STRICTER than REST: sibling matching stays ON even for confirmed creates,
// and every wine minted here is stamped createdVia:'mcp' + audited
// (wine.create), so admins can review AI-created wines as a class.
//
// AI cost: creating a bottle fires the same fire-and-forget embed/enrich calls
// as the web app, which carry their own kill-switch + per-user budget gates —
// an MCP add costs exactly what a UI add costs, and dedup means a known wine
// costs nothing.
const { z } = require('zod');
const WineDefinition = require('../../models/WineDefinition');
const { registerTool } = require('../registry');
// findOrCreateWine is required LAZILY inside handlers: it top-requires
// services/search → the ESM-only meilisearch package, which jest cannot parse
// — a top-level require here would break every suite that loads the tool
// registry (the #702 failure mode).
const { addBottle, updateBottleFields } = require('../../services/bottleOps');
const { logAudit } = require('../../services/audit');
const { isValidId } = require('../../utils/validation');
const { decorateGrapes } = require('../../utils/grapeDisplay');
const {
  ok, fail, objectId, MSG_CELLAR_NOT_FOUND, MSG_BOTTLE_NOT_FOUND,
  resolveCellarAccess, resolveBottleAccess, wineSummary,
} = require('../toolUtil');
const { logAction, replay, releaseClaim } = require('../actionLedger');

const NEW_WINE_SHAPE = {
  name: z.string().trim().min(1).max(200).describe('Wine name WITHOUT the producer in it (e.g. "Sauvignon Blanc", not "Cloudy Bay Sauvignon Blanc")'),
  producer: z.string().trim().min(1).max(200),
  country: z.string().trim().min(1).max(200).describe('Country name (required to create)'),
  region: z.string().max(200).optional(),
  appellation: z.string().max(200).optional(),
  type: z.enum(['red', 'white', 'rosé', 'sparkling', 'dessert', 'fortified']).describe('Required: creating without the real type would mint a default-red registry entry'),
  grapes: z.array(z.string().max(200)).max(10).optional(),
};

registerTool({
  name: 'resolve_wine',
  title: 'Resolve a wine against the shared registry (STEP 1 of adding)',
  description:
    'ALWAYS call this before add_bottle with a new wine. Checks the shared registry for the wine using the same ' +
    'dedup pipeline as every other surface (producer-prefix stripping, sibling match, fuzzy scoring). Returns either ' +
    'the matched existing wine (use its wine_id), close candidates to choose from, or no_match (then confirm the ' +
    'details with the user and call add_bottle with new_wine). Pure lookup — never creates anything.',
  scope: 'read',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    name: z.string().min(1).max(200),
    producer: z.string().min(1).max(200),
    appellation: z.string().max(200).optional(),
  },
  handler: async (args, ctx) => {
    const { findOrCreateWine } = require('../../services/findOrCreateWine');
    const result = await findOrCreateWine(
      { name: args.name, producer: args.producer, appellation: args.appellation },
      ctx.user.id,
      { matchOnly: true }
    );
    // decorateGrapes: matched/candidate wines show the regionally correct
    // grape label for their own place ("Tinta Roriz" on a Douro Port) — the
    // registry keeps referencing the canonical Grape doc.
    if (result.wine) {
      return ok(`Matched existing registry wine: ${result.wine.name}`, {
        matched: { ...wineSummary(decorateGrapes(result.wine)) },
        guidance: 'Use this wine_id in add_bottle. Do not create a new wine.',
      });
    }
    if (result.candidates?.length) {
      return ok(`${result.candidates.length} close candidate(s) — none certain`, {
        candidates: result.candidates.map((c) => ({ ...wineSummary(decorateGrapes(c.wine)), score: c.score })),
        guidance: 'If one of these IS the wine, use its wine_id in add_bottle. Only if none match, call add_bottle with new_wine and confirm_new_wine:true.',
      });
    }
    return ok('No registry match', {
      no_match: true,
      guidance: 'Confirm name/producer/country with the user, then call add_bottle with new_wine. Keep the producer OUT of the name field.',
    });
  },
});

registerTool({
  name: 'add_bottle',
  title: 'Add a bottle to a cellar (STEP 2)',
  description:
    'Adds one bottle to a cellar the user owns or edits. Reference the wine by wine_id (from resolve_wine / ' +
    'search_registry / an existing bottle) — or, only after resolve_wine returned no_match and the user confirmed the ' +
    'details, pass new_wine to mint a registry entry. ALWAYS confirm with the user before adding (name, vintage, ' +
    'cellar). The bottle arrives UNPLACED (rack placement is a separate step in the web app for now). Reversible via ' +
    'undo_last. Pass an idempotency_key when retrying.',
  scope: 'write',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  inputSchema: {
    cellar_id: objectId,
    wine_id: z.string().optional().describe('Existing registry wine id (preferred — see resolve_wine)'),
    new_wine: z.object(NEW_WINE_SHAPE).optional().describe('Only after resolve_wine returned no_match'),
    confirm_new_wine: z.boolean().optional().describe('Set true to create despite close-but-unconfirmed candidates'),
    vintage: z.string().max(10).optional().describe('e.g. "2019" or "NV"'),
    price: z.number().min(0).optional(),
    currency: z.string().regex(/^[A-Za-z]{3}$/).optional(),
    purchase_location: z.string().max(500).optional(),
    notes: z.string().max(5000).optional(),
    occasion: z.string().max(500).optional(),
    rating: z.number().min(0).max(100).optional(),
    rating_scale: z.enum(['5', '20', '100']).optional(),
    drink_from: z.number().int().optional(),
    drink_to: z.number().int().optional(),
    idempotency_key: z.string().max(100).optional(),
  },
  handler: async (args, ctx) => {
    const replayed = await replay(ctx, args.idempotency_key, 'add_bottle');
    if (replayed) return replayed;

    if (!args.wine_id && !args.new_wine) {
      return fail('invalid_input', 'Provide wine_id (preferred — call resolve_wine first) or new_wine.');
    }
    if (args.wine_id && args.new_wine) {
      return fail('invalid_input', 'Provide wine_id OR new_wine, not both.');
    }

    const access = await resolveCellarAccess(ctx.user.id, args.cellar_id, 'editor');
    if (!access) return fail('not_found', MSG_CELLAR_NOT_FOUND);

    // Resolve the registry wine.
    let wineDoc;
    let wineCreated = false;
    if (args.wine_id) {
      if (!isValidId(args.wine_id)) return fail('invalid_input', 'wine_id must be a 24-hex Mongo id.');
      wineDoc = await WineDefinition.findById(args.wine_id).populate(['country', 'region', 'grapes']);
      if (!wineDoc) return fail('not_found', 'No registry wine with that id. Use resolve_wine or search_registry.');
    } else {
      const { findOrCreateWine } = require('../../services/findOrCreateWine');
      let result;
      try {
        // Sibling matching stays ON even when confirmed — stricter than REST,
        // deliberately: an exact producer+name sibling IS the same wine.
        result = await findOrCreateWine(args.new_wine, ctx.user.id, {
          confirmCreate: !!args.confirm_new_wine,
          skipSiblingMatch: false,
          createdVia: 'mcp',
        });
      } catch (err) {
        if (err?.status === 400) return fail('invalid_input', err.message);
        throw err;
      }
      if (!result.wine && result.candidates?.length) {
        return fail('conflict',
          'Very similar wines already exist — use one of these wine_ids, or call again with confirm_new_wine:true ONLY if the user confirms it is genuinely different: ' +
          result.candidates.map((c) => `${c.wine.name} — ${c.wine.producer} (wine_id ${c.wine._id}, score ${c.score})`).join('; '));
      }
      wineDoc = result.wine;
      wineCreated = !!result.created;
      if (wineCreated) {
        logAudit(ctx.req, 'wine.create',
          { type: 'wine', id: wineDoc._id },
          { via: 'mcp', name: wineDoc.name, producer: wineDoc.producer });
      }
    }

    const result = await addBottle(access.cellar, wineDoc, {
      vintage: args.vintage,
      price: args.price,
      currency: args.currency,
      purchaseLocation: args.purchase_location,
      notes: args.notes,
      occasion: args.occasion,
      rating: args.rating,
      ratingScale: args.rating_scale,
      drinkFrom: args.drink_from,
      drinkTo: args.drink_to,
    }, ctx.req);
    if (result.error) return fail('invalid_input', result.error.message);
    const { bottle } = result;

    const envelope = {
      summary: `Added ${wineDoc.name} ${bottle.vintage} to "${access.cellar.name}"${wineCreated ? ' (new registry wine created)' : ''}`,
      data: {
        bottle_id: bottle._id,
        wine: { ...wineSummary(wineDoc) },
        wine_created: wineCreated,
        vintage: bottle.vintage,
        cellar_id: access.cellar._id,
        placement: null,
        undo: 'undo_last removes this bottle again if it was a mistake',
      },
    };
    await logAction(ctx, {
      tool: 'add_bottle',
      action: 'add',
      bottle: bottle._id,
      cellar: access.cellar._id,
      detail: { wine: String(wineDoc._id), wine_created: wineCreated, vintage: bottle.vintage },
      idempotencyKey: args.idempotency_key || null,
      result: envelope,
    });
    return ok(envelope.summary, envelope.data);
  },
});

// The AI-useful subset of the shared service's UPDATABLE_FIELDS — the web
// edit form covers the rest (vintage, bottle size, purchase metadata). Named
// here, next to the inputSchema it must mirror, so description and schema
// can't drift apart.
const MCP_UPDATE_PARAMS = ['price', 'currency', 'notes', 'occasion', 'rating', 'rating_scale', 'drink_from', 'drink_to', 'reserved_for', 'reserved_until'];

registerTool({
  name: 'update_bottle',
  title: 'Update a bottle (price, notes, rating, drink window, occasion, reservation)',
  description:
    `Partially updates one bottle. Updatable: ${MCP_UPDATE_PARAMS.join(', ')}. Only send the ` +
    'fields to change; confirm the change with the user first. Set reserved_for and/or reserved_until (a year) to ' +
    'mark the bottle reserved ("spoken for" — excluded from drink suggestions); send null for both to clear the ' +
    'reservation. Reversible via undo_last.',
  scope: 'write',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  inputSchema: {
    bottle_id: objectId,
    price: z.number().min(0).optional(),
    currency: z.string().regex(/^[A-Za-z]{3}$/).optional(),
    notes: z.string().max(5000).optional(),
    occasion: z.string().max(500).optional(),
    rating: z.number().min(0).max(100).optional(),
    rating_scale: z.enum(['5', '20', '100']).optional(),
    drink_from: z.number().int().nullable().optional(),
    drink_to: z.number().int().nullable().optional(),
    reserved_for: z.string().max(200).nullable().optional().describe('Who/what the bottle is held for (null clears)'),
    reserved_until: z.number().int().nullable().optional().describe('Year the reservation runs to, e.g. 2034 (null clears)'),
    idempotency_key: z.string().max(100).optional(),
  },
  handler: async (args, ctx) => {
    const replayed = await replay(ctx, args.idempotency_key, 'update_bottle');
    if (replayed) return replayed;

    const access = await resolveBottleAccess(ctx.user.id, args.bottle_id, 'editor');
    if (!access) return fail('not_found', MSG_BOTTLE_NOT_FOUND);
    const { bottle } = access;

    const result = await updateBottleFields(bottle, {
      price: args.price,
      currency: args.currency,
      notes: args.notes,
      occasion: args.occasion,
      rating: args.rating,
      ratingScale: args.rating_scale,
      drinkFrom: args.drink_from,
      drinkTo: args.drink_to,
      reservedFor: args.reserved_for,
      reservedUntil: args.reserved_until,
    }, ctx.req);
    if (result.error) return fail('invalid_input', result.error.message);

    if (Object.keys(result.changes).length === 0) {
      // No mutation → logAction never runs, so the claim replay() took above
      // would stay pending and turn every same-key retry into a bogus `busy`
      // for CLAIM_STALE_MS (audit 2026-07-24 M11). Release it: a retry simply
      // re-runs and no-ops again.
      await releaseClaim(ctx, args.idempotency_key, 'update_bottle');
      return ok('No changes — every value already matched', { bottle_id: bottle._id, changes: {} });
    }
    const envelope = {
      summary: `Updated bottle ${bottle._id}: ${Object.keys(result.changes).join(', ')}`,
      data: {
        bottle_id: bottle._id,
        changes: result.changes,
        undo: 'undo_last restores the previous values',
      },
    };
    await logAction(ctx, {
      tool: 'update_bottle',
      action: 'update',
      bottle: bottle._id,
      cellar: bottle.cellar,
      detail: { changed: Object.keys(result.changes) },
      prev: result.prev,
      idempotencyKey: args.idempotency_key || null,
      result: envelope,
    });
    return ok(envelope.summary, envelope.data);
  },
});

// Shared with tools/bulk.js so batch items validate identically to singles.
module.exports = { NEW_WINE_SHAPE };
