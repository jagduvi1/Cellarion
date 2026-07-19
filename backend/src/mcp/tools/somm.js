// Sommelier MCP tools (plan Phase-2 somm note, per Johan): queue listing +
// data entry for the SHARED recommendation data a somm curates. The killer
// workflow: "anything in my maturity queue?" → set the windows → next.
//
// Role gating is STRUCTURAL: every tool here declares requireRole, so the
// registry never even advertises them to non-somm callers (mcp/registry.js).
// A defense-in-depth role re-check runs inside each handler anyway — the two
// layers can only drift safely.
//
// Audit action strings are IDENTICAL to the REST somm routes (somm.maturity.
// review, somm.price.add) so REST and MCP curation audit identically.
const { z } = require('zod');
const WineVintageProfile = require('../../models/WineVintageProfile');
const WineVintagePrice = require('../../models/WineVintagePrice');
const PriceTrackingRequest = require('../../models/PriceTrackingRequest');
const WineDefinition = require('../../models/WineDefinition');
const { registerTool } = require('../registry');
const { logAudit } = require('../../services/audit');
const { SUPPORTED_CURRENCIES } = require('../../config/currencies');
const { isValidId } = require('../../utils/validation');
const { ok, fail, objectId, pageParams } = require('../toolUtil');
const { logAction } = require('../actionLedger');

const SOMM_ROLES = ['somm', 'admin'];
const PHASE_FIELDS = ['earlyFrom', 'earlyUntil', 'peakFrom', 'peakUntil', 'lateFrom', 'lateUntil'];
const PRICE_STALE_MS = 90 * 24 * 60 * 60 * 1000; // mirror routes/somm/prices.js

function requireSomm(ctx) {
  const roles = ctx.user?.roles || [];
  return SOMM_ROLES.some((r) => roles.includes(r))
    ? null
    : fail('forbidden_scope', 'This tool needs the sommelier (or admin) role.');
}

const wineLite = (wd) => (wd ? {
  wine_id: wd._id,
  name: wd.name,
  producer: wd.producer || null,
  type: wd.type || null,
  country: wd.country?.name || null,
  region: wd.region?.name || null,
} : null);

registerTool({
  name: 'list_maturity_queue',
  title: 'Sommelier: list the maturity queue',
  description:
    'Lists wine+vintage pairs awaiting drink-window review (every added bottle seeds one). Pending first, newest ' +
    'first. Call when the somm asks "anything in my maturity queue?" or before a review session. Use the returned ' +
    'profile_id with set_vintage_maturity.',
  scope: 'read',
  requireRole: SOMM_ROLES,
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    status: z.enum(['pending', 'reviewed', 'all']).default('pending'),
    limit: z.number().int().min(1).max(50).default(20),
    offset: z.number().int().min(0).default(0),
  },
  handler: async (args, ctx) => {
    const denied = requireSomm(ctx);
    if (denied) return denied;
    const { limit, offset } = pageParams(args, 20, 50);
    const status = args.status || 'pending';
    const filter = status === 'all' ? {} : { status };
    const [total, pending, profiles] = await Promise.all([
      WineVintageProfile.countDocuments(filter),
      WineVintageProfile.countDocuments({ status: 'pending' }),
      WineVintageProfile.find(filter)
        .sort({ status: 1, createdAt: -1 })
        .skip(offset).limit(limit)
        .populate({ path: 'wineDefinition', select: 'name producer type', populate: ['country', 'region'] })
        .lean(),
    ]);
    const data = profiles.map((p) => ({
      profile_id: p._id,
      wine: wineLite(p.wineDefinition),
      vintage: p.vintage,
      status: p.status,
      relative_nv: !!p.relative,
      phases: PHASE_FIELDS.reduce((acc, f) => ((acc[f] = p[f] ?? null), acc), {}),
      // Somm-gated tool, so the curator's own note comes back with the row.
      // Kept out of drink_window_for, which is public — see publicContent.js.
      somm_notes: p.sommNotes || null,
    }));
    return ok(`${pending} pending in the maturity queue (showing ${data.length} of ${total} ${status})`, data, {
      page: { limit, offset, total },
    });
  },
});

registerTool({
  name: 'set_vintage_maturity',
  title: 'Sommelier: set a vintage\'s drink-window phases',
  description:
    'Sets/records the drink-window (maturity) years for one wine+vintage: early/peak/late, each a from/until pair. ' +
    'Call whenever the somm wants to set, record, or update when a specific wine is drinkable — get the profile_id from ' +
    'list_maturity_queue, OR look the wine up with search_registry/get_wine when they name it directly (no need to open ' +
    'the queue first). Absolute years (1900–2200) — except NV vintages, which use RELATIVE year-offsets 0–100 from ' +
    'release. Ordering: each until ≥ its from; peak_from ≥ early_from; late_from ≥ peak_from. Marks the profile ' +
    'reviewed. This is SHARED data powering every user\'s recommendations — confirm the values with the somm first. ' +
    'Reversible via undo_last.',
  scope: 'write',
  requireRole: SOMM_ROLES,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: {
    profile_id: objectId.describe('From list_maturity_queue'),
    early_from: z.number().int().nullable().optional(),
    early_until: z.number().int().nullable().optional(),
    peak_from: z.number().int().nullable().optional(),
    peak_until: z.number().int().nullable().optional(),
    late_from: z.number().int().nullable().optional(),
    late_until: z.number().int().nullable().optional(),
    somm_notes: z.string().max(2000).optional(),
  },
  handler: async (args, ctx) => {
    const denied = requireSomm(ctx);
    if (denied) return denied;
    const profile = await WineVintageProfile.findById(args.profile_id).populate('wineDefinition', 'name producer');
    if (!profile) return fail('not_found', 'No such maturity profile. Use list_maturity_queue for valid ids.');

    // Mirror REST validation exactly: NV → relative offsets [0,100], else
    // absolute years [1900,2200] (routes/somm/maturity.js).
    const isNv = profile.vintage === 'NV';
    const [min, max] = isNv ? [0, 100] : [1900, 2200];
    const incoming = {
      earlyFrom: args.early_from, earlyUntil: args.early_until,
      peakFrom: args.peak_from, peakUntil: args.peak_until,
      lateFrom: args.late_from, lateUntil: args.late_until,
    };
    const next = {};
    for (const f of PHASE_FIELDS) {
      const v = incoming[f];
      if (v === undefined) { next[f] = profile[f] ?? null; continue; }
      if (v === null) { next[f] = null; continue; }
      if (v < min || v > max) {
        return fail('invalid_input', `${f}: ${v} out of range (${isNv ? 'NV uses relative offsets 0–100' : 'years 1900–2200'})`);
      }
      next[f] = v;
    }
    const pairs = [['earlyFrom', 'earlyUntil'], ['peakFrom', 'peakUntil'], ['lateFrom', 'lateUntil']];
    for (const [from, until] of pairs) {
      if (next[from] != null && next[until] != null && next[until] < next[from]) {
        return fail('invalid_input', `${until} cannot be before ${from}`);
      }
    }
    if (next.earlyFrom != null && next.peakFrom != null && next.peakFrom < next.earlyFrom) {
      return fail('invalid_input', 'peak_from cannot be before early_from');
    }
    if (next.peakFrom != null && next.lateFrom != null && next.lateFrom < next.peakFrom) {
      return fail('invalid_input', 'late_from cannot be before peak_from');
    }

    // Snapshot for undo: phases + notes + review state, restored verbatim.
    const prev = {
      ...PHASE_FIELDS.reduce((acc, f) => ((acc[f] = profile[f] ?? null), acc), {}),
      sommNotes: profile.sommNotes ?? null,
      status: profile.status,
      relative: profile.relative,
      setBy: profile.setBy ? String(profile.setBy) : null,
      setAt: profile.setAt || null,
    };

    for (const f of PHASE_FIELDS) profile[f] = next[f] === null ? undefined : next[f];
    if (args.somm_notes !== undefined) profile.sommNotes = args.somm_notes;
    profile.relative = isNv;
    profile.status = 'reviewed';
    profile.setBy = ctx.user.id;
    profile.setAt = new Date();
    await profile.save();

    logAudit(ctx.req, 'somm.maturity.review',
      { type: 'wine', id: profile.wineDefinition?._id || profile.wineDefinition },
      { vintage: profile.vintage, relative: isNv, via: 'mcp' });

    const envelope = {
      summary: `Maturity set for ${profile.wineDefinition?.name || 'wine'} ${profile.vintage} (reviewed)`,
      data: {
        profile_id: profile._id,
        vintage: profile.vintage,
        relative_nv: isNv,
        phases: next,
        somm_notes: profile.sommNotes || null,
        undo: 'undo_last restores the previous values and review state',
      },
    };
    await logAction(ctx, {
      tool: 'set_vintage_maturity',
      action: 'somm_maturity',
      detail: { profileId: String(profile._id), vintage: profile.vintage },
      prev,
      result: envelope,
    });
    return ok(envelope.summary, envelope.data);
  },
});

registerTool({
  name: 'list_price_tracking_requests',
  title: 'Sommelier: list the price-request queue',
  description:
    'Lists wine+vintage pairs users have asked to have price-tracked, where no price exists yet or the latest is ' +
    'older than 3 months. Most-requested first. Call when the somm asks "any price requests waiting?"; fulfil with ' +
    'set_vintage_price.',
  scope: 'read',
  requireRole: SOMM_ROLES,
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    limit: z.number().int().min(1).max(50).default(20),
  },
  handler: async (args, ctx) => {
    const denied = requireSomm(ctx);
    if (denied) return denied;
    const limit = Math.min(Math.max(parseInt(args.limit, 10) || 20, 1), 50);
    const requests = await PriceTrackingRequest.find({})
      .populate({ path: 'wineDefinition', select: 'name producer type', populate: ['country', 'region'] })
      .lean();
    const alive = requests.filter((r) => r.wineDefinition);

    // Actionable = no price yet, or latest snapshot stale (>90d) — mirrors
    // routes/somm/prices.js GET /queue.
    const latestByPair = new Map();
    if (alive.length) {
      const rows = await WineVintagePrice.aggregate([
        { $match: { wineDefinition: { $in: alive.map((r) => r.wineDefinition._id) } } },
        { $sort: { setAt: 1 } },
        { $group: { _id: { w: '$wineDefinition', v: '$vintage' }, price: { $last: '$price' }, currency: { $last: '$currency' }, setAt: { $last: '$setAt' } } },
      ]);
      for (const row of rows) latestByPair.set(`${row._id.w}:${row._id.v}`, row);
    }
    const now = Date.now();
    const actionable = alive
      .map((r) => ({ r, latest: latestByPair.get(`${r.wineDefinition._id}:${r.vintage}`) || null }))
      .filter(({ latest }) => !latest || now - new Date(latest.setAt).getTime() > PRICE_STALE_MS)
      .sort((a, b) => (b.r.requesters?.length || 0) - (a.r.requesters?.length || 0)
        || new Date(a.r.firstRequestedAt || 0) - new Date(b.r.firstRequestedAt || 0));

    const data = actionable.slice(0, limit).map(({ r, latest }) => ({
      request_id: r._id,
      wine: wineLite(r.wineDefinition),
      vintage: r.vintage,
      requester_count: r.requesters?.length || 0,
      first_requested_at: r.firstRequestedAt || null,
      latest_price: latest ? { price: latest.price, currency: latest.currency, set_at: latest.setAt } : null,
    }));
    return ok(`${actionable.length} actionable price request(s)${actionable.length > limit ? ` (showing ${limit})` : ''}`, data);
  },
});

registerTool({
  name: 'set_vintage_price',
  title: 'Sommelier: add a price valuation for a vintage',
  description:
    'Records a new price snapshot for one wine+vintage (price history accumulates — this never overwrites). ' +
    'Requesters are notified, and the pair leaves the price queue until the snapshot goes stale. This is SHARED ' +
    'valuation data — confirm price, currency and source with the somm first. Reversible via undo_last (removes the ' +
    'snapshot).',
  scope: 'write',
  requireRole: SOMM_ROLES,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  inputSchema: {
    wine_id: objectId,
    vintage: z.string().min(1).max(10),
    price: z.number().min(0),
    currency: z.string().regex(/^[A-Za-z]{3}$/).optional().describe('Default USD'),
    source: z.string().max(100).optional().describe('e.g. auction, retail, Systembolaget'),
    somm_notes: z.string().max(2000).optional(),
  },
  handler: async (args, ctx) => {
    const denied = requireSomm(ctx);
    if (denied) return denied;
    const currency = String(args.currency || 'USD').toUpperCase();
    if (!SUPPORTED_CURRENCIES.includes(currency)) {
      return fail('invalid_input', `Unsupported currency ${currency}. Supported: ${SUPPORTED_CURRENCIES.join(', ')}`);
    }
    if (!isValidId(args.wine_id)) return fail('invalid_input', 'wine_id must be a 24-hex id.');
    const wine = await WineDefinition.findById(args.wine_id).select('name producer');
    if (!wine) return fail('not_found', 'No registry wine with that id.');

    const entry = new WineVintagePrice({
      wineDefinition: wine._id,
      vintage: String(args.vintage).trim(),
      price: args.price,
      currency,
      source: args.source?.trim() || undefined,
      sommNotes: args.somm_notes?.trim() || undefined,
      setBy: ctx.user.id,
    });
    await entry.save();

    require('../../utils/exchangeRates').getOrCreateDailySnapshot().catch(() => {});
    // Notify requesters exactly like REST (best-effort).
    PriceTrackingRequest.findOne({ wineDefinition: wine._id, vintage: entry.vintage }).lean()
      .then((reqDoc) => {
        if (!reqDoc?.requesters?.length) return;
        const { createNotification } = require('../../services/notifications');
        for (const { user } of reqDoc.requesters) {
          createNotification(user, 'price_tracked', 'Price added',
            `${wine.name} ${entry.vintage}: ${entry.price} ${entry.currency}`,
            '/somm/prices', 'community').catch(() => {}); // link parity with REST
        }
      }).catch(() => {});

    logAudit(ctx.req, 'somm.price.add',
      { type: 'wine', id: wine._id },
      { vintage: entry.vintage, price: entry.price, currency: entry.currency, via: 'mcp' });

    const envelope = {
      summary: `Price recorded: ${wine.name} ${entry.vintage} = ${entry.price} ${entry.currency}`,
      data: {
        price_entry_id: entry._id,
        wine_id: wine._id,
        vintage: entry.vintage,
        price: entry.price,
        currency: entry.currency,
        undo: 'undo_last removes this snapshot',
      },
    };
    await logAction(ctx, {
      tool: 'set_vintage_price',
      action: 'somm_price',
      detail: { entryId: String(entry._id), wineId: String(wine._id), vintage: entry.vintage },
      result: envelope,
    });
    return ok(envelope.summary, envelope.data);
  },
});
