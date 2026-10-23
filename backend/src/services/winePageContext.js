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
const LISTED = { nonWine: { $ne: true }, pendingIdentity: { $ne: true }, canary: { $ne: true } };
const SAME_PRODUCER_MAX = 6;
const SIMILAR_MAX = 4;
// Similar wines are ranked by shared grapes among this many candidates.
const SIMILAR_POOL = 60;
const EXCERPT_MAX = 220;

/**
 * The first sentence of a curated markdown description, as plain text, cut
 * on a word with an ellipsis past EXCERPT_MAX. Null for an empty description.
 */
function firstSentence(markdown) {
  if (typeof markdown !== 'string' || !markdown.trim()) return null;
  const text = markdown
    .split(/\n\s*\n/)[0]
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const end = text.search(/[.!?](\s|$)/);
  const sentence = end >= 0 ? text.slice(0, end + 1) : text;
  if (sentence.length <= EXCERPT_MAX) return sentence;
  const cut = sentence.slice(0, EXCERPT_MAX - 1);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 80 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:]+$/, '')}…`;
}

async function hasPage(field, id) {
  const count = await WineDefinition.countDocuments({ [field]: id, ...LISTED });
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
    place: w.appellation || w.region?.name || null,
    path: `/wines/${w.slug || w._id}`,
  };
}

async function sameProducerWines(wine) {
  if (!wine.producer) return [];
  const rows = await WineDefinition.find({ producer: wine.producer, _id: { $ne: wine._id }, ...LISTED })
    .select('name producer slug type appellation region')
    .populate('region', 'name')
    .sort({ name: 1 })
    .limit(SAME_PRODUCER_MAX)
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
    .select('name producer slug type appellation grapes')
    .sort({ name: 1 })
    .limit(SIMILAR_POOL)
    .lean();
  const own = new Set((wine.grapes || []).map((g) => String(g._id || g)));
  const shared = (w) => (w.grapes || []).filter((g) => own.has(String(g))).length;
  return pool
    .map((w, i) => ({ w, i, s: shared(w) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, SIMILAR_MAX)
    .map(({ w }) => relatedEntry({ ...w, region: wine.region }));
}

/**
 * @param {object} wine  WineDefinition (plain object) with country, region and grapes populated
 * @param {{ full: boolean }} opts  full = a signed-in member is reading
 * @returns {Promise<object>} { region, country, grapes, sameProducer, similar, reviewedVintages, drinkWindows? }
 *   region/country/grapes entries are { name, path (null when the page does not exist), excerpt }.
 */
async function buildWinePageContext(wine, { full }) {
  const grapes = (wine.grapes || []).filter((g) => g && g.name).slice(0, 4);
  const [region, country, grapeEntries, sameProducer, similar, profiles] = await Promise.all([
    taxonomyEntry(wine.region, 'region', 'regions'),
    taxonomyEntry(wine.country, 'country', 'countries', { excerpt: false }),
    Promise.all(grapes.map((g) => taxonomyEntry(g, 'grapes', 'grapes'))),
    sameProducerWines(wine),
    similarWines(wine),
    WineVintageProfile.find({ wineDefinition: wine._id, status: 'reviewed' })
      .select(full ? 'vintage relative earlyFrom earlyUntil peakFrom peakUntil lateFrom lateUntil' : '_id')
      .sort({ vintage: -1 })
      .limit(30)
      .lean(),
  ]);
  const context = {
    region,
    country,
    grapes: grapeEntries.filter(Boolean),
    sameProducer,
    similar,
    reviewedVintages: profiles.length,
  };
  if (full) {
    context.drinkWindows = profiles.map((p) => ({
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
