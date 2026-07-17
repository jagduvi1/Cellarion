// Wine-list MCP tools (plan §3.13, Phase 7): the restaurant/sommelier menu
// feature over MCP. list_wine_lists / get_wine_list [read] +
// add_to_list / update_list_pricing [write].
//
// Wine lists are USER-OWNED documents (routes/wineLists.js is requireAuth
// only, no somm role) — so these are scope-gated personal tools, not
// role-gated like somm.js. Layout/branding/publishing stay in the app; the
// MCP slice is the curation workflow: "what's on my list?", "add the 2019
// Barolo at 95", "make the Riesling by-glass at 14".
//
// An entry lives in ONE of two containers depending on structureMode:
// custom → sections[].entries, auto → autoGroupEntries (the UI keeps the
// inactive container around when the user switches modes). Writes target the
// ACTIVE container; the pricing update searches both so a mode flip never
// strands an entry.
const { z } = require('zod');
const WineList = require('../../models/WineList');
const WineDefinition = require('../../models/WineDefinition');
const { registerTool } = require('../registry');
const { logAudit } = require('../../services/audit');
const { ok, fail, objectId, pageParams, wineSummary } = require('../toolUtil');
const { logAction, replay } = require('../actionLedger');

// Suggested glass price per the layout rule documented on the model:
// listPrice / glassesPerBottle × (1 + glassMarkup/100), rounded to the
// nearest glassRounding step. Null when there is no bottle price to derive from.
function suggestGlassPrice(layout, listPrice) {
  if (listPrice == null) return null;
  const per = (listPrice / (layout?.glassesPerBottle || 6)) * (1 + (layout?.glassMarkup || 0) / 100);
  const step = parseInt(layout?.glassRounding || '1', 10) || 1;
  return Math.round(per / step) * step;
}

// The active entry container for writes; [{ section, entries }] for reads.
function activeContainers(list) {
  if (list.structureMode === 'custom') {
    return list.sections.map((s) => ({ section: s.title, entries: s.entries }));
  }
  return [{ section: null, entries: list.autoGroupEntries }];
}

const entryKey = (e) => `${String(e.wine?._id || e.wine)}|${e.vintage || 'NV'}|${e.bottleSize || '750ml'}`;

function countEntries(list) {
  return list.structureMode === 'custom'
    ? (list.sections || []).reduce((n, s) => n + (s.entries?.length || 0), 0)
    : (list.autoGroupEntries || []).length;
}

const entryOut = (e) => ({
  wine: e.wine && typeof e.wine === 'object' && e.wine.name
    ? { wine_id: e.wine._id, name: e.wine.name, producer: e.wine.producer || null, type: e.wine.type || null }
    : { wine_id: e.wine },
  vintage: e.vintage || 'NV',
  bottle_size: e.bottleSize || '750ml',
  list_price: e.listPrice ?? null,
  by_glass: !!e.byGlass,
  glass_price: e.byGlass ? (e.glassPrice ?? null) : undefined,
});

// Find every entry for a wine across BOTH containers (see module comment).
// Returns [{ entry, section }].
function findEntries(list, wineId, { vintage, bottleSize } = {}) {
  const hits = [];
  const scan = (entries, section) => {
    for (const e of entries || []) {
      if (String(e.wine?._id || e.wine) !== String(wineId)) continue;
      if (vintage !== undefined && (e.vintage || 'NV') !== vintage) continue;
      if (bottleSize !== undefined && (e.bottleSize || '750ml') !== bottleSize) continue;
      hits.push({ entry: e, section });
    }
  };
  for (const s of list.sections || []) scan(s.entries, s.title);
  scan(list.autoGroupEntries, null);
  return hits;
}

registerTool({
  name: 'list_wine_lists',
  title: 'List my wine lists',
  description:
    'Lists the caller\'s wine lists (restaurant/menu lists built from cellar stock): name, cellar, entry count, ' +
    'published state, currency. Newest-updated first. Use the returned list_id with get_wine_list, add_to_list ' +
    'and update_list_pricing.',
  scope: 'read',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    limit: z.number().int().min(1).max(50).default(20),
    offset: z.number().int().min(0).default(0),
  },
  handler: async (args, ctx) => {
    const { limit, offset } = pageParams(args, 20, 50);
    const [total, lists] = await Promise.all([
      WineList.countDocuments({ user: ctx.user.id }),
      WineList.find({ user: ctx.user.id })
        .sort({ updatedAt: -1 }).skip(offset).limit(limit)
        .select('name cellar structureMode sections autoGroupEntries isPublished layout.currency updatedAt')
        .lean(),
    ]);
    const data = lists.map((l) => ({
      list_id: l._id,
      name: l.name,
      cellar_id: l.cellar,
      structure_mode: l.structureMode,
      entry_count: countEntries(l),
      is_published: !!l.isPublished,
      currency: l.layout?.currency || 'USD',
      updated_at: l.updatedAt,
    }));
    return ok(`${total} wine list(s)${data.length ? ` (showing ${data.length})` : ''}`, data, { page: { limit, offset, total } });
  },
});

registerTool({
  name: 'get_wine_list',
  title: 'Get a wine list with its entries',
  description:
    'One wine list in full: entries (wine, vintage, bottle size, bottle price, by-glass price) grouped by section ' +
    'in custom mode or as one flat group in auto mode, plus the glass-pricing rule and currency. Publishing, ' +
    'share links, branding and PDF layout are managed in the app, not over MCP.',
  scope: 'read',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: { list_id: objectId.describe('From list_wine_lists') },
  handler: async (args, ctx) => {
    const list = await WineList.findOne({ _id: args.list_id, user: ctx.user.id })
      .populate('sections.entries.wine', 'name producer type')
      .populate('autoGroupEntries.wine', 'name producer type')
      .lean();
    if (!list) return fail('not_found', 'No such wine list. Use list_wine_lists for valid ids.');
    const groups = activeContainers(list).map((c) => ({
      section: c.section,
      entries: (c.entries || []).map(entryOut),
    }));
    const data = {
      list_id: list._id,
      name: list.name,
      cellar_id: list.cellar,
      structure_mode: list.structureMode,
      is_published: !!list.isPublished,
      currency: list.layout?.currency || 'USD',
      glass_pricing_rule: {
        glasses_per_bottle: list.layout?.glassesPerBottle ?? 6,
        markup_percent: list.layout?.glassMarkup ?? 0,
        rounding: list.layout?.glassRounding || '1',
      },
      sections: groups,
    };
    return ok(`"${list.name}" — ${countEntries(list)} entries in ${groups.length} section(s)`, data);
  },
});

registerTool({
  name: 'add_to_list',
  title: 'Add a wine to a wine list',
  description:
    'Adds one wine (by wine_id from search_bottles/search_registry results) to a wine list at a bottle price. In a ' +
    'custom-structured list, name the section (created if new; omit it when the list has exactly one). by_glass with ' +
    'no glass_price derives the suggested glass price from the list\'s pricing rule. Duplicate wine+vintage+size on ' +
    'the list → use update_list_pricing instead. Reversible via undo_last. Pass an idempotency_key when retrying.',
  scope: 'write',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  inputSchema: {
    list_id: objectId.describe('From list_wine_lists'),
    wine_id: objectId.describe('Registry wine id'),
    vintage: z.string().max(20).default('NV'),
    bottle_size: z.string().max(20).default('750ml'),
    list_price: z.number().min(0).optional(),
    by_glass: z.boolean().default(false),
    glass_price: z.number().min(0).optional(),
    section: z.string().max(200).optional().describe('Custom-mode section title (created if new)'),
    idempotency_key: z.string().max(100).optional(),
  },
  handler: async (args, ctx) => {
    const replayed = await replay(ctx, args.idempotency_key);
    if (replayed) return replayed;

    const [list, wine] = await Promise.all([
      WineList.findOne({ _id: args.list_id, user: ctx.user.id }),
      WineDefinition.findById(args.wine_id).populate('country region'),
    ]);
    if (!list) return fail('not_found', 'No such wine list. Use list_wine_lists for valid ids.');
    if (!wine) return fail('not_found', 'No such registry wine. Find the wine_id via search_registry or a bottle\'s wine.');

    const vintage = args.vintage || 'NV';
    const bottleSize = args.bottle_size || '750ml';
    const dupes = findEntries(list, wine._id, { vintage, bottleSize });
    if (dupes.length) {
      return fail('conflict', `${wine.name} ${vintage} (${bottleSize}) is already on "${list.name}"${dupes[0].section ? ` in section "${dupes[0].section}"` : ''} — use update_list_pricing to change its prices.`);
    }

    // Resolve the target container (see module comment).
    let container;
    let sectionTitle = null;
    if (list.structureMode === 'custom') {
      const wanted = (args.section || '').trim();
      if (!wanted) {
        if (list.sections.length === 1) {
          container = list.sections[0].entries;
          sectionTitle = list.sections[0].title;
        } else {
          const titles = list.sections.map((s) => `"${s.title}"`).join(', ') || '(none yet — pass any section name to create it)';
          return fail('invalid_input', `This list uses custom sections — pass section. Existing: ${titles}.`);
        }
      } else {
        let sec = list.sections.find((s) => s.title.toLowerCase() === wanted.toLowerCase());
        if (!sec) {
          list.sections.push({ title: wanted, sortOrder: list.sections.length, entries: [] });
          sec = list.sections[list.sections.length - 1];
        }
        container = sec.entries;
        sectionTitle = sec.title;
      }
    } else {
      container = list.autoGroupEntries;
    }

    const glassGiven = args.glass_price != null;
    const glassPrice = args.by_glass
      ? (glassGiven ? args.glass_price : suggestGlassPrice(list.layout, args.list_price))
      : undefined;
    container.push({
      wine: wine._id,
      vintage,
      bottleSize,
      listPrice: args.list_price,
      byGlass: !!args.by_glass,
      glassPrice: glassPrice ?? undefined,
      glassPriceManual: args.by_glass ? glassGiven : false,
      sortOrder: container.length,
    });

    try {
      await list.save();
    } catch (err) {
      if (err?.name === 'VersionError') return fail('conflict', 'The list changed while adding — re-read it with get_wine_list and retry.');
      if (err?.name === 'ValidationError') return fail('invalid_input', err.message);
      throw err;
    }

    logAudit(ctx.req, 'winelist.entry.add', { wineList: list._id }, { wine: String(wine._id), vintage, via: 'mcp' });
    const currency = list.layout?.currency || 'USD';
    const priceBits = [
      args.list_price != null ? `${args.list_price} ${currency}` : 'no bottle price',
      args.by_glass ? `by glass ${glassPrice != null ? `${glassPrice} ${currency}` : ''}${!glassGiven && glassPrice != null ? ' (suggested)' : ''}`.trim() : null,
    ].filter(Boolean).join(', ');
    const envelope = {
      summary: `Added ${wine.name} ${vintage} to "${list.name}"${sectionTitle ? ` (${sectionTitle})` : ''} — ${priceBits}`,
      data: {
        list_id: list._id,
        section: sectionTitle,
        wine: wineSummary(wine),
        vintage,
        bottle_size: bottleSize,
        list_price: args.list_price ?? null,
        by_glass: !!args.by_glass,
        glass_price: args.by_glass ? (glassPrice ?? null) : undefined,
        glass_price_suggested: args.by_glass && !glassGiven && glassPrice != null ? true : undefined,
      },
    };
    await logAction(ctx, {
      tool: 'add_to_list',
      action: 'winelist_add',
      cellar: list.cellar,
      detail: { listId: String(list._id), listName: list.name, wineId: String(wine._id), vintage, bottleSize, section: sectionTitle },
      result: envelope,
      idempotencyKey: args.idempotency_key || null,
    });
    return ok(envelope.summary, envelope.data);
  },
});

registerTool({
  name: 'update_list_pricing',
  title: 'Update a wine-list entry\'s pricing',
  description:
    'Changes the bottle price and/or by-glass availability+price of one existing wine-list entry. Identify the entry ' +
    'by list_id + wine_id (add vintage / bottle_size only if the wine appears more than once). Setting by_glass ' +
    'without glass_price derives the suggested glass price from the list\'s rule; glass_price null clears the manual ' +
    'override. Reversible via undo_last.',
  scope: 'write',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: {
    list_id: objectId.describe('From list_wine_lists'),
    wine_id: objectId,
    vintage: z.string().max(20).optional(),
    bottle_size: z.string().max(20).optional(),
    list_price: z.number().min(0).nullable().optional(),
    by_glass: z.boolean().optional(),
    glass_price: z.number().min(0).nullable().optional(),
    idempotency_key: z.string().max(100).optional(),
  },
  handler: async (args, ctx) => {
    if (args.list_price === undefined && args.by_glass === undefined && args.glass_price === undefined) {
      return fail('invalid_input', 'Nothing to change — pass list_price, by_glass and/or glass_price.');
    }
    const replayed = await replay(ctx, args.idempotency_key);
    if (replayed) return replayed;

    const list = await WineList.findOne({ _id: args.list_id, user: ctx.user.id });
    if (!list) return fail('not_found', 'No such wine list. Use list_wine_lists for valid ids.');

    const hits = findEntries(list, args.wine_id, {
      ...(args.vintage !== undefined ? { vintage: args.vintage } : {}),
      ...(args.bottle_size !== undefined ? { bottleSize: args.bottle_size } : {}),
    });
    if (!hits.length) return fail('not_found', 'That wine is not on this list. See get_wine_list; add it with add_to_list.');
    if (hits.length > 1) {
      const variants = hits.map((h) => `${h.entry.vintage || 'NV'} ${h.entry.bottleSize || '750ml'}${h.section ? ` (${h.section})` : ''}`).join('; ');
      return fail('invalid_input', `That wine appears ${hits.length} times on the list — disambiguate with vintage/bottle_size. Variants: ${variants}.`);
    }

    const { entry, section } = hits[0];
    const prev = {
      listPrice: entry.listPrice ?? null,
      byGlass: !!entry.byGlass,
      glassPrice: entry.glassPrice ?? null,
      glassPriceManual: !!entry.glassPriceManual,
    };

    if (args.list_price !== undefined) entry.listPrice = args.list_price === null ? undefined : args.list_price;
    if (args.by_glass !== undefined) entry.byGlass = args.by_glass;
    if (args.glass_price !== undefined) {
      entry.glassPrice = args.glass_price === null ? undefined : args.glass_price;
      entry.glassPriceManual = args.glass_price !== null;
    }
    // Turning by-glass on (or clearing the manual price) with no explicit
    // price → derive the suggestion from the current bottle price.
    if (entry.byGlass && entry.glassPrice == null) {
      const suggested = suggestGlassPrice(list.layout, entry.listPrice);
      if (suggested != null) { entry.glassPrice = suggested; entry.glassPriceManual = false; }
    }

    try {
      await list.save();
    } catch (err) {
      if (err?.name === 'VersionError') return fail('conflict', 'The list changed while updating — re-read it with get_wine_list and retry.');
      if (err?.name === 'ValidationError') return fail('invalid_input', err.message);
      throw err;
    }

    logAudit(ctx.req, 'winelist.entry.update', { wineList: list._id }, { wine: String(args.wine_id), via: 'mcp' });
    const currency = list.layout?.currency || 'USD';
    const envelope = {
      summary: `Updated pricing on "${list.name}" — bottle ${entry.listPrice ?? '—'} ${currency}${entry.byGlass ? `, glass ${entry.glassPrice ?? '—'} ${currency}` : ', not by glass'}`,
      data: {
        list_id: list._id,
        section,
        wine_id: String(args.wine_id),
        vintage: entry.vintage || 'NV',
        bottle_size: entry.bottleSize || '750ml',
        list_price: entry.listPrice ?? null,
        by_glass: !!entry.byGlass,
        glass_price: entry.byGlass ? (entry.glassPrice ?? null) : undefined,
      },
    };
    await logAction(ctx, {
      tool: 'update_list_pricing',
      action: 'winelist_price',
      cellar: list.cellar,
      detail: {
        listId: String(list._id), listName: list.name,
        wineId: String(args.wine_id), vintage: entry.vintage || 'NV', bottleSize: entry.bottleSize || '750ml',
      },
      prev,
      result: envelope,
      idempotencyKey: args.idempotency_key || null,
    });
    return ok(envelope.summary, envelope.data);
  },
});

module.exports = {};
