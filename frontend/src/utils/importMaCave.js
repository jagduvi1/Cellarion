import { normalizeBottleSize } from '../config/bottleSizes';
import { normHeader, parseLocaleNumber, mapWineType, vintageOrNV, looksNonWine } from './importFields';
import { stripProducerPrefix, splitClassificationFromName } from './importNames';
import { buildPlocDateParser } from './importPloc';
import { startPhotoLinks, photoRefFor } from './importPhotoLinks';

// ─── Ma Cave à Vins ──────────────────────────────────────────────────────────
//
// Ma Cave à Vins ("My wines cellar" in English) exports one flat file, one row
// per wine with its bottle count, separated by ";". The column NAMES follow the
// language the app runs in. The German export is the one known so far; another
// language joins by adding its names to MA_CAVE_COLUMNS, and is recognised by
// the same fields.
//
// Every empty cell is written "-". Sizes are litres with a decimal comma
// ("0,75"), dates day first ("24-09-2026").
//
// Not imported: the market value and the two totals (a bottle has no value
// field, and the totals follow from price × count), the alcohol content (the
// import has no ABV field), and the consumed count, which carries no date to
// file a drunk bottle under. A file with consumed counts, or with wines that
// have no bottle left, says so in a notice instead of losing them unseen.
//
// The photo column links each wine to the photo its owner took in the app. The
// link stays in this browser (utils/importPhotoLinks): the row carries a
// reference to it, and the link goes to the server with the import only when
// the owner ticks "bring in the photos" on the upload or review step; the
// server then copies the photo in (backend services/importPhotos), from that
// app's photo store only.
//
// utils/importMappers.js re-exports the public names.

/** Header names per field, in every language seen; compared as headerKey reads them. */
const MA_CAVE_COLUMNS = {
  name: ['Name'],
  category: ['Kategorie'],
  vintage: ['Jahrgang'],
  country: ['Land'],
  region: ['Region'],
  subregion: ['Unterregion'],
  appellation: ['Appellation'],
  producer: ['Winzer / Weingut'],
  location: ['Standort'],
  price: ['Kaufpreis'],
  currency: ['Währung'],
  quantity: ['Menge'],
  size: ['Kapazität'],
  consumed: ['Konsumiert'],
  rating: ['Bewertung (/5)'],
  keeping: ['Lagerung'],
  grapes: ['Rebsorten'],
  pairings: ['Speise- und Weinpaarungen'],
  comment: ['Kommentar'],
  added: ['Hinzufügedatum'],
  photo: ['Foto'],
};

// The columns no other export has together. A file is this app's when every
// one of them is there in one language.
const FINGERPRINT = ['producer', 'vintage', 'quantity', 'size', 'consumed', 'added'];

// The words of the category column, matched word by word, style before
// colour: "Schaumwein rosé" is a sparkling wine. English words fall through
// to the shared mapWineType.
const SPARKLING = ['schaumwein', 'sekt', 'perlwein', 'crémant', 'cremant', 'champagner', 'spumante', 'prosecco', 'cava'];
const DESSERT = ['süßwein', 'süsswein', 'suesswein', 'dessertwein', 'edelsüß', 'edelsüss', 'süß', 'süss', 'eiswein', 'beerenauslese', 'trockenbeerenauslese'];
const FORTIFIED = ['likörwein', 'likoerwein', 'portwein', 'sherry', 'madeira', 'marsala'];
const ROSE = ['rosé', 'rose', 'roséwein', 'rosewein', 'weißherbst', 'weissherbst', 'rotling'];
const WHITE = ['weiß', 'weiss', 'weißwein', 'weisswein'];
const RED = ['rot', 'rotwein'];
// Not a wine at all: such a row is flagged, never given a wine colour.
const NOT_WINE = ['spirituose', 'spirituosen', 'schnaps', 'weinbrand', 'obstbrand', 'likör', 'likoer', 'wodka', 'bier', 'grappa'];

const CURRENCY_SYMBOLS = { '€': 'EUR', '£': 'GBP' };

// "-" and the other dashes a spreadsheet may turn it into.
const DASH_ONLY = /^[-–—−]+$/;

// A file saved on a Mac may write "ä" as "a" plus a combining mark, and a
// re-typed header may drop the spaces around the "/" of "Winzer / Weingut".
const headerKey = (h) => normHeader(String(h).normalize('NFC')).replace(/ ?\/ ?/g, '/');

/** The header each field has in this file (its own spelling), or undefined. */
function resolveColumns(headers) {
  const byNorm = new Map((headers || []).map((h) => [headerKey(h), h]));
  const columns = {};
  for (const [field, names] of Object.entries(MA_CAVE_COLUMNS)) {
    const hit = names.map(headerKey).find((n) => byNorm.has(n));
    if (hit) columns[field] = byNorm.get(hit);
  }
  return columns;
}

/** One cell of a row by field, "" for a missing column or an empty ("-") cell. */
function cellReader(columns) {
  return (row, field) => {
    const header = columns[field];
    const value = header ? String(row[header] ?? '').trim() : '';
    return DASH_ONLY.test(value) ? '' : value;
  };
}

/** True when the headers are a Ma Cave à Vins export, in any language listed above. */
export function detectMaCaveFile(headers) {
  const columns = resolveColumns(headers);
  return FINGERPRINT.every((field) => columns[field]);
}

function currencyCode(value) {
  if (/^[A-Za-z]{3}$/.test(value)) return value.toUpperCase();
  return CURRENCY_SYMBOLS[value] || undefined;
}

/** { type, nonWine } for a category cell; type null when it states no wine colour. */
function categoryOf(value) {
  if (!value) return { type: null, nonWine: false };
  const words = value.normalize('NFC').toLowerCase().split(/[^\p{L}]+/u).filter(Boolean);
  const has = (list) => words.some((w) => list.includes(w));
  if (has(NOT_WINE) || looksNonWine(value)) return { type: null, nonWine: true };
  if (has(SPARKLING)) return { type: 'sparkling', nonWine: false };
  if (has(DESSERT)) return { type: 'dessert', nonWine: false };
  if (has(FORTIFIED)) return { type: 'fortified', nonWine: false };
  if (has(ROSE)) return { type: 'rosé', nonWine: false };
  if (has(WHITE)) return { type: 'white', nonWine: false };
  if (has(RED)) return { type: 'red', nonWine: false };
  return { type: mapWineType(value), nonWine: false };
}

// "100% Riesling", "Cabernet Sauvignon 60%, Merlot 40%", "Grenache/Syrah":
// the varieties, without the blend shares the registry does not store.
function grapesOf(value) {
  return String(value || '')
    .split(/[,;/]/)
    .map((g) => g.replace(/^\s*\d+(?:[.,]\d+)?\s*%\s*/, '').replace(/\s*\d+(?:[.,]\d+)?\s*%\s*$/, '').trim())
    .filter(Boolean);
}

// Compared without case or accents.
const plain = (s) => s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').trim();

// The app's appellation field is free text, and an owner may type the estate
// into it. An appellation that IS the producer is not a place, so the
// sub-region stands in.
function appellationOf(appellation, subregion, producer) {
  if (appellation && producer && plain(appellation) === plain(producer)) return subregion;
  return appellation || subregion;
}

// The name as the app shows it often starts with the producer ("Muster
// Riesling Sekt"). Taken off only where a word ends: at a space, ":" or ",",
// or a dash with a space after it. A hyphen inside a name joins it: producer
// "Müller" leaves "Müller-Thurgau trocken" whole, and "Muster" leaves
// "Musterhof Riesling".
function nameWithoutProducer(name, producer) {
  if (!producer || name.length <= producer.length) return name;
  if (!/^(?:\s|[:,]|[-–—]\s)/.test(name.slice(producer.length))) return name;
  return stripProducerPrefix(name, producer);
}

// The bottles still in the cellar. A count is taken as written; an empty
// count ("-") is none left when the consumed column has a number (the wine
// was drunk up), and otherwise one bottle, the row itself.
function stockOf(cell, row) {
  const quantity = parseInt(cell(row, 'quantity'), 10);
  if (!isNaN(quantity)) return Math.max(0, quantity);
  const consumed = parseInt(cell(row, 'consumed'), 10);
  return consumed > 0 ? 0 : 1;
}

/**
 * A row mapper for one Ma Cave à Vins file, in the master import format of
 * utils/importMappers.js. Built from all the rows because the date order is
 * read from the whole column (see buildPlocDateParser), and it starts the
 * file's set of photo links (utils/importPhotoLinks). parseAndMap calls it;
 * quantity is expanded there.
 *
 * @returns {(row: object) => object}
 */
export function makeMaCaveMapper(rows) {
  const columns = resolveColumns(rows.length > 0 ? Object.keys(rows[0]) : []);
  const cell = cellReader(columns);
  const dates = buildPlocDateParser(rows.map((r) => cell(r, 'added')));
  startPhotoLinks();

  return (row) => {
    const producer = cell(row, 'producer');
    const appellation = appellationOf(cell(row, 'appellation'), cell(row, 'subregion'), producer);
    const region = cell(row, 'region');
    const { wineName, classification } = splitClassificationFromName(
      nameWithoutProducer(cell(row, 'name'), producer), { producer, appellation, region });

    const price = parseLocaleNumber(cell(row, 'price'));
    const rating = parseLocaleNumber(cell(row, 'rating'));
    const { type, nonWine } = categoryOf(cell(row, 'category'));
    // The owner's own words, kept whole. The pairing and keeping columns have
    // no field of their own, so they join the note under the file's own header.
    const labelled = (field) => (cell(row, field) ? `${columns[field]}: ${cell(row, field)}` : '');
    const notes = [cell(row, 'comment'), labelled('pairings'), labelled('keeping')].filter(Boolean).join('\n');
    const photo = cell(row, 'photo');

    return {
      wineName,
      producer,
      classification,
      ...vintageOrNV(cell(row, 'vintage')),
      country: cell(row, 'country'),
      region,
      appellation,
      type,
      ...(nonWine ? { nonWineHint: true } : {}),
      grapes: grapesOf(cell(row, 'grapes')),
      price: isNaN(price) ? undefined : price,
      currency: currencyCode(cell(row, 'currency')),
      bottleSize: normalizeBottleSize(cell(row, 'size')) || '750ml',
      // Stock: a wine with nothing left in the cellar comes in as no bottle.
      quantity: stockOf(cell, row),
      location: cell(row, 'location'),
      notes,
      ...(rating > 0 ? { rating, ratingScale: '5' } : {}),
      dateAdded: dates.parse(cell(row, 'added')),
      photoRef: photo ? photoRefFor(photo) : undefined,
    };
  };
}

/**
 * The notices a Ma Cave à Vins file needs beyond the shared ones, which
 * parseAndMap adds to its warnings, from the file's rows and the items they
 * became:
 *   macave-consumed-not-imported  rows whose consumed column is filled (those
 *                                 bottles are not added to the drinking history);
 *   macave-none-left              wines with no bottle left, which come in as
 *                                 no bottle;
 *   macave-photos                 how many photos the bottles to import link to
 *                                 on an allowed store, with the owner's choice
 *                                 to bring them in (`include`), unticked until
 *                                 they tick it (utils/importPayload
 *                                 applyImportPhotoChoice).
 *
 * @returns {object[]}
 */
export function maCaveWarnings(rows, items = []) {
  const columns = resolveColumns(rows.length > 0 ? Object.keys(rows[0]) : []);
  const cell = cellReader(columns);
  const warnings = [];
  if (columns.consumed) {
    const filled = rows.filter((r) => { const v = cell(r, 'consumed'); return v !== '' && v !== '0'; }).length;
    if (filled > 0) warnings.push({ code: 'macave-consumed-not-imported', count: filled, column: columns.consumed });
  }
  const noneLeft = rows.filter((r) => stockOf(cell, r) === 0).length;
  if (noneLeft > 0) warnings.push({ code: 'macave-none-left', count: noneLeft });
  const photos = new Set(items.map((it) => it.photoRef).filter(Boolean)).size;
  if (photos > 0) warnings.push({ code: 'macave-photos', count: photos, include: false });
  return warnings;
}

/**
 * The notices of a draft being resumed: its photo links were never saved (they
 * stay in the browser that read the file), so the photo box becomes a line
 * saying the photos need the file again. Called by pages/ImportBottles when a
 * saved import is restored.
 */
export function resumedImportWarnings(warnings) {
  return (warnings || []).map((w) => (w && w.code === 'macave-photos'
    ? { code: 'macave-photos-need-file', count: w.count }
    : w));
}
