// Wishlist + tasting-journal reads. PII rule for journal entries: tagged
// people are returned as the display NAMES the user typed — never linked user
// ids/accounts (mirrors redactPeople's intent in routes/journal.js).
const { z } = require('zod');
const WishlistItem = require('../../models/WishlistItem');
const JournalEntry = require('../../models/JournalEntry');
const { registerTool } = require('../registry');
const { ok, pageParams } = require('../toolUtil');

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
        .populate({ path: 'wineDefinition', select: 'name producer type', populate: ['country', 'region'] })
        .sort({ createdAt: -1 }).skip(offset).limit(limit).lean(),
    ]);
    const data = items.map((it) => ({
      wishlist_id: it._id,
      wine: it.wineDefinition
        ? {
            wine_id: it.wineDefinition._id,
            name: it.wineDefinition.name,
            producer: it.wineDefinition.producer || null,
            type: it.wineDefinition.type || null,
            country: it.wineDefinition.country?.name || null,
            region: it.wineDefinition.region?.name || null,
          }
        : null,
      vintage: it.vintage || null,
      priority: it.priority,
      status: it.status,
      notes: it.notes || null,
      added_at: it.createdAt,
    }));
    return ok(`${data.length} of ${total} wishlist item(s)`, data, { page: { limit, offset, total } });
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
      pairings: (e.pairings || []).map((p) => ({
        dish: p.dish || null,
        wine:
          p.bottle?.wineDefinition?.name ||
          p.wine?.name ||
          p.wineName || null,
        vintage: p.bottle?.vintage || null,
        notes: p.notes || null,
      })),
    }));
    return ok(`${data.length} of ${total} journal entr(ies)`, data, { page: { limit, offset, total } });
  },
});
