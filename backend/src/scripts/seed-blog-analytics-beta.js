/**
 * seed-blog-analytics-beta.js
 *
 * Seeds the analytics-beta launch post:
 *   "Ask Your Cellar Anything: Analytics Comes to Cellarion (Beta)"
 *
 * Why: the #987 analytics view (table, filters incl. personal/registry data,
 * grouping, charts, 14 presets, CSV) shipped as beta in v1.136.0 and the
 * Dashboard page + AI-connector tools ship in v1.137.0. The post's whole
 * point is the beta framing: we shipped early on purpose and want feedback —
 * forum, support ticket, or GitHub issue.
 *
 * ⚠️ Publish AFTER v1.137.0 is on prod: the post mentions the Dashboard page
 * and the connector tools, which do not exist on v1.136.0.
 *
 * Behaviour:
 *   - Idempotent: upserts by slug, so re-running updates the post in place.
 *   - Defaults to DRAFT. Pass --publish to publish it (sets publishedAt once).
 *   - Author is the first admin user found (BlogPost requires an author).
 *
 * Usage (containers must be running):
 *   docker exec cellarion-backend node src/scripts/seed-blog-analytics-beta.js
 *   docker exec cellarion-backend node src/scripts/seed-blog-analytics-beta.js --publish
 */

require('dotenv').config();
const mongoose = require('mongoose');
const BlogPost = require('../models/BlogPost');
const User = require('../models/User');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://mongo:27017/winecellar';
const PUBLISH = new Set(process.argv.slice(2)).has('--publish');

const SLUG = 'cellar-analytics-beta';

const TITLE = 'Ask Your Cellar Anything: Analytics Comes to Cellarion (Beta)';

const META_TITLE = 'Cellar Analytics — Tables, Charts and Dashboards | Cellarion';
const META_DESCRIPTION =
  'Slice your wine cellar any way you like — filter, group, chart and export every attribute, including your own custom data. New in Cellarion, free, in beta.';
const EXCERPT =
  "Until now, Cellarion answered the questions we thought of. The new analytics view answers yours: pick any columns, filter on anything — including data fields you defined yourself — group, chart, export to CSV, and pin the answers to a dashboard. It's free like everything else, it's honest about its numbers in ways spreadsheets aren't, and it's a beta: we want to hear what's wrong with it.";

// HTML only — the blog sanitizer allows h2–h4, p, ul/ol/li, a, strong/em, tables.
const CONTENT = `
<h2>Your cellar, sliced your way</h2>

<p>Every cellar tool answers the questions its developers thought of. <em>How many bottles? What's the split by type?</em> Useful — but your questions are more specific than ours. <em>Which of my Burgundies are ready and cost over 500 kr? Where is my money sitting, by region? What did I actually drink last year, and how did I rate it?</em></p>

<p>The new <strong>analytics view</strong> answers those. Open any cellar and look at the view switcher above your bottles — next to list and card view there's now a third, table-shaped icon. Click it and your cellar becomes something you can interrogate:</p>

<ul>
<li><strong>Choose your columns</strong> — from wine identity and purchase details to drink windows, consumption history, and <em>your own custom fields</em>. If you've defined an ABV field or a "bought at" note as personal data, it's a column now, and you can filter and sort on it.</li>
<li><strong>Filter on anything</strong> — ranges on prices and dates, multi-select on types, text search on producers.</li>
<li><strong>Group and chart</strong> — count or sum by any dimension, then flip the result into bars, a donut, or a line.</li>
<li><strong>Export to CSV</strong> — exactly what you're looking at, ready for Excel.</li>
</ul>

<h3>Or skip the building entirely</h3>

<p>The <strong>Pre-built views</strong> menu holds fourteen ready-made questions — including a few you probably haven't thought to ask your cellar:</p>

<ul>
<li><em>Past their window</em> — bottles whose drink-by year is already behind you, still sitting in the rack.</li>
<li><em>Forgotten bottles</em> — in your cellar two years or more, oldest first.</li>
<li><em>Where I shop</em> — your merchants, with what the average bottle costs you at each.</li>
<li><em>How bottles leave</em> — drunk, gifted or sold, weighted by what they cost. The gift number surprises people.</li>
<li><em>My favourite regions</em> — by your own ratings, which rarely agree with where your money went.</li>
</ul>

<h3>And a dashboard you just look at</h3>

<p>The new <strong>Dashboard</strong> page (in the main menu) opens with the essentials already assembled: bottle count, total value, average rating, money by region, what you buy versus what you actually drink, and your cellar's aging runway. Build any view you like in the analytics table, press <em>"Add to dashboard"</em>, and it's pinned. On a phone it's a simple scrolling feed — this is the surface we built for mobile.</p>

<h3>Numbers you can trust</h3>

<p>A quiet point we care about: cellar numbers are easy to get silently wrong. Mixed currencies added together, a 92-point rating averaged with a 4-star one, consumed bottles quietly included or excluded. The analytics engine refuses to do any of that: money converts before it's summed (and tells you when a rate was missing), ratings are unified to one scale before they're compared, and whether consumed bottles are in or out is always shown on screen — never a hidden default.</p>

<h3>If you use the AI connector</h3>

<p>Your connected assistant can use all of this too. Ask Claude or ChatGPT <em>"how much have I spent per region?"</em> and it composes the query itself against the same engine — same access rules, same honest numbers. If you're connected already, start a fresh conversation so it picks up the new tools. (New here? <a href="/blog/connect-your-ai-to-your-wine-cellar">The connector has its own post.</a>)</p>

<h2>It's a beta — help us make it good</h2>

<p>We're shipping this early on purpose, and the <strong>Beta</strong> badge on the page means exactly that: the numbers went through more testing than anything we've shipped before, but real cellars are stranger than test data, and the interface will have rough edges — especially on mobile, where we know the table view is not its best self yet.</p>

<p>The look and feel is equally in motion — we are actively making the interface nicer to work with, and suggestions are as welcome as bug reports. If a control feels clumsy, a chart is hard to read, or you wish something were two clicks closer, say so: interface complaints are not nitpicks, they are the roadmap.</p>

<p>If a number looks wrong, a filter misbehaves, or there's a view you want and can't build — tell us. That feedback decides what this feature becomes:</p>

<ul>
<li><strong>The forum</strong> — post in <a href="/community/discussions">Discussions</a>, where other users can vote and pile on.</li>
<li><strong>A support ticket</strong> — from the Support page in the app, best for "this number is wrong for my cellar" since we can look at the specifics together.</li>
<li><strong>GitHub</strong> — <a href="https://github.com/jagduvi1/Cellarion/issues" target="_blank" rel="noopener noreferrer">open an issue</a> if you're technically inclined; Cellarion is open source and the whole analytics engine is in the repo.</li>
</ul>

<p>Like everything in Cellarion, analytics is free for everyone — paid plans support the project, they don't unlock features. Skål!</p>
`.trim();

async function run() {
  // Cheap guards — Mongoose throws a ValidationError on these, but only after
  // connecting, which makes a length slip look like a database problem.
  if (META_TITLE.length > 70) throw new Error(`metaTitle is ${META_TITLE.length} chars (max 70)`);
  if (META_DESCRIPTION.length > 160) throw new Error(`metaDescription is ${META_DESCRIPTION.length} chars (max 160)`);

  console.log('Connecting to MongoDB…');
  await mongoose.connect(MONGO_URI);
  console.log('Connected.\n');

  const admin = await User.findOne({ roles: 'admin' }).select('_id username').lean();
  if (!admin) {
    console.error('No admin user found — a BlogPost requires an author. Create an admin first.');
    await mongoose.disconnect();
    process.exit(1);
  }
  console.log(`Author: ${admin.username} (${admin._id})`);
  console.log(`Mode: ${PUBLISH ? 'PUBLISH' : 'DRAFT (review in the admin editor, then publish)'}\n`);

  const existing = await BlogPost.findOne({ slug: SLUG });

  const fields = {
    title: TITLE,
    slug: SLUG,
    excerpt: EXCERPT,
    content: CONTENT,
    author: admin._id,
    tags: ['analytics', 'announcement', 'beta'],
    metaTitle: META_TITLE,
    metaDescription: META_DESCRIPTION,
    // Without --publish, keep an already-published post published (re-running
    // the seed must never silently flip it back to draft).
    status: PUBLISH ? 'published' : (existing?.status || 'draft'),
  };

  if (existing) {
    Object.assign(existing, fields);
    // Don't clobber an existing publish date; set one only when first publishing.
    if (PUBLISH && !existing.publishedAt) existing.publishedAt = new Date();
    if (!PUBLISH) existing.publishedAt = existing.publishedAt || null;
    await existing.save();
    console.log(`Updated existing post "${existing.slug}" (status: ${existing.status}).`);
  } else {
    const post = new BlogPost({ ...fields, publishedAt: PUBLISH ? new Date() : null });
    await post.save();
    console.log(`Created post "${post.slug}" (status: ${post.status}).`);
  }

  console.log(`\nView (once published): ${process.env.FRONTEND_URL || 'https://cellarion.app'}/blog/${SLUG}`);
  console.log(`Crawler render:        /api/og/blog/${SLUG}`);
  console.log('\nDone.');
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
