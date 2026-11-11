import { parseLocaleNumber, vintageOrNV } from './importFields';
import { parseCSV, detectDelimiter } from './importCsv';

// ─── Ploc ────────────────────────────────────────────────────────────────────
//
// Ploc (a French cellar app) does not export one file. It exports a SET that
// only means anything together, joined on the wine's GUID:
//
//   Vins.csv           one row per WINE  — identity, stock count, apogee, value
//   Caves.csv          one row per SLOT  — storage-unit name, row, column
//   Achats-Consos.csv  one row per MOVE  — date, bought/drunk counts, unit price
//   Producteurs.csv    the producer address book — deliberately NOT imported;
//                      it is other people's contact details, and the producer
//                      name we need is already on every wine row.
//
// The file NAMES are French whatever language the app runs in, and users rename
// them anyway (to "Wines_sample.csv" and "cellars_sample.csv", say), so each
// file is recognised by its COLUMNS instead.
// `IdVin` appears in all three and is the join key — written in mixed case from
// row to row, so it is always compared lower-cased.
//
// What Ploc gives us that a flat CSV cannot:
//   - exact slot positions (name + row + column), so no bin-code guessing
//   - real stock counts per wine, expanded into individual bottles
//   - purchase and consumption history with dates and prices, so a migrating
//     user keeps what they have drunk, not just what they still hold
//
// Not imported: "Degree of alcohol" (the import pipeline has no ABV field),
// "Service temperature", "Tags", "Reference", "IdContact" and the producer
// address book.
//
// utils/importMappers.js re-exports the public names.

/** All three Ploc files carry this column; it is the join key. */
const PLOC_JOIN_KEY = 'idvin';

const PLOC_COLOUR_TO_TYPE = {
  red: 'red', rouge: 'red',
  white: 'white', blanc: 'white',
  'rosé': 'rosé', rose: 'rosé',
  sparkling: 'sparkling', effervescent: 'sparkling', 'pétillant': 'sparkling', petillant: 'sparkling',
  sweet: 'dessert', liquoreux: 'dessert', moelleux: 'dessert',
  fortified: 'fortified', 'fortifié': 'fortified', fortifie: 'fortified', muté: 'fortified', mute: 'fortified',
};

const PLOC_FORMAT_TO_SIZE = {
  bottle: '750ml', bouteille: '750ml',
  magnum: '1500ml',
  half: '375ml', demi: '375ml', 'demi-bouteille': '375ml', 'half bottle': '375ml',
  jeroboam: '3000ml', 'double magnum': '3000ml', 'double-magnum': '3000ml',
  rehoboam: '4500ml', 'réhoboam': '4500ml',
  mathusalem: '6000ml', methuselah: '6000ml', imperial: '6000ml', 'impériale': '6000ml',
  salmanazar: '9000ml',
};

/** Ploc writes a currency SYMBOL, not a code. */
const PLOC_CURRENCY_SYMBOLS = {
  '$': 'USD', 'us$': 'USD', 'usd': 'USD',
  '€': 'EUR', 'eur': 'EUR',
  '£': 'GBP', 'gbp': 'GBP',
  'kr': 'SEK', 'sek': 'SEK',
  'chf': 'CHF', 'fr.': 'CHF',
  '¥': 'JPY', 'jpy': 'JPY',
  'ca$': 'CAD', 'cad': 'CAD',
  'a$': 'AUD', 'aud': 'AUD',
};

/**
 * Which of Ploc's files this is, by its columns — never by its name.
 * @returns {'wines'|'cellars'|'history'|null}
 */
export function detectPlocFile(headers) {
  const h = new Set((headers || []).map((s) => String(s).toLowerCase().trim()));
  if (!h.has(PLOC_JOIN_KEY)) return null;
  if ((h.has('row') && h.has('column')) || (h.has('ligne') && h.has('colonne'))) return 'cellars';
  if ((h.has('purchase') && h.has('consumption')) || (h.has('achat') && h.has('conso'))) return 'history';
  if (h.has('stock') || h.has('producer') || h.has('producteur')) return 'wines';
  return null;
}

/** Case-insensitive column read across the English/French header variants. */
function plocGet(row, names) {
  for (const n of names) {
    if (row[n] !== undefined && String(row[n]).trim() !== '') return String(row[n]).trim();
  }
  // Fall back to a case-insensitive sweep — Ploc's capitalisation varies.
  const lower = {};
  for (const k of Object.keys(row)) lower[k.toLowerCase().trim()] = row[k];
  for (const n of names) {
    const v = lower[n.toLowerCase()];
    if (v !== undefined && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

/** The join key, normalised. Ploc writes the same GUID in mixed case. */
function plocId(row) {
  return plocGet(row, ['IdVin', 'idvin']).toLowerCase();
}

/**
 * "80% Cabernet Sauvignon,18% Merlot,2% Cabernet Franc" → the three varieties.
 * The percentages are Ploc's blend proportions; the registry stores varieties,
 * not proportions, and a grape called "80% Merlot" would never match.
 */
export function parsePlocGrapes(value) {
  return String(value || '')
    .split(/[,;]/)
    .map((g) => g.replace(/^\s*\d+(?:[.,]\d+)?\s*%\s*/, '').trim())
    .filter(Boolean);
}

/**
 * Ploc's "Apogee" is the drinking window, written "2030/2035" (and sometimes as
 * a single year, or with a dash). Maps to the BOTTLE's own window — never to
 * the shared registry's curated maturity, which is a sommelier's judgement.
 */
export function parsePlocApogee(value) {
  const years = String(value || '').match(/\d{4}/g);
  if (!years || years.length === 0) return {};
  const from = parseInt(years[0], 10);
  const to = years[1] ? parseInt(years[1], 10) : undefined;
  if (!Number.isFinite(from)) return {};
  return to && to >= from ? { drinkFrom: from, drinkTo: to } : { drinkFrom: from };
}

/**
 * Build a date parser for one Ploc export.
 *
 * Ploc's raw date format is not documented and varies with the exporting
 * device's locale, so "03/09/2026" is genuinely ambiguous on its own. Rather
 * than guess per row, this reads the WHOLE column first: any row where one
 * component exceeds 12 can only be read one way, and that settles the order for
 * every ambiguous row in the same file. With no such row anywhere it falls back
 * to day-first, which is what a French app writes.
 *
 * Also accepts ISO (unambiguous) and Unix seconds (what Ploc's own database
 * stores), so a hand-made export still lands correctly.
 *
 * @returns {{ parse: (v:*) => string|undefined, dayFirst: boolean, inferred: boolean }}
 *   `parse` returns an ISO yyyy-mm-dd string, or undefined when unreadable.
 */
export function buildPlocDateParser(samples) {
  let dayFirst = true;   // a French app's default
  let inferred = false;

  for (const raw of samples || []) {
    const m = /^(\d{1,4})[/\-.](\d{1,2})[/\-.](\d{1,4})$/.exec(String(raw || '').trim());
    if (!m || m[1].length === 4) continue; // ISO carries its own order
    const a = parseInt(m[1], 10);
    const b = parseInt(m[2], 10);
    if (a > 12 && b <= 12) { dayFirst = true; inferred = true; break; }
    if (b > 12 && a <= 12) { dayFirst = false; inferred = true; break; }
  }

  const iso = (y, mo, d) => {
    if (!(y >= 1900 && y <= 2200) || !(mo >= 1 && mo <= 12) || !(d >= 1 && d <= 31)) return undefined;
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  };

  return {
    dayFirst,
    inferred,
    parse(value) {
      const s = String(value ?? '').trim();
      if (!s) return undefined;

      // Unix seconds (Ploc's internal storage) — bounded to a sane era so a
      // bare year like "2026" is never read as an epoch.
      if (/^\d{9,11}$/.test(s)) {
        const d = new Date(parseInt(s, 10) * 1000);
        return Number.isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10);
      }

      const isoM = /^(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})/.exec(s);
      if (isoM) return iso(+isoM[1], +isoM[2], +isoM[3]);

      const m = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})/.exec(s);
      if (!m) return undefined;
      let year = parseInt(m[3], 10);
      if (m[3].length === 2) year += year < 70 ? 2000 : 1900;
      const a = parseInt(m[1], 10);
      const b = parseInt(m[2], 10);
      // A component over 12 overrides the file-level order for this row.
      if (a > 12) return iso(year, b, a);
      if (b > 12) return iso(year, a, b);
      return dayFirst ? iso(year, b, a) : iso(year, a, b);
    },
  };
}

/**
 * Ploc's "Note" is the owner's own score, and the file never says on what
 * scale. Infer it from the values present: nothing above 5 is a 5-star scale,
 * nothing above 20 is the French /20, anything higher is /100. The caller
 * surfaces the assumption as a warning so the owner can correct it rather than
 * discover a wrong rating later.
 *
 * @returns {'5'|'20'|'100'|null} null when the file carries no ratings at all
 */
export function inferPlocRatingScale(values) {
  const nums = (values || [])
    .map((v) => parseLocaleNumber(v))
    .filter((n) => typeof n === 'number' && Number.isFinite(n) && n > 0);
  if (nums.length === 0) return null;
  const max = Math.max(...nums);
  if (max <= 5) return '5';
  if (max <= 20) return '20';
  return '100';
}

/** "$" → "USD". Returns undefined for anything unrecognised, so the account default applies. */
function plocCurrency(value) {
  const s = String(value || '').trim();
  if (!s) return undefined;
  if (/^[A-Za-z]{3}$/.test(s)) return s.toUpperCase();
  return PLOC_CURRENCY_SYMBOLS[s.toLowerCase()] || undefined;
}

/**
 * Parse a Ploc export — one, two or three of its files — into master-format
 * items, joined on IdVin.
 *
 * @param {{wines?: string, cellars?: string, history?: string}} texts raw file text
 * @returns {{ items: object[], format: 'ploc', headers: string[],
 *             rackSpecs: object, warnings: object[] }}
 *   `rackSpecs` is the exact geometry of each storage unit, keyed by rack name,
 *   taken from the highest row and column actually used — so the review screen
 *   offers the real shape instead of a guess.
 */
export function parsePlocFiles(texts) {
  const { wines: winesText, cellars: cellarsText, history: historyText } = texts || {};
  const warnings = [];
  if (!winesText) {
    const err = new Error('The wines file is required to import from Ploc');
    err.code = 'ploc-no-wines';
    throw err;
  }

  const rowsOf = (text) => {
    if (!text) return [];
    const cleaned = String(text).replace(/^﻿/, '');
    return parseCSV(cleaned, detectDelimiter(cleaned));
  };

  const wineRows = rowsOf(winesText);
  const slotRows = rowsOf(cellarsText);
  const moveRows = rowsOf(historyText);
  const headers = wineRows.length > 0 ? Object.keys(wineRows[0]) : [];

  // ── Slots, grouped by storage unit ────────────────────────────────────────
  // Ploc calls each unit a "cellar"; it is a physical rack, and its name is the
  // owner's own label ("Column I - Red Burgundy £75-£200"). Empty slots are
  // exported too, and they are useful: they tell us the unit's real shape even
  // where nothing is stored.
  const rackSpecs = {};
  const slotsByWine = new Map(); // wineId -> [{ rackName, row, col }]
  const dims = {};               // rackName -> { rows, cols }
  for (const r of slotRows) {
    const name = plocGet(r, ['Name', 'Nom', 'Cave']);
    const row = parseInt(plocGet(r, ['Row', 'Ligne']), 10);
    const col = parseInt(plocGet(r, ['Column', 'Colonne']), 10);
    if (!name || !Number.isFinite(row) || !Number.isFinite(col)) continue;
    if (!dims[name]) dims[name] = { rows: 0, cols: 0 };
    if (row > dims[name].rows) dims[name].rows = row;
    if (col > dims[name].cols) dims[name].cols = col;
    const id = plocId(r);
    if (!id) continue; // an empty slot: shapes the rack, holds nothing
    if (!slotsByWine.has(id)) slotsByWine.set(id, []);
    slotsByWine.get(id).push({ rackName: name, row, col });
  }
  for (const [name, d] of Object.entries(dims)) {
    // The Rack schema caps a side at 20; a larger unit keeps its bottles but
    // arrives unplaced rather than silently distorted.
    if (d.rows > 20 || d.cols > 20) {
      warnings.push({ code: 'ploc-rack-too-big', rack: name, rows: d.rows, cols: d.cols });
      continue;
    }
    rackSpecs[name] = { type: 'grid', rows: Math.max(1, d.rows), cols: Math.max(1, d.cols), typeConfig: {} };
  }

  // ── Movements ─────────────────────────────────────────────────────────────
  const dateParser = buildPlocDateParser(moveRows.map((r) => plocGet(r, ['Date'])));
  const purchasesByWine = new Map(); // wineId -> [{ date, price, currency, vendor }]
  const consumptionsByWine = new Map(); // wineId -> [{ date, note, occasion }]
  let unmatchedMoves = 0;
  for (const r of moveRows) {
    const id = plocId(r);
    if (!id) continue;
    const date = dateParser.parse(plocGet(r, ['Date']));
    const bought = parseInt(plocGet(r, ['Purchase', 'Achat', 'Achats']), 10) || 0;
    const drunk = parseInt(plocGet(r, ['Consumption', 'Conso', 'Consos']), 10) || 0;
    const price = parseLocaleNumber(plocGet(r, ['Unit price', 'Prix unitaire', 'Prix']));
    const currency = plocCurrency(plocGet(r, ['Currency', 'Devise']));
    const vendor = plocGet(r, ['Vendor', 'Fournisseur', 'Vendeur']);
    const comments = plocGet(r, ['Comments', 'Commentaires', 'Commentaire']);
    const occasion = plocGet(r, ['Opportunity', 'Occasion']);

    if (bought > 0) {
      if (!purchasesByWine.has(id)) purchasesByWine.set(id, []);
      for (let i = 0; i < bought; i++) {
        purchasesByWine.get(id).push({ date, price: price > 0 ? price : undefined, currency, vendor });
      }
    }
    if (drunk > 0) {
      if (!consumptionsByWine.has(id)) consumptionsByWine.set(id, []);
      for (let i = 0; i < drunk; i++) {
        consumptionsByWine.get(id).push({ date, note: comments, occasion });
      }
    }
  }

  // ── Wines → bottles ───────────────────────────────────────────────────────
  const ratingScale = inferPlocRatingScale(wineRows.map((r) => plocGet(r, ['Note', 'Notation'])));
  if (ratingScale) warnings.push({ code: 'ploc-rating-scale', scale: ratingScale });
  if (moveRows.length > 0 && dateParser.inferred === false) {
    warnings.push({ code: 'ploc-date-order-assumed', dayFirst: dateParser.dayFirst });
  }

  const items = [];
  const seenWineIds = new Set();
  let placedCount = 0;
  let historyCount = 0;

  for (const r of wineRows) {
    const wineName = plocGet(r, ['Wine name', 'Wine Name', 'Nom du vin', 'Vin']);
    const producer = plocGet(r, ['Producer', 'Producteur', 'Domaine']);
    if (!wineName && !producer) continue;
    const id = plocId(r);
    if (id) seenWineIds.add(id);

    const colour = plocGet(r, ['Color', 'Colour', 'Couleur']).toLowerCase();
    const rawRating = parseLocaleNumber(plocGet(r, ['Note', 'Notation']));
    const estimate = parseLocaleNumber(plocGet(r, ['Estimate', 'Estimation', 'Valeur']));

    const base = {
      wineName,
      producer: producer || undefined,
      ...vintageOrNV(plocGet(r, ['Vintage', 'Millésime', 'Millesime'])),
      type: PLOC_COLOUR_TO_TYPE[colour] || undefined,
      grapes: parsePlocGrapes(plocGet(r, ['Grapes', 'Cépages', 'Cepages', 'Cépage'])),
      country: plocGet(r, ['Country', 'Pays']) || undefined,
      region: plocGet(r, ['Region', 'Région']) || undefined,
      appellation: plocGet(r, ['Appellation']) || undefined,
      classification: plocGet(r, ['Classification', 'Classement']) || undefined,
      bottleSize: PLOC_FORMAT_TO_SIZE[plocGet(r, ['Bottle format', 'Format', 'Contenant']).toLowerCase()] || undefined,
      notes: plocGet(r, ['Comments', 'Commentaires', 'Commentaire']) || undefined,
      ...parsePlocApogee(plocGet(r, ['Apogee', 'Apogée'])),
      ...(ratingScale && rawRating > 0 ? { rating: rawRating, ratingScale } : {}),
    };

    const stock = Math.max(0, parseInt(plocGet(r, ['Stock']), 10) || 0);
    const consumptions = (id && consumptionsByWine.get(id)) || [];
    const purchases = ((id && purchasesByWine.get(id)) || [])
      .slice()
      .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));

    // Oldest bottles are drunk first, so the earliest purchases belong to the
    // consumed bottles and whatever remains belongs to what is still in the
    // cellar. When the two sides disagree — a stock count that predates the
    // movement log, say — the wines file wins on how many bottles exist and the
    // history only ever supplies dates and prices.
    const consumedPurchases = purchases.slice(0, consumptions.length);
    let activePurchases = purchases.slice(consumptions.length);
    if (activePurchases.length > stock) activePurchases = activePurchases.slice(-stock);

    consumptions
      .slice()
      .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')))
      .forEach((c, i) => {
        const p = consumedPurchases[i];
        items.push({
          ...base,
          grapes: [...base.grapes],
          quantity: 1,
          addToHistory: true,
          consumedReason: 'drank',
          ...(c.date ? { consumedAt: c.date } : {}),
          ...(c.note ? { consumedNote: c.note } : {}),
          ...(c.occasion ? { occasion: c.occasion } : {}),
          ...(p?.date ? { purchaseDate: p.date, dateAdded: p.date } : {}),
          ...(p?.price ? { price: p.price } : {}),
          ...(p?.currency ? { currency: p.currency } : {}),
          ...(p?.vendor ? { purchaseLocation: p.vendor } : {}),
        });
        historyCount += 1;
      });

    const slots = (id && slotsByWine.get(id)) || [];
    if (slots.length > stock) {
      warnings.push({ code: 'ploc-extra-slots', wine: wineName, slots: slots.length, stock });
    }
    for (let i = 0; i < stock; i++) {
      const slot = slots[i];
      const p = activePurchases[i];
      if (slot) placedCount += 1;
      items.push({
        ...base,
        grapes: [...base.grapes],
        quantity: 1,
        ...(slot ? { rackName: slot.rackName, row: slot.row, col: slot.col } : {}),
        ...(p?.date ? { purchaseDate: p.date, dateAdded: p.date } : {}),
        // A recorded purchase price is what the bottle actually cost; the
        // wines file's "Estimate" is today's value, and only fills the gap.
        ...(p?.price ? { price: p.price } : estimate > 0 ? { price: estimate } : {}),
        ...(p?.currency ? { currency: p.currency } : {}),
        ...(p?.vendor ? { purchaseLocation: p.vendor } : {}),
      });
    }
  }

  for (const id of [...purchasesByWine.keys(), ...consumptionsByWine.keys()]) {
    if (!seenWineIds.has(id)) unmatchedMoves += 1;
  }
  if (unmatchedMoves > 0) warnings.push({ code: 'ploc-unmatched-history', count: unmatchedMoves });
  if (slotRows.length === 0) warnings.push({ code: 'ploc-no-cellars' });
  if (moveRows.length === 0) warnings.push({ code: 'ploc-no-history' });
  if (placedCount > 0) warnings.push({ code: 'ploc-placed', count: placedCount, racks: Object.keys(rackSpecs).length });
  if (historyCount > 0) warnings.push({ code: 'ploc-history', count: historyCount });

  return { items, format: 'ploc', headers, rackSpecs, warnings };
}
