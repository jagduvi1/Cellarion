// Self-service account tools (plan §3.18): the settings, profile, support and
// wine-request surfaces the web app's Settings page exposes — so a user running
// their cellar entirely through an AI never has to open the site for the small
// stuff. All validation and writes delegate to services/accountOps, the same
// implementation the REST routes use (no drift between UI and MCP).
//
// The two update_* tools and the two create_* tools are `write`-scoped and ride
// the per-user mutation budget (readOnlyHint:false). Settings/profile changes
// are cosmetic and idempotent — deliberately ledger-less, like
// mark_notification_read: nothing about the CELLAR changes, and each response
// echoes the resulting state so the user (or the AI) can set it back. The two
// creates (support ticket, wine request) are one-way submissions to a human
// queue, so there is nothing to undo — the tools say so.
const { z } = require('zod');
const User = require('../../models/User');
const { registerTool } = require('../registry');
const { ok, fail, pageParams } = require('../toolUtil');
const { logAudit } = require('../../services/audit');
const {
  updatePreferences, updateProfile, createSupportTicket, createWineRequest,
  ALLOWED_CURRENCIES, ALLOWED_LANGUAGES, ALLOWED_RATING_SCALES,
  ALLOWED_RACK_NAV, ALLOWED_RESTOCK_SCOPE, ALLOWED_VISIBILITY, SUPPORT_CATEGORIES,
} = require('../../services/accountOps');

/** Compact, PII-safe view of the caller's preferences. */
function prefsView(user) {
  const p = user.preferences || {};
  const n = p.notifications || {};
  return {
    currency: p.currency || 'USD',
    language: p.language || 'en',
    rating_scale: p.ratingScale || '5',
    rack_navigation: p.rackNavigation || 'auto',
    restock_scope: p.restockScope || 'all',
    default_cellar_id: p.defaultCellarId || null,
    notifications: {
      drink_window: { enabled: n.drinkWindow?.enabled ?? true, email: !!n.drinkWindow?.email, push: !!n.drinkWindow?.push },
      community_reply: { email: !!n.communityReply?.email, push: n.communityReply?.push ?? true },
      community_mention: { email: !!n.communityMention?.email, push: n.communityMention?.push ?? true },
      community_follow: { push: n.communityFollow?.push ?? true },
    },
  };
}

/** Compact view of the caller's own profile. */
function profileView(user) {
  return {
    username: user.username,
    display_name: user.displayName || null,
    bio: user.bio || null,
    profile_visibility: user.profileVisibility || 'public',
    followers: user.followersCount || 0,
    following: user.followingCount || 0,
    // Boolean only, never the tier or billing details. Lets a well-behaved AI
    // THANK an existing supporter instead of suggesting they become one (see
    // the supporter line in mcp/instructions.js). All tiers are functionally
    // identical (config/plans.js) — this flag gates a courtesy, not a feature.
    supporter: !!(user.plan && user.plan !== 'free'),
  };
}

const NOTIFICATION_SHAPE = z.object({
  drinkWindow: z.object({
    enabled: z.boolean().optional(),
    email: z.boolean().optional(),
    push: z.boolean().optional(),
  }).optional(),
  communityReply: z.object({ email: z.boolean().optional(), push: z.boolean().optional() }).optional(),
  communityMention: z.object({ email: z.boolean().optional(), push: z.boolean().optional() }).optional(),
  communityFollow: z.object({ push: z.boolean().optional() }).optional(),
}).optional();

registerTool({
  name: 'get_preferences',
  title: 'Get account preferences',
  description:
    'The user\'s display and notification settings: preferred currency, interface language, rating scale ' +
    '(5 / 20 / 100), rack-navigation mode, restock-alert scope, default cellar, and per-category email/push ' +
    'notification toggles. Call this EARLY so you format money in their currency and ratings on their scale, and ' +
    'before changing any setting so you know the current value.',
  scope: 'read',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {},
  handler: async (_args, ctx) => {
    const user = await User.findById(ctx.user.id).lean();
    if (!user) return fail('not_found', 'Account not found.');
    return ok('Account preferences', prefsView(user));
  },
});

registerTool({
  name: 'update_preferences',
  title: 'Update account preferences',
  description:
    `Changes one or more settings; send only the fields to change. currency (a 3-letter code from ${ALLOWED_CURRENCIES.slice(0, 6).join('/')}…), ` +
    `language (${ALLOWED_LANGUAGES.join('/')}), rating_scale (${ALLOWED_RATING_SCALES.join('/')}), rack_navigation ` +
    `(${ALLOWED_RACK_NAV.join('/')}), restock_scope (${ALLOWED_RESTOCK_SCOPE.join('/')}), default_cellar_id (a cellar the ` +
    'user owns, or null to clear), and notification email/push toggles. Confirm the change with the user first. ' +
    'Cosmetic and reversible — the response echoes the new settings, so set a value back to undo.',
  scope: 'write',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: {
    currency: z.string().length(3).optional(),
    language: z.enum(['en', 'sv']).optional(),
    rating_scale: z.enum(['5', '20', '100']).optional(),
    rack_navigation: z.enum(['auto', 'room', 'rack']).optional(),
    restock_scope: z.enum(['all', 'cellar']).optional(),
    default_cellar_id: z.string().regex(/^[a-f0-9]{24}$/i).nullable().optional(),
    notifications: NOTIFICATION_SHAPE,
  },
  handler: async (args, ctx) => {
    // Map snake_case tool params to the camelCase body accountOps expects (the
    // shared REST contract). Only forward keys the caller actually sent.
    const body = {};
    if (args.currency !== undefined) body.currency = args.currency;
    if (args.language !== undefined) body.language = args.language;
    if (args.rating_scale !== undefined) body.ratingScale = args.rating_scale;
    if (args.rack_navigation !== undefined) body.rackNavigation = args.rack_navigation;
    if (args.restock_scope !== undefined) body.restockScope = args.restock_scope;
    if (args.default_cellar_id !== undefined) body.defaultCellarId = args.default_cellar_id;
    if (args.notifications !== undefined) body.notifications = args.notifications;

    const { user, error } = await updatePreferences(ctx.user.id, body);
    if (error) return fail(error.status === 404 ? 'not_found' : 'invalid_input', error.message);
    return ok('Preferences updated', prefsView(user));
  },
});

registerTool({
  name: 'get_profile',
  title: 'Get your public profile',
  description:
    'The user\'s own community profile: username, display name, bio, visibility (public / private) and follower ' +
    'counts. Call before updating the profile, or when asked "what does my profile say?".',
  scope: 'read',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {},
  handler: async (_args, ctx) => {
    const user = await User.findById(ctx.user.id).lean();
    if (!user) return fail('not_found', 'Account not found.');
    return ok('Your profile', profileView(user));
  },
});

registerTool({
  name: 'update_profile',
  title: 'Update your public profile',
  description:
    'Changes the community profile: display_name (max 50 chars), bio (max 500), and profile_visibility ' +
    `(${ALLOWED_VISIBILITY.join(' / ')}). Send only what changes; confirm with the user first. Reversible — the ` +
    'response echoes the new profile, so set a field back to undo. HTML is stripped from text.',
  scope: 'write',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: {
    display_name: z.string().max(500).nullable().optional().describe('Public display name (max 50 chars after HTML strip)'),
    bio: z.string().max(2000).nullable().optional().describe('Short bio (max 500 chars after HTML strip)'),
    profile_visibility: z.enum(['public', 'private']).optional(),
  },
  handler: async (args, ctx) => {
    const body = {};
    if (args.display_name !== undefined) body.displayName = args.display_name;
    if (args.bio !== undefined) body.bio = args.bio;
    if (args.profile_visibility !== undefined) body.profileVisibility = args.profile_visibility;

    const { user, error } = await updateProfile(ctx.user.id, body);
    if (error) return fail(error.status === 404 ? 'not_found' : 'invalid_input', error.message);
    logAudit(ctx.req, 'user.profile.update', { type: 'user', id: user._id }, { via: 'mcp' });
    return ok('Profile updated', profileView(user));
  },
});

registerTool({
  name: 'create_support_ticket',
  title: 'Contact Cellarion support',
  description:
    'Files a support ticket to the Cellarion admins (a bug report, a question, a feature request). category is one ' +
    `of ${SUPPORT_CATEGORIES.join(' / ')}; subject ≤200 chars, message ≤5000. Use only for issues WITH the app itself — ` +
    'not for cellar actions you can do with other tools. Confirm the wording with the user first; this reaches a ' +
    'human and cannot be unsent. Track replies with list_my_tickets (or in the web app under Settings → Support).',
  scope: 'write',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  inputSchema: {
    category: z.enum(['bug', 'help', 'feature', 'other']),
    subject: z.string().min(1).max(200),
    message: z.string().min(1).max(5000),
  },
  handler: async (args, ctx) => {
    const { ticket, error } = await createSupportTicket(ctx.user.id, {
      category: args.category, subject: args.subject, message: args.message,
    });
    if (error) return fail('invalid_input', error.message);
    logAudit(ctx.req, 'support.ticket.created', { type: 'SupportTicket', id: ticket._id }, {
      via: 'mcp', category: ticket.category,
    });
    return ok(`Support ticket submitted (${ticket.category})`, {
      ticket_id: ticket._id,
      category: ticket.category,
      status: ticket.status,
      note: 'A Cellarion admin will respond — check back with list_my_tickets (replies also arrive as a notification and in the web app under Settings → Support).',
    });
  },
});

registerTool({
  name: 'list_my_tickets',
  title: 'List your support tickets',
  description:
    'The user\'s own support tickets with any admin response, newest first — the read side of ' +
    'create_support_ticket. Call when the user asks whether support has replied, what the answer was, or what ' +
    'they have filed. Optional status filter: open / in_progress / closed.',
  scope: 'read',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    status: z.enum(['open', 'in_progress', 'closed']).optional(),
    limit: z.number().int().min(1).max(50).default(20),
    offset: z.number().int().min(0).default(0),
  },
  handler: async (args, ctx) => {
    // Lazy model require keeps the registry load path lean (file convention —
    // see the alerts resource).
    const SupportTicket = require('../../models/SupportTicket');
    const { limit, offset } = pageParams(args, 20, 50);
    const filter = { user: ctx.user.id, ...(args.status ? { status: args.status } : {}) };
    const [total, tickets] = await Promise.all([
      SupportTicket.countDocuments(filter),
      SupportTicket.find(filter)
        .sort({ createdAt: -1 }).skip(offset).limit(limit)
        // Same field set the GDPR export ships for tickets — nothing extra.
        .select('category subject message status adminResponse respondedAt createdAt')
        .lean(),
    ]);
    const data = tickets.map((t) => ({
      ticket_id: t._id,
      category: t.category,
      subject: t.subject,
      message: t.message,
      status: t.status,
      admin_response: t.adminResponse || null,
      responded_at: t.respondedAt || null,
      created_at: t.createdAt,
    }));
    const answered = data.filter((t) => t.admin_response).length;
    return ok(
      `${total} support ticket(s)${args.status ? ` (${args.status})` : ''}${answered ? `, ${answered} shown with a response` : ''}`,
      data,
      { page: { limit, offset, total } }
    );
  },
});

registerTool({
  name: 'request_wine_addition',
  title: 'Request a wine be added to the registry',
  description:
    'Submits a wine for the Cellarion team to add to the shared registry — the fallback when resolve_wine finds no ' +
    'match AND you can\'t confirm enough detail (producer, country, type) to add it yourself with add_bottle/new_wine. ' +
    'Requires a source_url (a Systembolaget / Vivino / winery page an admin can verify) and the wine_name as printed. ' +
    'This is a request to a human queue, not an instant add — tell the user it may take a while and that add_bottle ' +
    'with new_wine is the immediate route when the details are known.',
  scope: 'write',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  inputSchema: {
    wine_name: z.string().min(1).max(300).describe('The wine name as printed on the label / source'),
    source_url: z.string().min(1).max(2048).describe('An http(s) link to a page describing the wine (required)'),
    image_url: z.string().max(500000).optional().describe('Optional image URL or data reference for the wine'),
  },
  handler: async (args, ctx) => {
    const { wineRequest, error } = await createWineRequest(ctx.user.id, {
      wineName: args.wine_name, sourceUrl: args.source_url, image: args.image_url,
    });
    if (error) return fail('invalid_input', error.message);
    logAudit(ctx.req, 'wineRequest.create', { type: 'wineRequest', id: wineRequest._id }, { via: 'mcp' });
    return ok(`Wine addition requested: ${wineRequest.wineName}`, {
      request_id: wineRequest._id,
      wine_name: wineRequest.wineName,
      status: wineRequest.status,
      note: 'A Cellarion admin will review this. To add it to YOUR cellar right now instead, use resolve_wine → add_bottle once you have the producer, country and type.',
    });
  },
});

module.exports = { prefsView, profileView };
