// Wishlist: list_wishlist reads; add_to_wishlist / update_wishlist_item /
// remove_from_wishlist write through services/wishlistOps, the same body as
// REST POST/PUT/DELETE /api/wishlist, so an assistant and the app keep one
// list. Not undoable through undo_last: an add is reversed by
// remove_from_wishlist, an update by another update, and a removal asks for
// confirm:true.
// Tasting journal: list_journal reads. PII rule for journal entries: tagged
// people are returned as the display NAMES the user typed — never linked user
// ids/accounts (mirrors redactPeople's intent in routes/journal.js).
const { z } = require('zod');
const WishlistItem = require('../../models/WishlistItem');
const JournalEntry = require('../../models/JournalEntry');
const { registerTool } = require('../registry');
const { ok, fail, objectId, pageParams } = require('../toolUtil');
const { findVisibleWine } = require('../../services/wineVisibility');
const { isValidId } = require('../../utils/validation');
const {
  parseNewItemFields, addWishlistItem, updateWishlistItem, removeWishlistItem,
  PRIORITIES, NOTES_MAX, VINTAGE_MAX,
} = require('../../services/wishlistOps');
const { resolveOrMintMcpWine } = require('../mintWine');
const { NEW_WINE_SHAPE } = require('./write');

// A foreign item is not_found here, as everywhere in MCP (never reveal that
// someone else's id exists); REST keeps its own 403.
const CODE = { 400: 'invalid_input', 403: 'not_found', 404: 'not_found', 409: 'conflict' };
const failFrom = (error) => fail(CODE[error.status] || 'error', error.message);

// One item as every wishlist tool returns it.
const wishlistItemOut = (it) => ({
  wishlist_id: it._id,
  wine: it.wineDefinition
    ? {
        wine_id: it.wineDefinition._id,
        name: it.wineDefinition.name,
        producer: it.wineDefinition.producer || null,
        type: it.wineDefinition.type || null,
        ...(it.wineDefinition.colour ? { colour: it.wineDefinition.colour } : {}),
        country: it.wineDefinition.country?.name || null,
        region: it.wineDefinition.region?.name || null,
      }
    : null,
  vintage: it.vintage || null,
  priority: it.priority,
  status: it.status,
  notes: it.notes || null,
  shop_url: it.shopUrl || null,
  added_at: it.createdAt,
});

registerTool({
  name: 'list_wishlist',
  title: 'List the wine wishlist',
  description:
    'The user\'s wishlist: wines they want to buy, with priority and status (wanted | bought). ' +
    'Call for "what am I looking for", purchase planning, or before suggesting wines they already wishlisted.',
  scope: 'read',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    status: z.enum(['wanted', 'bought', 'all']).default('wanted'),
    limit: z.number().int().min(1).max(50).default(30),
    offset: z.number().int().min(0).default(0),
  },
  handler: async (args, ctx) => {
    const { limit, offset } = pageParams(args, 30, 50);
    // Explicit default: zod fills it on the SDK path, but the handler must be
    // safe when called directly (tests, future internal reuse).
    const status = args.status || 'wanted';
    const filter = { user: ctx.user.id };
    if (status !== 'all') filter.status = status;
    const [total, items] = await Promise.all([
      WishlistItem.countDocuments(filter),
      WishlistItem.find(filter)
        .populate({ path: 'wineDefinition', select: 'name producer type colour', populate: ['country', 'region'] })
        .sort({ createdAt: -1 }).skip(offset).limit(limit).lean(),
    ]);
    const data = items.map(wishlistItemOut);
    return ok(`${data.length} of ${total} wishlist item(s)`, data, { page: { limit, offset, total } });
  },
});

// new_wine as add_bottle takes it, without the Other category: a wishlist is
// for wines (REST refuses a draft there too).
const WISH_WINE = z.object(NEW_WINE_SHAPE).omit({ category: true }).extend({
  type: NEW_WINE_SHAPE.type.describe('Required to create: a wine without its real type would mint a default-red registry entry'),
});
const SHOP_URL = z.string().max(2048).describe('https link to a shop page for the wine');

registerTool({
  name: 'add_to_wishlist',
  title: 'Add a wine to the wishlist',
  description:
    'Puts a wine the user wants to buy on their wishlist. Reference the wine by wine_id (from resolve_wine / ' +
    'search_registry) — or, only after resolve_wine returned no_match and the user confirmed the details, pass ' +
    'new_wine to add it to the registry (the same rules as add_bottle: producer kept out of the name; a wine without ' +
    'a producer is filed for sommelier completion). A wine the user read about on a web page is fine: take name, ' +
    'producer, country, type and grapes from the page, and pass the page as shop_url when it sells the wine. ' +
    'Confirm with the user first. One item per wine and vintage: the same wine and vintage still wanted is a conflict ' +
    'naming the existing wishlist_id. Reverse an add with remove_from_wishlist.',
  scope: 'write',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  inputSchema: {
    wine_id: z.string().optional().describe('Existing registry wine id (preferred — see resolve_wine)'),
    new_wine: WISH_WINE.optional().describe('Only after resolve_wine returned no_match'),
    confirm_new_wine: z.boolean().optional().describe('Set true to create despite close-but-unconfirmed candidates'),
    vintage: z.string().max(VINTAGE_MAX).optional().describe('e.g. "2019" or "NV"; leave out for any vintage'),
    priority: z.enum(PRIORITIES).optional().describe('Default medium'),
    notes: z.string().max(NOTES_MAX).optional(),
    shop_url: SHOP_URL.optional(),
  },
  handler: async (args, ctx) => {
    if (!args.wine_id && !args.new_wine) {
      return fail('invalid_input', 'Provide wine_id (preferred — call resolve_wine first) or new_wine.');
    }
    if (args.wine_id && args.new_wine) return fail('invalid_input', 'Provide wine_id OR new_wine, not both.');
    // Before any wine is created: a refused field after a mint would leave the
    // new registry wine without the item it was made for.
    const parsed = parseNewItemFields({
      vintage: args.vintage, notes: args.notes, priority: args.priority, shopUrl: args.shop_url,
    });
    if (parsed.error) return failFrom(parsed.error);

    let wine;
    let created = false;
    if (args.wine_id) {
      if (!isValidId(args.wine_id)) return fail('invalid_input', 'wine_id must be a 24-hex Mongo id.');
      // noDrafts: an item on an empty draft would be orphaned by its expiry (as on REST).
      wine = await findVisibleWine(args.wine_id, {
        userId: ctx.user.id, roles: ctx.user.roles, select: '_id name pendingIdentity', lean: true, noDrafts: true,
      });
      if (!wine) return fail('not_found', 'No registry wine with that id. Use resolve_wine or search_registry.');
    } else {
      const minted = await resolveOrMintMcpWine(ctx, args.new_wine, { confirm: args.confirm_new_wine });
      if (minted.failure) return minted.failure;
      wine = minted.wine;
      created = minted.created;
    }

    const added = await addWishlistItem({ req: ctx.req, via: 'mcp' }, wine._id, parsed.fields);
    if (added.error) {
      if (added.error.existingId) {
        return fail('conflict', `${wine.name}${parsed.fields.vintage ? ` ${parsed.fields.vintage}` : ''} is already on the wishlist (wishlist_id ${added.error.existingId}) — change it with update_wishlist_item.`);
      }
      return failFrom(added.error);
    }
    const pendingIdentity = wine.pendingIdentity === true;
    const item = wishlistItemOut(added.item);
    return ok(
      `Added ${wine.name}${item.vintage ? ` ${item.vintage}` : ''} to the wishlist` +
        (created ? (pendingIdentity ? ' (registry wine filed for sommelier completion — no producer)' : ' (new registry wine created)') : ''),
      {
        wishlist_item: item,
        wine_created: created,
        ...(pendingIdentity ? {
          wine_pending_identity: true,
          note: 'The wine could not be fully identified, so it is filed for sommelier completion: the item is on the wishlist, but the wine is invisible to other users until a curator finishes it.',
        } : {}),
        undo: 'remove_from_wishlist takes it off again if it was a mistake',
      }
    );
  },
});

registerTool({
  name: 'update_wishlist_item',
  title: 'Update a wishlist item (priority, bought, vintage, notes, shop link)',
  description:
    'Changes one item from list_wishlist. Only send the fields to change; null clears vintage, notes or shop_url. ' +
    'status "bought" marks it bought (it leaves the wanted list; add the bottle itself with add_bottle), "wanted" puts ' +
    'it back. Confirm the change with the user first.',
  scope: 'write',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: {
    wishlist_id: objectId.describe('From list_wishlist'),
    priority: z.enum(PRIORITIES).optional(),
    status: z.enum(['wanted', 'bought']).optional(),
    vintage: z.string().max(VINTAGE_MAX).nullable().optional(),
    notes: z.string().max(NOTES_MAX).nullable().optional(),
    shop_url: SHOP_URL.nullable().optional(),
  },
  handler: async (args, ctx) => {
    const patch = { priority: args.priority, status: args.status, vintage: args.vintage, notes: args.notes, shopUrl: args.shop_url };
    if (Object.values(patch).every((v) => v === undefined)) {
      return fail('invalid_input', 'Nothing to change: send at least one of priority, status, vintage, notes, shop_url.');
    }
    const updated = await updateWishlistItem({ req: ctx.req, via: 'mcp' }, args.wishlist_id, patch);
    if (updated.error) return failFrom(updated.error);
    const item = wishlistItemOut(updated.item);
    return ok(`Updated ${item.wine ? item.wine.name : 'the wishlist item'} on the wishlist`, item);
  },
});

registerTool({
  name: 'remove_from_wishlist',
  title: 'Remove a wine from the wishlist',
  description:
    'Takes one item off the wishlist for good (the registry wine and any bottles are not touched). To record that the ' +
    'user bought it, use update_wishlist_item status "bought" instead. Needs confirm:true after the user said yes.',
  scope: 'write',
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  inputSchema: {
    wishlist_id: objectId.describe('From list_wishlist'),
    confirm: z.boolean().optional(),
  },
  handler: async (args, ctx) => {
    if (args.confirm !== true) {
      return fail('invalid_input', 'remove_from_wishlist needs confirm:true — ask the user first. add_to_wishlist puts it back.');
    }
    const removed = await removeWishlistItem({ req: ctx.req, via: 'mcp' }, args.wishlist_id);
    if (removed.error) return failFrom(removed.error);
    return ok('Removed from the wishlist', { wishlist_id: args.wishlist_id, removed: true });
  },
});

registerTool({
  name: 'list_journal',
  title: 'List tasting-journal entries',
  description:
    'The user\'s tasting journal: dated entries with occasion, mood, dishes and the wines poured. Newest first. ' +
    'Call for "when did I last taste…", dinner recaps, or context before recommending a repeat pairing.',
  scope: 'read',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    limit: z.number().int().min(1).max(50).default(20),
    offset: z.number().int().min(0).default(0),
  },
  handler: async (args, ctx) => {
    const { limit, offset } = pageParams(args, 20, 50);
    const filter = { user: ctx.user.id };
    const [total, entries] = await Promise.all([
      JournalEntry.countDocuments(filter),
      JournalEntry.find(filter)
        .sort({ date: -1 }).skip(offset).limit(limit)
        .populate({ path: 'pairings.bottle', select: 'vintage wineDefinition', populate: { path: 'wineDefinition', select: 'name producer' } })
        .populate({ path: 'pairings.wine', select: 'name producer' })
        .lean(),
    ]);
    const data = entries.map((e) => ({
      journal_id: e._id,
      date: e.date,
      title: e.title || null,
      occasion: e.occasion || null,
      mood: e.mood ?? null,
      notes: e.notes || null,
      people: (e.people || []).map((p) => p.name).filter(Boolean),
      // A pairing stores a bottle and/or wine REFERENCE; wineName is only the
      // text fallback for the day a referenced bottle is gone. Hand the ids
      // and the producer back so a client can tell which "Sauvignon" this
      // was and follow the reference.
      pairings: (e.pairings || []).map((p) => {
        const wineDoc = p.bottle?.wineDefinition || p.wine || null;
        return {
          dish: p.dish || null,
          bottle_id: p.bottle?._id || null,
          wine_id: wineDoc?._id || null,
          producer: wineDoc?.producer || null,
          wine: wineDoc?.name || p.wineName || null,
          vintage: p.bottle?.vintage || p.vintage || null,
          notes: p.notes || null,
        };
      }),
    }));
    return ok(`${data.length} of ${total} journal entr(ies)`, data, { page: { limit, offset, total } });
  },
});
