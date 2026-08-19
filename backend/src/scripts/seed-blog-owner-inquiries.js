/**
 * Seed the "When Cellarion Asks About One of Your Bottles" blog post
 * (owner-inquiries announcement — draft source: BLOG_DRAFT_OWNER_INQUIRIES.md).
 *
 * Usage (inside the backend container):
 *   node src/scripts/seed-blog-owner-inquiries.js            # upsert as DRAFT
 *   node src/scripts/seed-blog-owner-inquiries.js --publish  # publish (sets publishedAt once)
 *
 * - Idempotent: upserts by slug, so re-running updates the post in place.
 * - Without --publish an already-published post STAYS published.
 * - ⚠️ Do not --publish before the release carrying owner inquiries (#930)
 *   is deployed — the post tells people the question card exists.
 */
const mongoose = require('mongoose');
const path = require('path');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://mongo:27017/winecellar';
const PUBLISH = process.argv.includes('--publish');

const TITLE = 'When Cellarion Asks About One of Your Bottles';
const SLUG = 'when-cellarion-asks-about-your-bottles';
const META_TITLE = 'Owner Inquiries — When Cellarion Asks About Your Bottles | Cellarion';
const META_DESCRIPTION = 'Some wine-record mysteries can only be solved by the person holding the bottle. Cellarion can now ask you — privately, in-app, and only when it matters.';
const EXCERPT = "Behind Cellarion's search box sits one shared wine registry, and we spend real effort keeping it clean — merging duplicates, fixing misplaced producers, teaching grapes to speak the language on the label. But a handful of records defeat every tool we have, because the answer isn't on the internet. It's on a label in someone's cellar. Starting this week, Cellarion can ask.";

const CONTENT = `<h2>One registry, shared by everyone</h2>

<p>When you add a bottle to Cellarion, you're not typing into a private spreadsheet. Your bottle points at a record in a <strong>shared wine registry</strong> — the same record everyone else's bottle of that wine points at. That's what makes search find things, duplicates collapse instead of multiply, drink windows arrive already curated, and statistics mean something.</p>

<p>It also means the registry's quality is everyone's quality. So we work on it constantly. This summer alone that has meant merging hundreds of duplicate records, moving misplaced names into their right fields (a famous château was briefly "produced by Bordeaux" — the region, not a winery), and teaching grapes to speak the label's language: a Douro Port in Cellarion now says <em>Tinta Roriz</em> where it used to say Tempranillo — same grape, but only one of those words is on the bottle.</p>

<p>Most of that work never needs to involve you. A wrong producer can be verified against the estate's own website; a duplicate betrays itself; our sommelier curation reviews drink windows and tasting profiles wine by wine, with every change checked before it lands. The registry gets better while you sleep.</p>

<h2>But some answers aren't on the internet</h2>

<p>Here's the honest part: a small residue of records defeats every tool we have. A bottle imported years ago with the producer recorded as "Unknown". A wine whose grape contradicts what that vineyard planted in that year. A label that might be a small Turkish producer — or might be a German Riesling filed under the wrong country. We've researched these against producer sites, appellation registers, and importers, and come up empty, because the answer isn't online.</p>

<p>The answer is on a label. In someone's cellar. Possibly yours.</p>

<p>At any given time it's only a small handful of records in the whole registry — but each one is a wine somebody genuinely owns and cares about, which is precisely why we won't guess. A wrong guess in a shared registry is worse than an honest gap.</p>

<h2>So Cellarion can now ask you</h2>

<p>Starting this week, when a curator hits one of these dead ends, they can send a question to the people who own a bottle of that wine. If that's you, here's what it looks like:</p>

<ul>
  <li>You get a normal Cellarion notification — <em>"A curator has a question about a wine in your cellar."</em></li>
  <li>It opens your bottle's page, where the question sits in a card: usually something like <em>"What does the label say the producer is?"</em></li>
  <li>You answer in a sentence, or you ignore it. Both are fine.</li>
</ul>

<p>If you answer, a curator reads it, fixes the record, and every copy of that wine — yours and everyone else's — gets better. The fix is often live within a day.</p>

<h2>The fine print, because it matters</h2>

<p>We built this the same way we build everything that touches your data:</p>

<ul>
  <li><strong>Questions are rare and human.</strong> Only administrators and sommelier-curators can ask, one open question per wine, only when research has failed.</li>
  <li><strong>Curators don't see who you are.</strong> Answers reach them anonymised — "owner 1 says the label reads…". No names, no emails.</li>
  <li><strong>No email.</strong> Questions arrive as in-app notifications (and push, if you've enabled it). Your inbox is not part of this.</li>
  <li><strong>It's about the wine, not about you.</strong> Your answer is a fact about a label. It's included in your data export, removed if you delete your account, and questions expire on their own after 60 days.</li>
</ul>

<h2>It goes both ways</h2>

<p>This closes a loop that already runs in your direction: if you spot something wrong with a wine — a misspelled producer, a duplicate, a suspicious vintage — the <em>Report</em> action on any wine page has always been the way to tell us, and those reports get read and acted on. Now the conversation works in both directions, and the last few mysteries in the registry finally have somewhere to go.</p>

<p>So if a question about one of your bottles shows up in your bell one day — that's not a bug, and it's not spam. That's the registry asking the only person in the world who can see the answer.</p>

<p><em>Cellarion is free, open-source, and lives at <a href="https://cellarion.app">cellarion.app</a>. The registry work described here ships in the current release — and if you'd like to help in other ways, we're also <a href="/blog/help-translate-cellarion">looking for translators</a>.</em></p>`;

(async () => {
  const BlogPost = require(path.join(__dirname, '..', 'models', 'BlogPost'));
  const User = require(path.join(__dirname, '..', 'models', 'User'));

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
    tags: ['registry', 'community', 'data quality', 'announcement'],
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
  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
