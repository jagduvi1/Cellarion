/**
 * The sweetness category a wine reads as — dry, off-dry, medium-sweet or
 * sweet — and what that rests on. ONE scale for still and sparkling wines, so
 * a cellar can be filtered without knowing every country's words. Worked out
 * from the record each time it is read, and never stored: the terms stay
 * what they are (labelSweetness, sweetnessStyle), and this is a reading of
 * them.
 *
 * First match wins:
 *   label  the term the label states (labelSweetness);
 *   name   the sweetness word the name still carries ("Riesling Kabinett
 *          trocken", "Cuvée Réserve Brut"), read exactly as the label
 *          sweetness write rule reads a name (services/sweetnessWrite
 *          extractLoaded): one term, as a word of its own, the last word of
 *          a still wine's name ("Dolce Vita" states nothing; a sparkling
 *          term is read anywhere), and none the reader doubts. So the word
 *          that will move into labelSweetness is the word the category
 *          rests on, and moving it changes the basis, never the category;
 *   style  the term the wine is known by (sweetnessStyle), when a read
 *          would send it (utils/sweetnessStyle styleShape);
 *   tier   a tier that is sweet by law (Beerenauslese, Eiswein …) is sweet,
 *          and a Grosses Gewächs is dry by the VDP's own rule;
 *   type   a wine typed "dessert" is sweet.
 * Nothing else is guessed: a Kabinett, Spätlese or Auslese without a term is
 * not stated (null), and so is every fortified wine and every drink that is
 * not wine — they have no scale. A wine with no type has no scale yet: its
 * name is not read, the rest is.
 *
 * A dry-side word in the name of a wine whose tier is sweet by law states
 * nothing ("Riesling Trocken Beerenauslese" is a Trockenbeerenauslese): the
 * write rules refuse that pair, and here the tier speaks.
 *
 * The sparkling bands fold onto the four: brut nature, extra brut and brut
 * are dry; extra dry and sec off-dry; demi-sec medium-sweet; doux sweet.
 *
 * A surface never reads the category off the wine it happens to hold: the
 * member reads leave out sweetnessInName, and a wine marked with it would
 * read differently there than in the filter. readSweetnessCategories loads
 * what the reading needs itself, so every surface answers the same.
 * Callers: the cellar search and its facets (services/bottleSearch, on its
 * own load of the same fields), the bottle list (services/bottleListQuery),
 * the bottle answers and the wine read (routes/bottles, routes/wines), the
 * vintage page (routes/cellars), the inventory (services/integrationInventory),
 * the offline copy (services/offlineSnapshot), the analytics rows
 * (services/analytics/queryEngine) and the MCP wine and bottle reads
 * (mcp/tools/wines, mcp/tools/bottles).
 */
const mongoose = require('mongoose');
const WineDefinition = require('../models/WineDefinition');
const { logger } = require('./audit');
const { loadTerms, resolveLoaded, scaleForType } = require('./sweetnessOps');
const { extractLoaded } = require('./sweetnessWrite');
const { sweetByLawPradikat } = require('../utils/styleTerms');
const { styleShape } = require('../utils/sweetnessStyle');
const { isValidId } = require('../utils/validation');

const CATEGORIES = Object.freeze(['dry', 'off-dry', 'medium-sweet', 'sweet']);
const BASES = Object.freeze(['label', 'name', 'style', 'tier', 'type']);
// A filter value, never a category: the wines that could state one and do not.
const NOT_STATED = 'not-stated';
const FILTER_VALUES = Object.freeze([...CATEGORIES, NOT_STATED]);

// Every band of both scales (models/SweetnessTerm BANDS; a test keeps the
// keys equal to them) onto the four categories.
const BAND_CATEGORY = Object.freeze({
  dry: 'dry', 'off-dry': 'off-dry', 'medium-sweet': 'medium-sweet', sweet: 'sweet',
  'brut-nature': 'dry', 'extra-brut': 'dry', brut: 'dry',
  'extra-dry': 'off-dry', sec: 'off-dry', 'demi-sec': 'medium-sweet', doux: 'sweet',
});
// The categories a tier that is sweet by law stands against.
const DRY_SIDE = new Set(['dry', 'off-dry']);

const idOf = (v) => (v && typeof v === 'object' && v._id ? v._id : v);

/** A term a wine refers to — a populated row, or an id looked up in the table — or null. */
function rowOf(terms, ref) {
  if (ref == null) return null;
  if (typeof ref === 'object' && typeof ref.band === 'string') return ref;
  return terms.byId.get(String(idOf(ref))) || null;
}

/**
 * The category of a term row on a wine's scale, or null. A row of the OTHER
 * scale is read as the same word on the wine's own (a sparkling wine holding
 * the still "trocken" is a Sekt "Trocken": the sec band), and states nothing
 * when the wine's scale has no such word. A band the fold does not know
 * states nothing either.
 */
function categoryOfRow(terms, row, scale, countryId) {
  if (!row || typeof row.band !== 'string') return null;
  let own = row;
  if (scale && row.scale && row.scale !== scale) {
    own = typeof row.name === 'string' ? resolveLoaded(terms, row.name, { scale, countryId }) : null;
  }
  return own && Object.hasOwn(BAND_CATEGORY, own.band) ? BAND_CATEGORY[own.band] : null;
}

/**
 * The term row of a style, stored ({ term, source, url }) or as a read sends
 * it ({ name, band, … }) — only when a read would send that style
 * (styleShape): a style no read vouches for is no basis either.
 */
function styleRow(terms, style) {
  if (!style || typeof style !== 'object') return null;
  const stored = style.term !== undefined;
  const shaped = styleShape(stored ? { ...style, term: rowOf(terms, style.term) } : style);
  return shaped.state === 'shaped' ? shaped.value : null;
}

// "GG" as a word of its own, or the tier written out, in a name or in the
// classification string ("VDP.Grosses Gewächs", "Saarfeilser GG"). The string
// is the wine's classification rows joined (the model's save hook writes it),
// so the rows themselves are not read.
const GG_ABBREVIATION = /(?:^|[^\p{L}\p{N}])GG(?![\p{L}\p{N}])/u;
const GG_WRITTEN = /gro(?:ss|ß)es\s+gew(?:ä|ae)chs/iu;
const statesGrossesGewaechs = (text) => typeof text === 'string' && (GG_ABBREVIATION.test(text) || GG_WRITTEN.test(text));

/** The place words a name word is checked against: appellation, region and producer, as text. */
function placesOf(wine) {
  const region = wine.region && typeof wine.region === 'object' && typeof wine.region.name === 'string' ? wine.region.name : null;
  return [wine.appellation, region, wine.producer].filter((p) => typeof p === 'string' && p.trim());
}

/**
 * The category of one wine and its basis: { category, basis }, or null when
 * the record states none. Synchronous, on a loaded term table. `wine` is a
 * plain copy loaded with CATEGORY_WINE_SELECT (or a document with the same
 * fields): a wine loaded without sweetnessInName reads its name as if the
 * mark were not set, which is why the surfaces go through
 * readSweetnessCategories rather than call this on their own wine. Called by
 * the loaders below and, through sweetnessFilterValue, by
 * services/bottleSearch.
 */
function sweetnessCategoryOf(wine, terms) {
  if (!wine || typeof wine !== 'object' || !terms) return null;
  const scale = scaleForType(wine.type, { nonWine: wine.nonWine === true });
  if (scale === false) return null;
  const countryId = idOf(wine.country) || null;

  const label = categoryOfRow(terms, rowOf(terms, wine.labelSweetness), scale, countryId);
  if (label) return { category: label, basis: 'label' };

  const sweetTier = sweetByLawPradikat({ name: wine.name, classification: wine.classification });

  if (scale && !terms.empty) {
    const read = extractLoaded(terms, wine.name, {
      scale, keep: wine.sweetnessInName === true, countryId, places: placesOf(wine),
    });
    const named = categoryOfRow(terms, read.term, scale, countryId);
    if (named && !(sweetTier && DRY_SIDE.has(named))) return { category: named, basis: 'name' };
  }

  const style = categoryOfRow(terms, styleRow(terms, wine.sweetnessStyle), scale, countryId);
  if (style) return { category: style, basis: 'style' };

  if (sweetTier) return { category: 'sweet', basis: 'tier' };
  if (statesGrossesGewaechs(wine.classification) || statesGrossesGewaechs(wine.name)) return { category: 'dry', basis: 'tier' };
  if (wine.type === 'dessert') return { category: 'sweet', basis: 'type' };
  return null;
}

/**
 * What a filter matches a wine on, and what a facet counts it under: its
 * category; "not-stated" for a wine that could state one and does not; '' for
 * a wine with no scale at all (fortified, not wine), which no sweetness
 * filter finds and no count includes. Called by services/bottleSearch for
 * its facet and by wineIdsMatching below.
 */
function sweetnessFilterValue(wine, terms) {
  if (!wine || typeof wine !== 'object' || !terms) return '';
  if (scaleForType(wine.type, { nonWine: wine.nonWine === true }) === false) return '';
  const read = sweetnessCategoryOf(wine, terms);
  return read ? read.category : NOT_STATED;
}

/**
 * The filter as a request's query carries it: one value, or the same key
 * repeated (a client that sends a list that way), joined. Anything else is no
 * value. Called by the routes that take ?sweetnessCategory (routes/cellars,
 * services/crossCellarQuery, services/bottleListQuery).
 */
function sweetnessQueryValue(raw) {
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw) && raw.length && raw.every((v) => typeof v === 'string')) return raw.join(',');
  return undefined;
}

/**
 * A filter value as a request sends it ("dry", "dry,off-dry", "not-stated")
 * → the set of values asked for, or null when the request sends none. Unknown
 * words are dropped, so a value made of them alone is an empty set and finds
 * nothing — as the maturity filter reads its own (utils/maturityUtils).
 * Called by services/bottleSearch and services/bottleListQuery.
 */
function parseSweetnessFilter(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  return new Set(value.split(',').map((v) => v.trim().toLowerCase()).filter((v) => FILTER_VALUES.includes(v)));
}

// What the reading needs of a wine: the terms as ids (the table names them)
// and the region's name for the place guard. services/bottleSearch adds its
// own fields to this list for its load.
const CATEGORY_WINE_SELECT = 'name producer appellation type nonWine country region classification labelSweetness sweetnessStyle sweetnessInName';

/**
 * The wines among `wineIds` as the reading needs them (lean), and the term
 * table — the wines first: the table answers an empty copy while the
 * connection is down, which would read as "no wine states anything".
 */
async function loadForReading(wineIds) {
  const ids = [...new Set((Array.isArray(wineIds) ? wineIds : []).map((id) => String(idOf(id))))].filter(isValidId);
  const wines = ids.length
    ? await WineDefinition.find({ _id: { $in: ids } }).select(CATEGORY_WINE_SELECT).populate('region', 'name').lean()
    : [];
  return { terms: await loadTerms(), wines };
}

/**
 * The reading of each wine among `wineIds`, in one query: a Map of wine id
 * (string) → { category, basis }, or null for a wine that states none. An id
 * that names no wine has no entry. Read by attachSweetnessCategories below,
 * by the analytics rows (services/analytics/queryEngine) and by the MCP wine
 * and bottle reads (get_wine, get_bottle, search_bottles).
 */
async function readSweetnessCategories(wineIds) {
  const { terms, wines } = await loadForReading(wineIds);
  return new Map(wines.map((wine) => [String(wine._id), sweetnessCategoryOf(wine, terms)]));
}

/**
 * Put sweetnessCategory and sweetnessCategoryBasis — both null when the
 * record states none — on the plain wine objects a read is about to send (a
 * lean read, a toObject() copy), and return what was passed. One query for
 * the whole page. A Mongoose document is left alone: it would not send the
 * keys. A failing read throws: for the answers that are kept and tagged (the
 * inventory, the offline copy), where a copy without the reading must not
 * stand for one that states none.
 */
async function attachSweetnessCategories(wines) {
  const plain = (Array.isArray(wines) ? wines : [wines])
    .filter((w) => w && typeof w === 'object' && w._id && !(w instanceof mongoose.Document));
  if (!plain.length) return wines;
  const readings = await readSweetnessCategories(plain.map((w) => w._id));
  for (const wine of plain) {
    const read = readings.get(String(wine._id)) || null;
    wine.sweetnessCategory = read ? read.category : null;
    wine.sweetnessCategoryBasis = read ? read.basis : null;
  }
  return wines;
}

/**
 * The same for a page a member is looking at (the bottle list, a bottle, a
 * wine, the vintage page): a failing read is logged and the wines go out
 * WITHOUT the two keys — never null, which says "states none" — so the page
 * still opens. `surface` names the caller in the log.
 */
async function attachSweetnessCategoriesIfReadable(wines, surface) {
  try {
    return await attachSweetnessCategories(wines);
  } catch (err) {
    logger.warn({ err, surface }, 'sweetness category: the read failed; the answer goes out without it');
    return wines;
  }
}

/**
 * The ids, among `wineIds`, of the wines a filter asks for — for a list that
 * narrows by wine before it pages (services/bottleListQuery, and the MCP
 * search_bottles list path).
 */
async function wineIdsMatching(wineIds, asked) {
  if (!asked || !asked.size) return [];
  const { terms, wines } = await loadForReading(wineIds);
  return wines.filter((wine) => asked.has(sweetnessFilterValue(wine, terms))).map((wine) => wine._id);
}

module.exports = {
  CATEGORIES, BASES, NOT_STATED, FILTER_VALUES, BAND_CATEGORY, CATEGORY_WINE_SELECT,
  sweetnessCategoryOf, sweetnessFilterValue, sweetnessQueryValue, parseSweetnessFilter,
  readSweetnessCategories, attachSweetnessCategories, attachSweetnessCategoriesIfReadable, wineIdsMatching,
};
