const WineDefinition = require('../models/WineDefinition');
const WineVintageProfile = require('../models/WineVintageProfile');
const { MIN_WINES } = require('../config/taxonomyPages');

/**
 * What a public wine page shows around the wine itself: links to the region,
 * country and grape pages that exist, one sentence about the region and each
 * grape, other wines from the producer, similar wines from the region, and
 * the sommelier drink windows.
 *
 * Callers: GET /api/wines/:idOrSlug/public (the page people see) and the
 * og.js crawler page (the page search engines read), so both show the same.
 *
 * Drink windows are the registry data most worth keeping: a signed-out
 * reader learns only how many vintages have a reviewed window
 * (`reviewedVintages`); `drinkWindows` with the years is added for members
 * (`full`). Related wines are identity only and never include canaries,
 * non-wines or half-identified rows.
 */

// What a public listing may show: the filter the taxonomy pages count with.
const VISIBLE = { nonWine: { $ne: true }, pendingIdentity: { $ne: true } };
const LISTED = { ...VISIBLE, canary: { $ne: true } };
const SAME_PRODUCER_MAX = 6;
const SIMILAR_MAX = 4;
// Similar wines are ranked by shared grapes among this many candidates.
const SIMILAR_POOL = 60;
const EXCERPT_MAX = 220;
// The context is optional decoration: a slow query must not hold the wine
// itself back (the routes catch the error and answer without context).
const MAX_TIME_MS = 1500;
// A period after these words does not end a sentence ("St. Laurent").
const ABBREVIATION_END = /(?:^|[\s(])(?:st|ste|mt|dr|no|vs|ca|c|e\.g|i\.e)\.$/i;

/**
 * The first sentence of a curated markdown description, as plain text, cut
 * on a word with an ellipsis past EXCERPT_MAX. A "..." pause inside the text
 * (curated region texts open "Provence ... — a sun-drenched region") and a
 * period after an abbreviation do not end the sentence. Null when empty.
 */
function firstSentence(markdown) {
  if (typeof markdown !== 'string' || !markdown.trim()) return null;
  const text = markdown
    .split(/\n\s*\n/)[0]
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#>]/g, '')
    .replace(/\s*(?:\.\.\.|…)\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const ends = /[.!?](?=\s|$)/g;
  let end = -1;
  for (let m = ends.exec(text); m; m = ends.exec(text)) {
    if (m[0] === '.' && ABBREVIATION_END.test(text.slice(0, m.index + 1))) continue;
    end = m.index;
    break;
  }
  const sentence = end >= 0 ? text.slice(0, end + 1) : text;
  if (sentence.length <= EXCERPT_MAX) return sentence;
  const cut = sentence.slice(0, EXCERPT_MAX - 1);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 80 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:]+$/, '')}…`;
}

// Whether the taxonomy page exists: stop counting at MIN_WINES, so a country
// with thousands of wines costs no more than a small region.
async function hasPage(field, id) {
  const count = await WineDefinition.countDocuments({ [field]: id, ...LISTED })
    .limit(MIN_WINES)
    .maxTimeMS(MAX_TIME_MS);
  return count >= MIN_WINES;
}

async function taxonomyEntry(doc, field, base, { excerpt = true } = {}) {
  if (!doc || !doc.name) return null;
  const linked = doc.slug ? await hasPage(field, doc._id) : false;
  return {
    name: doc.name,
    path: linked ? `/${base}/${doc.slug}` : null,
    excerpt: excerpt ? firstSentence(doc.description) : null,
  };
}

function relatedEntry(w) {
  return {
    name: w.name,
    producer: w.producer,
    type: w.type || null,
    colour: w.colour || null,
    place: w.appellation || w.region?.name || null,
    path: `/wines/${w.slug || w._id}`,
  };
}

async function sameProducerWines(wine) {
  if (!wine.producer) return [];
  // On a canary's own page its producer's other canaries are its siblings:
  // leaving them out would make the empty list a tell. They are all canaries,
  // so no real wine's listing changes.
  const listed = wine.canary === true ? VISIBLE : LISTED;
  const rows = await WineDefinition.find({ producer: wine.producer, _id: { $ne: wine._id }, ...listed })
    .select('name producer slug type colour appellation region')
    .populate('region', 'name')
    .sort({ name: 1 })
    .limit(SAME_PRODUCER_MAX)
    .maxTimeMS(MAX_TIME_MS)
    .lean();
  return rows.map(relatedEntry);
}

async function similarWines(wine) {
  if (!wine.region?._id || !wine.type) return [];
  const pool = await WineDefinition.find({
    region: wine.region._id,
    type: wine.type,
    producer: { $ne: wine.producer },
    _id: { $ne: wine._id },
    ...LISTED,
  })
    .select('name producer slug type colour appellation grapes')
    .sort({ name: 1 })
    .limit(SIMILAR_POOL)
    .maxTimeMS(MAX_TIME_MS)
    .lean();
  const own = new Set((wine.grapes || []).map((g) => String(g._id || g)));
  const shared = (w) => (w.grapes || []).filter((g) => own.has(String(g))).length;
  return pool
    .map((w, i) => ({ w, i, s: shared(w) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, SIMILAR_MAX)
    .map(({ w }) => relatedEntry({ ...w, region: wine.region }));
}

// Newest year first, NV (and any other non-year) last. Vintages are stored as
// strings, so a string sort would put "NV" first.
function newestVintageFirst(a, b) {
  const ya = Number(a.vintage);
  const yb = Number(b.vintage);
  const okA = Number.isFinite(ya);
  const okB = Number.isFinite(yb);
  if (okA && okB) return yb - ya;
  if (okA) return -1;
  if (okB) return 1;
  return 0;
}

/**
 * @param {object} wine  WineDefinition (plain object) with country, region and grapes populated
 * @param {{ full: boolean }} opts  full = a signed-in member is reading
 * @returns {Promise<object>} { region, country, grapes, sameProducer, similar, reviewedVintages, drinkWindows? }
 *   region/country/grapes entries are { name, path (null when the page does not exist), excerpt }.
 */
async function buildWinePageContext(wine, { full }) {
  const grapes = (wine.grapes || []).filter((g) => g && g.name).slice(0, 4);
  const reviewed = { wineDefinition: wine._id, status: 'reviewed' };
  const [region, country, grapeEntries, sameProducer, similar, reviewedVintages, profiles] = await Promise.all([
    taxonomyEntry(wine.region, 'region', 'regions'),
    taxonomyEntry(wine.country, 'country', 'countries', { excerpt: false }),
    Promise.all(grapes.map((g) => taxonomyEntry(g, 'grapes', 'grapes'))),
    sameProducerWines(wine),
    similarWines(wine),
    WineVintageProfile.countDocuments(reviewed).maxTimeMS(MAX_TIME_MS),
    full
      ? WineVintageProfile.find(reviewed)
        .select('vintage relative earlyFrom earlyUntil peakFrom peakUntil lateFrom lateUntil')
        .limit(30)
        .maxTimeMS(MAX_TIME_MS)
        .lean()
      : [],
  ]);
  const context = {
    region,
    country,
    grapes: grapeEntries.filter(Boolean),
    sameProducer,
    similar,
    reviewedVintages,
  };
  if (full) {
    context.drinkWindows = [...profiles].sort(newestVintageFirst).map((p) => ({
      vintage: p.vintage,
      relative: p.relative === true,
      earlyFrom: p.earlyFrom ?? null,
      earlyUntil: p.earlyUntil ?? null,
      peakFrom: p.peakFrom ?? null,
      peakUntil: p.peakUntil ?? null,
      lateFrom: p.lateFrom ?? null,
      lateUntil: p.lateUntil ?? null,
    }));
  }
  return context;
}

module.exports = { buildWinePageContext, firstSentence };
