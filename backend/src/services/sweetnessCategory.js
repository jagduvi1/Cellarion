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
 *          trocken", "Brut Réserve"), read as the style rule reads it
 *          (services/sweetnessWrite nameTerms): a word the reader doubts is
 *          no statement, and a name that states two categories states none;
 *   style  the term the wine is known by (sweetnessStyle);
 *   tier   a tier that is sweet by law (Beerenauslese, Eiswein …) is sweet,
 *          and a Grosses Gewächs is dry by the VDP's own rule;
 *   type   a wine typed "dessert" is sweet.
 * Nothing else is guessed: a Kabinett, Spätlese or Auslese without a term is
 * not stated (null), and so is every fortified wine and every drink that is
 * not wine — they have no scale.
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
 * the wine and bottle reads (routes/bottles, routes/wines), the inventory
 * (services/integrationInventory), the offline copy (services/offlineSnapshot)
 * and the MCP wine and bottle reads (mcp/tools/wines, mcp/tools/bottles).
 */
const mongoose = require('mongoose');
const WineDefinition = require('../models/WineDefinition');
const { loadTerms, scaleForType } = require('./sweetnessOps');
const { nameTerms } = require('./sweetnessWrite');
const { sweetByLawPradikat } = require('../utils/styleTerms');

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

const ID_RX = /^[0-9a-f]{24}$/i;
const idOf = (v) => (v && typeof v === 'object' && v._id ? v._id : v);

/** A term a wine refers to — a populated row, or an id looked up in the table — or null. */
function rowOf(terms, ref) {
  if (ref == null) return null;
  if (typeof ref === 'object' && typeof ref.band === 'string') return ref;
  return terms.byId.get(String(idOf(ref))) || null;
}

/** The band of a style, stored ({ term, source, url }) or as a read sends it ({ name, band, … }). */
function styleBand(terms, style) {
  if (!style || typeof style !== 'object') return null;
  if (typeof style.band === 'string') return style.band;
  const row = rowOf(terms, style.term);
  return row ? row.band : null;
}

// "GG" as a word of its own, or the tier written out, in a name or a
// classification ("VDP.Grosses Gewächs", "Saarfeilser GG").
const GG_ABBREVIATION = /(?:^|[^\p{L}\p{N}])GG(?![\p{L}\p{N}])/u;
const GG_WRITTEN = /gro(?:ss|ß)es\s+gew(?:ä|ae)chs/iu;
const statesGrossesGewaechs = (text) => typeof text === 'string' && (GG_ABBREVIATION.test(text) || GG_WRITTEN.test(text));
function isGrossesGewaechs(wine) {
  if (statesGrossesGewaechs(wine.classification) || statesGrossesGewaechs(wine.name)) return true;
  return (Array.isArray(wine.classifications) ? wine.classifications : [])
    .some((row) => row && typeof row === 'object' && statesGrossesGewaechs(row.name));
}

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
 * readSweetnessCategories rather than call this on their own wine.
 */
function sweetnessCategoryOf(wine, terms) {
  if (!wine || typeof wine !== 'object' || !terms) return null;
  const scale = scaleForType(wine.type, { nonWine: wine.nonWine === true });
  if (scale === false) return null;
  const from = (band, basis) => (BAND_CATEGORY[band] ? { category: BAND_CATEGORY[band], basis } : null);

  const label = rowOf(terms, wine.labelSweetness);
  if (label) return from(label.band, 'label');

  if (scale && !terms.empty) {
    const stated = nameTerms(terms, wine.name, {
      scale, keep: wine.sweetnessInName === true, countryId: idOf(wine.country) || null, places: placesOf(wine),
    }).filter((hit) => !hit.doubt && hit.row && BAND_CATEGORY[hit.row.band]);
    const categories = new Set(stated.map((hit) => BAND_CATEGORY[hit.row.band]));
    if (categories.size === 1) return { category: [...categories][0], basis: 'name' };
    // Two categories in one name: the name states none, and nothing weaker may speak for it.
    if (categories.size > 1) return null;
  }

  const style = styleBand(terms, wine.sweetnessStyle);
  if (style) return from(style, 'style');

  if (sweetByLawPradikat({ name: wine.name, classifications: wine.classifications, classification: wine.classification })) {
    return { category: 'sweet', basis: 'tier' };
  }
  if (isGrossesGewaechs(wine)) return { category: 'dry', basis: 'tier' };
  if (wine.type === 'dessert') return { category: 'sweet', basis: 'type' };
  return null;
}

/**
 * What a filter matches a wine on, and what a facet counts it under: its
 * category; "not-stated" for a wine that could state one and does not; '' for
 * a wine with no scale at all (fortified, not wine), which no sweetness
 * filter finds and no count includes.
 */
function sweetnessFilterValue(wine, terms) {
  if (!wine || typeof wine !== 'object' || !terms) return '';
  if (scaleForType(wine.type, { nonWine: wine.nonWine === true }) === false) return '';
  const read = sweetnessCategoryOf(wine, terms);
  return read ? read.category : NOT_STATED;
}

/**
 * A filter value as a request sends it ("dry", "dry,off-dry", "not-stated")
 * → the set of values asked for, or null when the request sends none. Unknown
 * words are dropped, so a value made of them alone is an empty set and finds
 * nothing — as the maturity filter reads its own (utils/maturityUtils).
 */
function parseSweetnessFilter(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  return new Set(value.split(',').map((v) => v.trim().toLowerCase()).filter((v) => FILTER_VALUES.includes(v)));
}

// What the reading needs of a wine: the terms as ids (the table names them)
// and the region's name for the place guard. services/bottleSearch loads the
// same fields in its own select.
const CATEGORY_WINE_SELECT = 'name producer appellation type nonWine country region classification labelSweetness sweetnessStyle sweetnessInName';

/** The wines among `wineIds` as the reading needs them (lean), and the term table. */
async function loadForReading(wineIds) {
  const ids = [...new Set((Array.isArray(wineIds) ? wineIds : []).map((id) => String(idOf(id))))].filter((id) => ID_RX.test(id));
  const [terms, wines] = await Promise.all([
    loadTerms(),
    ids.length
      ? WineDefinition.find({ _id: { $in: ids } }).select(CATEGORY_WINE_SELECT).populate('region', 'name').lean()
      : [],
  ]);
  return { terms, wines };
}

/**
 * The reading of each wine among `wineIds`, in one query: a Map of wine id
 * (string) → { category, basis }, or null for a wine that states none. An id
 * that names no wine has no entry. Read by attachSweetnessCategories below
 * and by the MCP wine and bottle reads (get_wine, get_bottle, search_bottles).
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
 * keys. Called by GET /api/bottles and /:id, GET /api/wines/:id, the
 * inventory and the offline copy; no MCP tool (those read the Map above).
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
 * The ids, among `wineIds`, of the wines a filter asks for — for a list that
 * narrows by wine before it pages (services/bottleListQuery).
 */
async function wineIdsMatching(wineIds, asked) {
  if (!asked || !asked.size) return [];
  const { terms, wines } = await loadForReading(wineIds);
  return wines.filter((wine) => asked.has(sweetnessFilterValue(wine, terms))).map((wine) => wine._id);
}

module.exports = {
  CATEGORIES, BASES, NOT_STATED, FILTER_VALUES, BAND_CATEGORY, CATEGORY_WINE_SELECT,
  sweetnessCategoryOf, sweetnessFilterValue, parseSweetnessFilter,
  readSweetnessCategories, attachSweetnessCategories, wineIdsMatching,
};
