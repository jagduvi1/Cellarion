/**
 * seed-whats-new-1-79.js
 *
 * Seeds the "What's New in Cellarion 1.77–1.79" release blog post — the
 * follow-up to whats-new-cellarion-1-76. Covers what shipped since 1.76:
 *   - v1.77.0: restore a mistakenly-consumed bottle (#679); Open-bottle button
 *     restored to the mobile bar (#678)
 *   - v1.78.0: unified CellarNav view switcher + tidied bottle/cellar actions,
 *     dead onboarding-tour markers removed (#681)
 *   - v1.79.0: nav made to read/behave like navigation — underline tab bar,
 *     shared CellarPageHeader (constant nav position), responsive Cellar Book (#683)
 *
 * Behaviour (mirrors seed-howto-article.js):
 *   - Idempotent: upserts by slug, so re-running updates the post in place.
 *   - Defaults to DRAFT so you can review it in the admin editor first.
 *     Pass --publish to publish it (sets publishedAt on first publish).
 *   - Author is the first admin user found (BlogPost requires an author).
 *   - Re-running without --publish never flips an already-published post back to draft.
 *
 * Usage (containers must be running):
 *   docker exec cellarion-backend node src/scripts/seed-whats-new-1-79.js            # upsert as draft
 *   docker exec cellarion-backend node src/scripts/seed-whats-new-1-79.js --publish  # upsert + publish
 */

require('dotenv').config();
const mongoose = require('mongoose');
const BlogPost = require('../models/BlogPost');
const User = require('../models/User');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://mongo:27017/winecellar';
const PUBLISH = new Set(process.argv.slice(2)).has('--publish');

const SLUG = 'whats-new-cellarion-1-77-1-79';

const TITLE = "What's New in Cellarion 1.77–1.79: Put a Bottle Back, and One Way Around Your Cellar";
const META_TITLE = "What's New in Cellarion 1.77–1.79 | Restore Bottles & Nav";
const META_DESCRIPTION =
  'Cellarion 1.77–1.79: restore a mistakenly consumed bottle, plus a unified cellar view switcher with underline tabs and a phone-friendly Cellar Book.';
const EXCERPT =
  "After the feature-packed 1.76, versions 1.77 through 1.79 are about polish: restore a bottle you logged as consumed by mistake, and get around every cellar page the same way — a single view switcher (Bottles · Racks · Room · History · Book) that finally reads and behaves like real navigation, with the actions you use most always in view and the rest tucked into a tidy ⋮ menu.";
const TAGS = ['release', 'feature', 'usability', 'navigation', 'undo'];

// HTML only — the blog sanitizer allows h2–h4, p, ul/ol/li, a, strong/em, tables.
const CONTENT = `
<h2>The tidy-up releases</h2>
<p>Version 1.76 was a big one — drag &amp; drop racks, open-bottle tracking, a thermometer in the cellar. The three releases since are the opposite kind: no new subsystem, just making what's already there feel finished. Two themes run through them — being able to take back a mistake, and getting around every corner of your cellar the same way.</p>

<h2>Put a bottle back</h2>
<p>Here's a mistake everyone makes eventually: you mark the wrong bottle as consumed. One wrong tap in the list, a bottle logged on the wrong night — and until now there was no way back. The "Added by mistake" undo only ever removed <em>active</em> bottles, and flatly refused consumed ones.</p>
<p>Now every bottle on your <strong>History</strong> page carries a <strong>Move back to cellar</strong> button. One tap flips the bottle back to active and wipes the consume details it shouldn't have — the date, the reason, the closing note and final rating — as if it never left. One thing worth knowing: the bottle comes back <strong>unplaced</strong>. Its rack slot was freed the moment you consumed it and may well be occupied now, so rather than guess, Cellarion returns the bottle with the <strong>Unplaced</strong> badge from 1.76 and lets you drop it into a slot yourself.</p>

<h2>One way around your cellar</h2>
<p>Features landed fast in 1.76, and each one bolted its entry point wherever it happened to be built. The result was a cellar you couldn't quite navigate: the printable <strong>Cellar Book</strong> was reachable only from the Racks page, <strong>Room View</strong> wasn't in the cellar menu at all, and every subpage had its own one-off header with no way to step sideways to another view.</p>
<p>So there's now a single <strong>view switcher</strong> — <em>Bottles · Racks · Room · History · Book</em> — on every cellar page. Wherever you are, the whole cellar is one tap away. It scrolls sideways on a phone, and gets out of the way when it should: hidden while you're printing the Cellar Book, and while you're editing the Room.</p>
<p>Then we made it actually feel like navigation. The strip used to look identical to the in-page filter toggles sitting right below it, so 1.79 turns it into a proper <strong>underline tab bar</strong> that reads as a menu rather than a filter. A shared page header means the tabs now anchor in the <strong>exact same spot on every page</strong> instead of drifting up and down as you move between them. And the <strong>Cellar Book</strong>, which used to run wider than a phone screen, now fits: the table scrolls on its own and sheds its lowest-value columns on a narrow display, while still printing in full on paper.</p>

<h2>Destinations and actions, finally sorted</h2>
<p>The switcher comes with one rule applied everywhere: <strong>destinations go in the nav strip, actions go in the ⋮ menu, and the actions you reach for most stay visible.</strong> The cellar's overflow menu is now purely actions, grouped sensibly — Manage (edit, color, share, wine lists), Data (import, export, audit log) and Danger (delete).</p>
<p>The bottle page got the same treatment. The things you do all the time — <strong>Edit</strong>, <strong>🍷 Open</strong>, <strong>Remove</strong> — stay in view, while rarer ones like <strong>Move</strong> and <strong>Added by mistake</strong> fold into a ⋮ menu, on both the desktop header and the mobile bar. That quietly kills a real papercut: on phones the action row used to overflow and cut the Move button clean off. (1.77 had already rescued a sibling of that bug — the Open-bottle button went missing from the mobile bar entirely the day 1.76 shipped.)</p>

<h2>A little dead weight gone</h2>
<p>Under the hood, we pulled out around 28 orphaned markers scattered across eleven files — leftovers from a guided onboarding tour that was removed long ago, still clinging on with nothing to do. Nothing you can see changes; there's just less to trip over next time.</p>

<h2>Getting it</h2>
<p>If you're on <a href="https://cellarion.app">cellarion.app</a>, you already have all of this — 1.79 is live. Self-hosters: pull the v1.79.0 images, with no docker-compose changes to make. And as always, the whole thing is open source <a href="https://github.com/jagduvi1/Cellarion">on GitHub</a>.</p>
`.trim();

async function run() {
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
    tags: TAGS,
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
