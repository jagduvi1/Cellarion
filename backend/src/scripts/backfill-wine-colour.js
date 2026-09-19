/**
 * Backfill WineDefinition.colour — the colour of a sparkling, dessert or
 * fortified wine (support ticket 2026-09-17, "Colour Sparkling/Rosè"; see
 * utils/wineColour.js). The model hook fills it from a rosé NAME on every
 * create or retype, so after this one pass new rows stay current by themselves.
 *
 * Two parts:
 *   1. COLOUR — sparkling/dessert/fortified rows with no colour whose name
 *      carries a rosé word, by the SAME inference the hook runs: set 'rosé'.
 *      A plain $set (the field is new and no search document carries it);
 *      updatedAt moves with it so Registry Bridge change checks pass it on.
 *   2. RETYPE CANDIDATES — rows typed 'rosé' that are plainly sparkling (a
 *      sparkling-only appellation, or a sparkling term in the name). Before
 *      the colour existed a sparkling rosé had to pick one of the two, and
 *      about one in eight picked rosé. LISTED ONLY: a type change re-indexes,
 *      re-enriches and moves the wine between filters, so it goes through the
 *      admin PUT (Admin → Wines, or PUT /api/admin/wines/:id
 *      { type: 'sparkling', colour: 'rosé' }) after a human has read the list.
 *      This script never retypes.
 *
 * Dry-run by default. --apply writes part 1. Safe to re-run.
 *
 *   docker exec cellarion-backend node src/scripts/backfill-wine-colour.js
 *   docker exec cellarion-backend node src/scripts/backfill-wine-colour.js --apply
 */

const mongoose = require('mongoose');
const WineDefinition = require('../models/WineDefinition');
const { STYLE_TYPES, inferColourFromName } = require('../utils/wineColour');

// Appellations that only exist as sparkling wine (a still Champagne-region
// rosé is "Rosé des Riceys" or Coteaux Champenois, never AOC Champagne).
// Letter-bounded, not \b: \b is ASCII-only, so it never closes after an "é".
const SPARKLING_APPELLATION = /^(champagne|cr[ée]mant|cava|franciacorta|trento|trentodoc|prosecco|conegliano|valdobbiadene|alta langa|blanquette de limoux|clairette de die|oltrep[òo] pavese metodo classico)(?!\p{L})/iu;
// Terms that only a sparkling wine's name carries.
const SPARKLING_TERM = /(?<!\p{L})(brut|extra[ -]brut|brut nature|pas dos[ée]|dosage z[ée]ro|spumante|cr[ée]mant|sekt|cava|metodo classico|m[ée]thode (champenoise|traditionnelle)|p[ée]t[- ]?nat|p[ée]tillant naturel|frizzante)(?!\p{L})/iu;

const label = (w) => `${w.producer || '?'} — ${w.name} [${w.appellation || '-'}] ${w._id}`;
// A private draft is its creator's, not registry content — both reads skip it.
const NOT_A_DRAFT = { draft: { $ne: true } };

(async () => {
  const apply = process.argv.includes('--apply');
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://mongo:27017/winecellar');

  // ── 1. colour from a rosé name ────────────────────────────────────────
  const styled = await WineDefinition.find({
    type: { $in: STYLE_TYPES },
    $or: [{ colour: null }, { colour: { $exists: false } }],
    ...NOT_A_DRAFT,
  }).select('name producer appellation type').lean();

  const toSet = styled.filter((w) => inferColourFromName(w.name, w.producer) === 'rosé');
  const byType = {};
  for (const w of toSet) byType[w.type] = (byType[w.type] || 0) + 1;
  console.log(`[backfill-wine-colour] ${apply ? 'APPLY' : 'DRY-RUN'} style-typed without colour=${styled.length} rosé by name=${toSet.length} ${JSON.stringify(byType)}`);
  for (const w of toSet.slice(0, 200)) console.log(`  colour rosé: (${w.type}) ${label(w)}`);
  if (toSet.length > 200) console.log(`  … and ${toSet.length - 200} more`);

  if (apply && toSet.length > 0) {
    const now = new Date();
    const res = await WineDefinition.bulkWrite(toSet.map((w) => ({
      updateOne: {
        // Re-checked in the filter: a colour set since the read is never overwritten.
        filter: { _id: w._id, type: w.type, $or: [{ colour: null }, { colour: { $exists: false } }] },
        update: { $set: { colour: 'rosé', updatedAt: now } },
      },
    })), { ordered: false });
    console.log(`[backfill-wine-colour] colour set on ${res.modifiedCount}`);
  }

  // ── 2. rosé-typed rows that are sparkling (listed, never written) ─────
  const roses = await WineDefinition.find({ type: 'rosé', ...NOT_A_DRAFT })
    .select('name producer appellation type').lean();
  const retype = roses.filter((w) => SPARKLING_APPELLATION.test(w.appellation || '') || SPARKLING_TERM.test(w.name || ''));
  console.log(`[backfill-wine-colour] rosé-typed rows that read as sparkling: ${retype.length} (review, then retype via the admin PUT)`);
  for (const w of retype) {
    const why = SPARKLING_APPELLATION.test(w.appellation || '') ? 'appellation' : 'name';
    console.log(`  retype? (${why}) ${label(w)}`);
  }

  await mongoose.disconnect();
})().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
