/**
 * seed-howto-article.js
 *
 * Seeds the AEO "how-to cornerstone" blog post:
 *   "How to Track a Wine Collection: A Step-by-Step Guide"
 *
 * Why: a step-by-step guide is the format AI answer engines quote for procedural
 * "how do I…" queries. It routes through the existing /og/blog/:slug renderer, so
 * on publish it is AI-crawlable and its "Step N" <h2> headings auto-emit schema.org
 * HowTo JSON-LD (via extractHowToFromHtml), while the question-style <h3> headings
 * in the FAQ auto-emit FAQPage JSON-LD. See GRAND_AUDIT_2026-06-20.
 *
 * Behaviour:
 *   - Idempotent: upserts by slug, so re-running updates the post in place.
 *   - Defaults to DRAFT (status 'draft') so you can review/edit it in the admin
 *     blog editor first. Pass --publish to publish it (sets publishedAt).
 *   - Author is the first admin user found (BlogPost requires an author).
 *
 * Usage (containers must be running):
 *   docker exec cellarion-backend node src/scripts/seed-howto-article.js            # upsert as draft
 *   docker exec cellarion-backend node src/scripts/seed-howto-article.js --publish  # upsert + publish
 *
 * Or locally (requires .env):
 *   cd backend && node src/scripts/seed-howto-article.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const BlogPost = require('../models/BlogPost');
const User = require('../models/User');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://mongo:27017/winecellar';
const PUBLISH = new Set(process.argv.slice(2)).has('--publish');

const SLUG = 'how-to-track-a-wine-collection';

const META_TITLE = 'How to Track a Wine Collection (Step-by-Step Guide)';
const META_DESCRIPTION =
  'Track a wine collection step by step: what to record for each bottle, how to set up cellars and racks, follow drink windows, and back up your data.';
const EXCERPT =
  'A practical, step-by-step guide to tracking a wine collection — what to record for each bottle, how to organise cellars and racks, track drink windows so you open wines at their peak, log what you drink, and keep your data backed up and portable.';

// Article body. HTML only — the blog sanitizer allows h2–h4, p, ul/ol/li, a,
// strong/em, and full tables. The "Step N — …" <h2> headings auto-emit schema.org
// HowTo JSON-LD; the question-style <h3> headings under the FAQ auto-emit FAQPage.
const CONTENT = `
<p><strong>Quick answer:</strong> To track a wine collection, record each bottle's key details (vintage, producer, region, size, price, and your own rating and tasting notes), organise the bottles into one or more cellars, map where they physically sit on racks, and keep an eye on each wine's drink window so you open it at its best. A dedicated wine app like <a href="/">Cellarion</a> automates the tedious parts — label scanning, drink-window alerts, statistics and one-click backup — so your records stay accurate without spreadsheet upkeep.</p>

<p>Whether you have a dozen bottles in a kitchen rack or a thousand in a purpose-built cellar, the goal of tracking is the same: know <em>what</em> you own, <em>where</em> it is, and <em>when</em> to drink it. This guide walks through exactly how to do that, using Cellarion as the example tool. The same principles apply if you prefer a spreadsheet — an app just removes the manual work and the risk of an out-of-date file.</p>

<h2>What you'll need</h2>
<ul>
  <li><strong>Your bottles</strong> — or a list of them; you can also add bottles as they arrive.</li>
  <li><strong>A tool to record them</strong> — a free wine app such as Cellarion, or a spreadsheet if you prefer.</li>
  <li><strong>About 20 minutes</strong> to set up your first cellar. After that, adding a bottle takes seconds.</li>
</ul>

<h2>Step 1 — Decide what to record for each bottle of wine</h2>
<p>Good tracking starts with consistent data. For every bottle, capture the fields that let you search, value and drink your collection intelligently:</p>
<ul>
  <li><strong>Wine &amp; producer</strong> — the name and the winery, so duplicates and verticals group together.</li>
  <li><strong>Vintage</strong> — the year (or "NV" for non-vintage); this is what drives the drink window.</li>
  <li><strong>Region &amp; country</strong> — for organising your collection and for statistics later.</li>
  <li><strong>Bottle size</strong> — 750ml, magnum, half-bottle; size affects how a wine ages and what it's worth.</li>
  <li><strong>Price paid &amp; currency</strong> — so you can track the value of your cellar over time.</li>
  <li><strong>Your rating &amp; tasting notes</strong> — the part no public database can give you.</li>
</ul>
<p>In Cellarion these fields are built in, and a shared wine registry auto-fills producer, region and grape data so your entries stay clean and consistent. If you use a spreadsheet instead, make one column per field above and don't improvise new ones halfway through — consistency is what keeps the data searchable.</p>

<h2>Step 2 — Create a cellar to hold your collection</h2>
<p>A "cellar" is simply a named collection of bottles. Most people start with one — for example "Home Cellar" — but you can create several to separate a drink-now rack from long-term storage, a second home, or a restaurant list. In Cellarion, create your first cellar from the dashboard, give it a name, and you're ready to add bottles. Cellars can also be <a href="/help">shared with friends or co-managers</a> using role-based access, so a partner or sommelier can browse or help maintain the collection without taking it over.</p>

<h2>Step 3 — Map your storage with racks</h2>
<p>Knowing you <em>own</em> a bottle is half the job; knowing <em>where it is</em> saves you digging through every case. Recreate your physical storage as racks: set the rows and columns to match a real wine rack, fridge or shelving unit. Cellarion supports both grid racks and free-form shelves, and you can build several racks inside one cellar. Once your racks mirror reality, every bottle gets a home you can find in seconds — and you can view the whole cellar as an interactive grid or a to-scale <strong>3D room view</strong>.</p>

<h2>Step 4 — Add your bottles</h2>
<p>Now fill the cellar. You have three options, fastest first:</p>
<ul>
  <li><strong>Scan the label</strong> — snap a photo and let AI label scanning read the producer, wine and vintage, then fill in the rest. This is the quickest way to log a stack of bottles.</li>
  <li><strong>Search the registry</strong> — start typing the wine name; fuzzy matching finds it even with a typo and pulls in its region and grape data.</li>
  <li><strong>Import a spreadsheet</strong> — already have a list, or coming from Vivino or CellarTracker? Export it to CSV and use Cellarion's <a href="/help">import tool</a>; entries are de-duplicated automatically.</li>
</ul>
<p>Add the vintage, the price and your rating as you go. Don't aim for perfection on day one — log the bottles quickly, then refine the notes over time.</p>

<h2>Step 5 — Place each bottle so you can find it</h2>
<p>Assign every bottle to a slot on one of your racks. This is what turns a list into a map: when you want a specific wine, the app shows you exactly which row and column it sits in. If you rearrange your storage, just move the bottle to its new slot — and if a wine outgrows one cellar, you can <strong>move it to another cellar</strong> while keeping its full history. The 3D view makes a large cellar genuinely browsable, the way you'd scan real shelves.</p>

<h2>Step 6 — Track drink windows so you open wines at their best</h2>
<p>The biggest payoff of tracking is never wasting a great bottle. A <strong>drink window</strong> is the span of years a wine is at its peak. Cellarion classifies every vintage as <strong>Not Ready, Early, Peak, Late, or Declining</strong> from producer notes and vintage data, and sends <a href="/help">drink-window alerts</a> when a bottle approaches or passes its peak. Sort your cellar by drink status to see what to open this month and what to keep cellaring — so you drink your collection at its best instead of discovering a faded bottle too late.</p>

<h2>Step 7 — Log what you drink and review your stats</h2>
<p>Tracking doesn't stop when you pull the cork. When you open, gift or sell a bottle, mark it consumed and add a final rating and note. This keeps your inventory accurate, builds a personal drinking history, and feeds your statistics: breakdowns by country, grape, region, value and drink status, plus a world map of where your wine comes from. Over time this turns your cellar into a record of your taste — which producers and vintages you actually love — so you buy better.</p>

<h2>Step 8 — Back up your collection and keep it portable</h2>
<p>Your records are only as safe as your ability to get them out. Before you've invested hours of tracking, make sure you can export everything. Cellarion gives you a one-click export of your whole collection as JSON, or as a full ZIP archive that bundles your bottle images too — no lock-in, and an easy way to keep an offline backup. Because it's open-source and self-hostable, you always keep ownership of your data. Export every so often and your collection is safe no matter what.</p>

<h2>Tips for keeping your wine tracking accurate</h2>
<ul>
  <li><strong>Log bottles as they arrive.</strong> A two-minute habit at delivery beats a day-long catch-up later.</li>
  <li><strong>Mark bottles consumed the same evening.</strong> An accurate count is worth more than a perfect note.</li>
  <li><strong>Use one cellar per physical location</strong> so your racks always match what's really on the shelf.</li>
  <li><strong>Record the price you paid.</strong> It's the only way to track your cellar's value, and you can't add it later from memory.</li>
  <li><strong>Export periodically.</strong> A monthly backup means a lost phone never costs you your records.</li>
</ul>

<h2>Frequently asked questions</h2>

<h3>What is the best way to track a wine collection?</h3>
<p>The most reliable way is a dedicated wine app that records each bottle's vintage, producer, region, price, rating and storage location, and tracks its drink window. Apps like Cellarion add label scanning, drink-window alerts, statistics and one-click backup, so your records stay accurate without the manual upkeep a spreadsheet needs. A spreadsheet works for a small collection, but it can't alert you when a wine hits its peak or show you where a bottle physically sits.</p>

<h3>How do I catalogue my wine cellar?</h3>
<p>Create a cellar in your tracking app, recreate your physical racks as grids, then add each bottle — by scanning its label, searching a wine registry, or importing a CSV — and place it in the rack slot where it really sits. Record the vintage, price, your rating and tasting notes. Once every bottle has a home, your cellar becomes a searchable map you can browse as a grid or a 3D view.</p>

<h3>Can I track my wine collection for free?</h3>
<p>Yes. A small collection can be tracked free in a spreadsheet, and several wine apps offer free tiers. Cellarion is free for all core features — bottle tracking, cellars and racks, drink-window alerts, label scanning, statistics and data export — with no ads and no credit card required, in any browser or as an Android app on Google Play (iPhone users can install it to the home screen as a web app).</p>

<h3>What information should I record for each bottle of wine?</h3>
<p>At a minimum: the wine name and producer, the vintage, the region or country, the bottle size, the price you paid, and your own rating and tasting notes. Recording the price lets you track your cellar's value, and the vintage lets the app calculate the drink window. Adding where the bottle is stored — which cellar and rack slot — turns your list into a map you can search.</p>

<h3>How do I know when to drink a bottle?</h3>
<p>Each wine has a drink window — the range of years it is at its best. Cellarion estimates this from producer notes and vintage data and classifies every bottle as Not Ready, Early, Peak, Late or Declining, then alerts you as a bottle nears its peak. Sorting your collection by drink status shows you what to open now and what to keep cellaring.</p>

<h3>How do I move my collection from Vivino or CellarTracker?</h3>
<p>Export your collection from the other app as a CSV, then use Cellarion's import tool to bring it in. The shared wine registry de-duplicates entries automatically so your data stays clean. You keep your existing ratings and notes, and from then on you can take your data back out any time as a full JSON or ZIP archive.</p>

<p>Ready to start? <a href="/">Create a free cellar on Cellarion</a> and add your first bottle in under a minute. For more on choosing a tool, see our guide to the best wine cellar apps on the <a href="/blog">Cellarion blog</a>.</p>
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
    title: 'How to Track a Wine Collection: A Step-by-Step Guide',
    slug: SLUG,
    excerpt: EXCERPT,
    content: CONTENT,
    author: admin._id,
    tags: ['wine collection', 'cellar management', 'how to', 'wine tracking', 'getting started'],
    metaTitle: META_TITLE,
    metaDescription: META_DESCRIPTION,
    status: PUBLISH ? 'published' : 'draft',
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
