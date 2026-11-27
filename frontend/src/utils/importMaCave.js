import { normalizeBottleSize } from '../config/bottleSizes';
import { normHeader, parseLocaleNumber, mapWineType, vintageOrNV } from './importFields';
import { stripProducerPrefix, splitClassificationFromName } from './importNames';
import { parsePlocGrapes, buildPlocDateParser } from './importPloc';

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
// file a drunk bottle under. A file with consumed counts says so in a warning
// instead of losing them unseen.
//
// The photo column links each wine to the photo its owner took in the app.
// When the owner ticks "bring in the photos" on the review step, the link goes
// to the server as it is: the server copies the photo in after the import
// (backend services/importPhotos), from that app's photo store only.
//
// utils/importMappers.js re-exports the public names.

/** Header names per field, in every language seen; compared in normHeader form. */
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

/** "Rot" → red. Values the shared mapWineType does not read; it reads the English ones. */
const CATEGORY_TO_TYPE = {
  rot: 'red', rotwein: 'red',
  'weiß': 'white', weiss: 'white', 'weißwein': 'white', weisswein: 'white',
  'rosé': 'rosé', rose: 'rosé', 'roséwein': 'rosé',
  schaumwein: 'sparkling', sekt: 'sparkling', perlwein: 'sparkling', 'crémant': 'sparkling',
  'süßwein': 'dessert', suesswein: 'dessert', dessertwein: 'dessert', 'edelsüß': 'dessert',
  'likörwein': 'fortified', likoerwein: 'fortified',
};

const CURRENCY_SYMBOLS = { '€': 'EUR', '£': 'GBP' };

const DASH_ONLY = /^[-\u2013\u2014\u2212]+$/;

// A file saved on a Mac may write "ä" as "a" plus a combining mark.
const headerKey = (h) => normHeader(String(h).normalize('NFC'));

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

/** True when the headers are a Ma Cave à Vins export, in any language listed above. */
export function detectMaCaveFile(headers) {
  const columns = resolveColumns(headers);
  return FINGERPRINT.every((field) => columns[field]);
}

function currencyCode(value) {
  if (/^[A-Za-z]{3}$/.test(value)) return value.toUpperCase();
  return CURRENCY_SYMBOLS[value] || undefined;
}

function wineType(value) {
  const key = value.normalize('NFC').toLowerCase();
  return CATEGORY_TO_TYPE[key] || mapWineType(value);
}

// Compared without case or accents.
const plain = (s) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();

// The app's appellation field is free text, and an owner may type the estate
// into it. An appellation that IS the producer is not a place, so the
// sub-region stands in.
function appellationOf(appellation, subregion, producer) {
  if (appellation && producer && plain(appellation) === plain(producer)) return subregion;
  return appellation || subregion;
}

// The name as the app shows it often starts with the producer ("Muster
// Riesling Sekt"). Taken off only at a word's end, so a producer "Muster" does
// not cut "Musterhof Riesling" to "hof Riesling".
function nameWithoutProducer(name, producer) {
  if (!producer || name.length <= producer.length) return name;
  if (!/[\s\-–—:,]/.test(name[producer.length])) return name;
  return stripProducerPrefix(name, producer);
}

/**
 * A row mapper for one Ma Cave à Vins file, in the master import format of
 * utils/importMappers.js. Built from all the rows because the date order is
 * read from the whole column (see buildPlocDateParser). parseAndMap calls it;
 * quantity is expanded there.
 *
 * @returns {(row: object) => object}
 */
export function makeMaCaveMapper(rows) {
  const columns = resolveColumns(rows.length > 0 ? Object.keys(rows[0]) : []);
  const cell = (row, field) => {
    const header = columns[field];
    const value = header ? String(row[header] ?? '').trim() : '';
    return DASH_ONLY.test(value) ? '' : value;
  };
  const dates = buildPlocDateParser(rows.map((r) => cell(r, 'added')));

  return (row) => {
    const producer = cell(row, 'producer');
    const appellation = appellationOf(cell(row, 'appellation'), cell(row, 'subregion'), producer);
    const region = cell(row, 'region');
    const { wineName, classification } = splitClassificationFromName(
      nameWithoutProducer(cell(row, 'name'), producer), { producer, appellation, region });

    const price = parseLocaleNumber(cell(row, 'price'));
    const rating = parseLocaleNumber(cell(row, 'rating'));
    const quantity = parseInt(cell(row, 'quantity'), 10);
    // The owner's own words, kept whole. The pairing and keeping columns have
    // no field of their own, so they join the note under the file's own header.
    const labelled = (field) => (cell(row, field) ? `${columns[field]}: ${cell(row, field)}` : '');
    const notes = [cell(row, 'comment'), labelled('pairings'), labelled('keeping')].filter(Boolean).join('\n');

    return {
      wineName,
      producer,
      classification,
      ...vintageOrNV(cell(row, 'vintage')),
      country: cell(row, 'country'),
      region,
      appellation,
      type: cell(row, 'category') ? wineType(cell(row, 'category')) : null,
      grapes: parsePlocGrapes(cell(row, 'grapes')),
      price: isNaN(price) ? undefined : price,
      currency: currencyCode(cell(row, 'currency')),
      bottleSize: normalizeBottleSize(cell(row, 'size')) || '750ml',
      // Stock: a wine with nothing left in the cellar comes in as no bottle.
      quantity: isNaN(quantity) ? 1 : Math.max(0, quantity),
      location: cell(row, 'location'),
      notes,
      ...(rating > 0 ? { rating, ratingScale: '5' } : {}),
      dateAdded: dates.parse(cell(row, 'added')),
      photoUrl: cell(row, 'photo') || undefined,
    };
  };
}

/**
 * The notices a Ma Cave à Vins file needs beyond the shared ones, which
 * parseAndMap adds to its warnings:
 *   macave-consumed-not-imported  rows whose consumed column is filled (those
 *                                 bottles are not added to the drinking history);
 *   macave-photos                 how many photos the file links to, with the
 *                                 owner's choice to bring them in (`include`).
 *                                 Unticked until the owner ticks it: a photo is
 *                                 copied only because they asked for it
 *                                 (utils/importPayload applyImportPhotoChoice).
 *
 * @returns {object[]}
 */
export function maCaveWarnings(rows) {
  const columns = resolveColumns(rows.length > 0 ? Object.keys(rows[0]) : []);
  const cellOf = (r, header) => {
    const v = String(r[header] ?? '').trim();
    return DASH_ONLY.test(v) ? '' : v;
  };
  const warnings = [];
  if (columns.consumed) {
    const filled = rows.filter((r) => { const v = cellOf(r, columns.consumed); return v !== '' && v !== '0'; }).length;
    if (filled > 0) warnings.push({ code: 'macave-consumed-not-imported', count: filled, column: columns.consumed });
  }
  if (columns.photo) {
    const photos = new Set(rows.map((r) => cellOf(r, columns.photo)).filter(Boolean)).size;
    if (photos > 0) warnings.push({ code: 'macave-photos', count: photos, include: false });
  }
  return warnings;
}
