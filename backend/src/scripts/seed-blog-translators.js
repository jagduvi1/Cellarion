/**
 * seed-blog-translators.js
 *
 * Seeds the call-for-translators announcement:
 *   "Cellarion in Your Language — Help Translate It"
 *
 * Why: Weblate approved Cellarion for their free Libre plan on 2026-08-03, and
 * an Estonian translator turned up unprompted a few days before that. This post
 * is the public ask. Its central point is that "we need translators" is the
 * wrong request for French and German — both were machine-drafted, so every
 * field is already filled and what they need is reviewers.
 *
 * Behaviour:
 *   - Idempotent: upserts by slug, so re-running updates the post in place.
 *   - Defaults to DRAFT. Pass --publish to publish it (sets publishedAt once).
 *   - Author is the first admin user found (BlogPost requires an author).
 *
 * Usage (containers must be running):
 *   docker exec cellarion-backend node src/scripts/seed-blog-translators.js
 *   docker exec cellarion-backend node src/scripts/seed-blog-translators.js --publish
 */

require('dotenv').config();
const mongoose = require('mongoose');
const BlogPost = require('../models/BlogPost');
const User = require('../models/User');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://mongo:27017/winecellar';
const PUBLISH = new Set(process.argv.slice(2)).has('--publish');

const SLUG = 'help-translate-cellarion';

const TITLE = 'Cellarion in Your Language — Help Translate It';

const META_TITLE = 'Help Translate Cellarion Into Your Language | Cellarion';
const META_DESCRIPTION =
  "Cellarion's interface is community-translated on Weblate — no coding needed. French and German need reviewers, everything else needs translators.";
const EXCERPT =
  'Cellarion now speaks Swedish, French and German — and, as of last week, a little Estonian. All of it came from volunteers working in a web editor, with no Git and no code. Our Weblate project is approved and open, and the work that\'s most useful right now isn\'t what you\'d expect: two of our languages don\'t need translators at all, they need someone to read what\'s already there.';

// HTML only — the blog sanitizer allows h2–h4, p, ul/ol/li, a, strong/em, tables.
const CONTENT = `
<h2>Cellarion is translated by the people who use it</h2>

<p>Cellarion's interface has always been English first. It doesn't have to stay that way — and increasingly it doesn't. The app ships today in <strong>Swedish</strong>, <strong>French</strong> and <strong>German</strong>, with <strong>Estonian</strong> newly under way. None of that was done by us in a spreadsheet. It was done by volunteers in a web editor.</p>

<p>That editor is <a href="https://hosted.weblate.org/engage/cellarion/" target="_blank" rel="noopener noreferrer">Weblate</a>, and our project there has just been approved for their free Libre plan. Translating Cellarion needs <strong>no Git, no pull requests, and no code</strong>. You sign in, you see an English phrase with the context it appears in, you type your language's version, you move on. Weblate handles everything after that — it opens the pull request, we review and merge it, and your words are in the next release.</p>

<h2>The useful work isn't what you'd guess</h2>

<p>Here's the thing most projects don't tell you, and it costs them volunteers: <strong>"we need translators" is wrong for half our languages.</strong></p>

<p>French and German didn't start from an empty file. We drafted both in bulk, machine-first, precisely so that the human job would be the easier one — reviewing instead of typing. Every field is already filled. If you open French expecting blanks, you'll find none, conclude there's nothing to do, and leave.</p>

<p>There's plenty to do. It's just a different job:</p>

<ul>
<li><strong>French and German — we need readers, not typists.</strong> Machine-drafted text is fluent and confidently wrong in the places that matter: wine terminology, the register we address you in, a word that was right in one context and wrong in the one it got reused in. In Weblate, search <code>state:translated NOT state:approved</code> — that's the queue. Read it, fix what's off, approve what's right.</li>
<li><strong>Swedish — we need a second pair of eyes.</strong> It's effectively complete and it's been read by almost nobody.</li>
<li><strong>Estonian, or a language we don't have at all — we need translators.</strong> Start anywhere. Your language appears in the app's language menu from about 10 % onwards, and until then you can preview your own work live by adding <code>?lng=et</code> (or your code) to any Cellarion URL. Watching your translation land in the real interface is the fastest way to catch what a list of strings hides: the clipped button, the wrong tone, the term that needed a glossary entry.</li>
</ul>

<h2>What we've done to make it worth your time</h2>

<p>A few things, deliberately:</p>

<ul>
<li><strong>Nobody is silently switched into an unfinished language.</strong> Incomplete ones are labelled with their percentage, never auto-selected from browser settings, and never advertised to search engines. Untranslated text stays in English rather than showing you a broken half-translated screen.</li>
<li><strong>"Complete" and "checked by a human" are tracked separately.</strong> A language that's 100 % filled but unread says so, in the menu, in as many words. We'd rather be honest about that than let a percentage imply a review that never happened.</li>
<li><strong>There's a glossary</strong>, so <em>drink window</em>, <em>rack</em>, <em>cellar</em> and <em>appellation</em> mean one thing consistently instead of four things across four screens.</li>
<li><strong>Suggestion engines are available</strong> in the editor, so you're correcting a proposal rather than facing an empty box.</li>
<li><strong>You're credited</strong> — Weblate tracks who contributed what, and it's public.</li>
</ul>

<h2>Estonian arrived without being asked</h2>

<p>Last week someone found the project on Weblate and started translating it into Estonian. No introduction, no issue, no permission needed — the first we knew of it was a pull request with 39 Estonian strings in it. Thank you, whoever you are.</p>

<p>That's the model working exactly as intended, and it's the invitation: you don't need to ask us, and you don't need to commit to finishing. A dozen strings is a real contribution. So is fixing one word that's been wrong for months.</p>

<h2>Start here</h2>

<p><a href="https://hosted.weblate.org/engage/cellarion/" target="_blank" rel="noopener noreferrer"><strong>hosted.weblate.org/engage/cellarion</strong></a></p>

<p>If you'd like the detail first — guidelines, the glossary rules, plural forms, how a language graduates out of beta — that's all in <a href="https://github.com/jagduvi1/Cellarion/blob/main/TRANSLATING.md" target="_blank" rel="noopener noreferrer">TRANSLATING.md</a>.</p>

<p><a href="/">Cellarion</a> is free, open-source and self-hostable, and every feature is free forever. Its translations work the same way: contributed by the people who use it, for everyone who comes after.</p>
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
    tags: ['translations', 'community', 'weblate', 'open source', 'announcement'],
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
