// Public/growth tools (plan Phase 6 §3.9): the anonymous-safe surface beyond
// the registry lookups — curated drink windows for a named wine, and the blog
// guides (cornerstone AEO content). Everything here is data the PUBLIC website
// already serves (wine pages / OG crawler pages / the blog), never user data,
// and never an AI call ($0 rule for the anonymous endpoint is absolute).
const { z } = require('zod');
const { registerTool } = require('../registry');
const { isValidId } = require('../../utils/validation');
const { ok, fail } = require('../toolUtil');
const { siteBaseUrl } = require('../../utils/siteUrl');

registerTool({
  name: 'drink_window_for',
  title: 'Drink window for a wine',
  description:
    'Sommelier-curated drink windows for a registry wine: per vintage, when it is young, at peak, and in late ' +
    'maturity, with where the vintage stands right now. Call for "when should I drink <wine> <vintage>", aging ' +
    'questions, or buy-now-drink-later advice. Only sommelier-REVIEWED vintages are returned — an empty result ' +
    'means no curated window exists yet (reason from grape/region/structure yourself, and say it is an estimate).',
  scope: 'public',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    wine_id: z.string().describe('Registry wine id (from search_registry)'),
    vintage: z.string().max(10).optional().describe('One vintage year; omit for all curated vintages of the wine'),
  },
  handler: async (args, ctx) => {
    // Lazy model requires keep the registry load path lean (file convention).
    const WineDefinition = require('../../models/WineDefinition');
    const WineVintageProfile = require('../../models/WineVintageProfile');
    // Registry lockdown (2026-09-06, L3): the anonymous surface gets the peak
    // window per vintage — the answer to "when should I drink it" — while the
    // early/late bounds, the curated table a copier wants, stay with signed-in
    // connections.
    const anonymous = !!ctx?.anonymous || !ctx?.user;

    if (!isValidId(String(args.wine_id || ''))) {
      return fail('invalid_input', 'wine_id must be a 24-hex id from search_registry.');
    }
    const wine = await WineDefinition.findById(args.wine_id).select('name producer type pendingIdentity').lean();
    // Public tool, no caller identity to compare — a pendingIdentity row is not
    // registry content yet (and has no reviewed maturity rows anyway, since it
    // never enters the somm queue). Same not_found a missing id gets.
    if (!wine || wine.pendingIdentity === true) {
      return fail('not_found', 'No such registry wine. Use search_registry for valid ids.');
    }

    const filter = { wineDefinition: wine._id, status: 'reviewed' };
    if (args.vintage) filter.vintage = String(args.vintage).trim();
    // Same field boundary as the public OG pages: window years only — never
    // sommNotes or curator identity.
    const profiles = await WineVintageProfile.find(filter)
      .select('vintage relative earlyFrom earlyUntil peakFrom peakUntil lateFrom lateUntil')
      .sort({ vintage: -1 }).limit(30).lean();

    const currentYear = new Date().getFullYear();
    const data = profiles.map((p) => {
      // `relative` profiles (NV wines) hold year-OFFSETS from purchase, not
      // calendar years — without a bottle there is no anchor, so report the
      // offsets as such and no now-status.
      const windows = anonymous
        ? { peak: { from: p.peakFrom ?? null, until: p.peakUntil ?? null } }
        : {
          early: { from: p.earlyFrom ?? null, until: p.earlyUntil ?? null },
          peak: { from: p.peakFrom ?? null, until: p.peakUntil ?? null },
          late: { from: p.lateFrom ?? null, until: p.lateUntil ?? null },
        };
      let now = null;
      if (!p.relative) {
        if (p.peakFrom && currentYear < p.peakFrom) now = (p.earlyFrom && currentYear >= p.earlyFrom) ? 'early' : 'not_ready';
        else if (p.peakUntil && currentYear <= p.peakUntil) now = 'peak';
        else if (p.lateUntil && currentYear <= p.lateUntil) now = 'late';
        else if (p.peakUntil || p.lateUntil) now = 'past';
        else if (p.peakFrom && currentYear >= p.peakFrom) now = 'peak';
      }
      return {
        vintage: p.vintage,
        unit: p.relative ? 'years_after_purchase' : 'calendar_year',
        windows,
        status_now: now,
      };
    });
    if (data.length === 0) {
      return ok(`No curated drink window for ${wine.name}${args.vintage ? ` ${args.vintage}` : ''}`, [], {
        warnings: ['No sommelier-reviewed window exists for this wine/vintage yet — any guidance you give is your own estimate; say so.'],
      });
    }
    return ok(
      `${data.length} curated vintage window(s) for ${wine.name}${wine.producer ? ` (${wine.producer})` : ''}`,
      { wine_id: wine._id, name: wine.name, producer: wine.producer || null, type: wine.type || null, vintages: data }
    );
  },
});

const GUIDE_LIST_LIMIT = 20;

registerTool({
  name: 'list_guides',
  title: 'List wine guides & articles',
  description:
    'Cellarion\'s published guides and blog articles (cellar management, drink windows, storage, buying) — title, ' +
    'slug, excerpt and tags. Call when the user wants a how-to or background reading; follow with read_guide for ' +
    'the full text.',
  scope: 'public',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    tag: z.string().max(40).optional().describe('Filter by tag'),
    // Unbounded at the schema layer on purpose — see the note on
    // find_similar_wines' `limit`. Pagination inputs are CLAMPED by the handler
    // below (an over-large page is a request to be capped, not a malformed
    // call); a schema-level .max would instead fail the call with -32602 before
    // the handler runs, and an SDK-level rejection is recorded in no counter at
    // all. Mutating tools keep their strict numeric bounds, where an
    // out-of-range value is genuinely a client bug worth refusing.
    limit: z.coerce.number().int().optional().describe(`How many to return (1-${GUIDE_LIST_LIMIT}, default 10; larger values are capped, not rejected)`),
    offset: z.coerce.number().int().optional().describe('Skip this many (default 0)'),
  },
  handler: async (args) => {
    const BlogPost = require('../../models/BlogPost');
    const limit = Math.min(Math.max(parseInt(args.limit, 10) || 10, 1), GUIDE_LIST_LIMIT);
    const offset = Math.max(parseInt(args.offset, 10) || 0, 0);
    const filter = { status: 'published' };
    if (args.tag && String(args.tag).trim()) filter.tags = String(args.tag).trim().toLowerCase();
    const [total, posts] = await Promise.all([
      BlogPost.countDocuments(filter),
      BlogPost.find(filter).sort({ publishedAt: -1 }).skip(offset).limit(limit)
        .select('title slug excerpt tags publishedAt').lean(),
    ]);
    return ok(`${posts.length} of ${total} published guide(s)`, posts.map((p) => ({
      slug: p.slug,
      title: p.title,
      excerpt: p.excerpt || null,
      tags: p.tags || [],
      published_at: p.publishedAt,
      public_url: `${siteBaseUrl()}/blog/${p.slug}`,
    })), { page: { limit, offset, total } });
  },
});

const GUIDE_MAX_CHARS = 30000;

registerTool({
  name: 'read_guide',
  title: 'Read a guide / article',
  description:
    'The full text of one published Cellarion guide or blog article, by slug (from list_guides). Public website ' +
    'content — quote or summarise freely, and link the public_url when pointing the user to it.',
  scope: 'public',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: { slug: z.string().min(1).max(200).describe('Article slug from list_guides') },
  handler: async (args) => {
    const BlogPost = require('../../models/BlogPost');
    const post = await BlogPost.findOne({ slug: String(args.slug).trim().toLowerCase(), status: 'published' })
      .select('title slug excerpt tags publishedAt content').lean();
    if (!post) return fail('not_found', 'No published article with that slug. Use list_guides for valid slugs.');
    const truncated = post.content.length > GUIDE_MAX_CHARS;
    return ok(`"${post.title}"`, {
      slug: post.slug,
      title: post.title,
      excerpt: post.excerpt || null,
      tags: post.tags || [],
      published_at: post.publishedAt,
      public_url: `${siteBaseUrl()}/blog/${post.slug}`,
      content: truncated ? post.content.slice(0, GUIDE_MAX_CHARS) : post.content,
    }, truncated ? { warnings: [`Content truncated at ${GUIDE_MAX_CHARS} characters — the full article is at the public_url.`] } : {});
  },
});

module.exports = {};
