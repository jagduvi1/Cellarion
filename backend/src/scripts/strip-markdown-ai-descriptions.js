/**
 * strip-markdown-ai-descriptions.js
 *
 * One-off cleanup for issue #788: AI enrichment used to be told "light Markdown
 * allowed" for WineDefinition.aiProfile.description, so already-enriched rows
 * carry literal ** ... ** (and the odd link/bullet). The field is served raw by
 * the MCP tools get_wine / get_bottle, where it renders verbatim.
 *
 * The prompt now forbids markdown and enrichmentJob strips it at the write
 * point, so this only has to clean up history. Re-running is idempotent:
 * stripMarkdown is a no-op on text that is already plain.
 *
 * Scope: aiProfile.description ONLY. Deliberately does NOT touch the taxonomy
 * (Grape/Region/Country) descriptions — those are intentionally markdown and
 * are rendered as such on the public pages (see seed-taxonomy-descriptions).
 *
 * Rows whose stripped text is identical are skipped without a write, so this is
 * safe to run against prod and cheap when there is nothing to do.
 *
 * Usage:
 *   node src/scripts/strip-markdown-ai-descriptions.js           # dry run
 *   node src/scripts/strip-markdown-ai-descriptions.js --apply   # execute
 */

require('dotenv').config();
const mongoose = require('mongoose');
const WineDefinition = require('../models/WineDefinition');
const { stripMarkdown } = require('../utils/stripMarkdown');

const APPLY = process.argv.includes('--apply');
const tag = APPLY ? '✔' : '[dry]';

async function run() {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://mongo:27017/winecellar');
  console.log(`Connected. Mode: ${APPLY ? 'APPLY' : 'DRY RUN (pass --apply to execute)'}\n`);

  const cursor = WineDefinition
    .find({ 'aiProfile.description': { $nin: [null, ''] } })
    .select('name producer aiProfile.description')
    .lean()
    .cursor();

  const stats = { scanned: 0, changed: 0, clean: 0, emptied: 0 };

  for await (const wine of cursor) {
    stats.scanned += 1;
    const before = wine.aiProfile.description;
    const after = stripMarkdown(before);

    if (after === before) { stats.clean += 1; continue; }

    // A description that strips to nothing was pure syntax — null it rather
    // than storing '', so the "needs enrichment" filter picks it up again.
    if (!after) stats.emptied += 1;
    stats.changed += 1;

    const label = [wine.name, wine.producer].filter(Boolean).join(' — ');
    console.log(`${tag} ${label} (${wine._id})`);
    console.log(`    - ${before}`);
    console.log(`    + ${after || '(empty → null)'}`);

    if (APPLY) {
      await WineDefinition.updateOne(
        { _id: wine._id },
        { $set: { 'aiProfile.description': after || null } }
      );
    }
  }

  console.log(`\nSummary: ${stats.scanned} scanned, ${stats.changed} ${APPLY ? 'updated' : 'would change'}, ${stats.clean} already plain, ${stats.emptied} stripped to empty.`);
  console.log('Note: embeddings are unaffected — services/embedding.js builds its text from the structured descriptors, not this prose.');
  await mongoose.disconnect();
}

run().catch((err) => { console.error('Cleanup failed:', err); process.exit(1); });
