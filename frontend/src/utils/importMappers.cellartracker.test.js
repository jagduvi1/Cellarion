/**
 * CellarTracker import — prescriptive tests against REAL export fixtures.
 *
 * Fixture provenance (two sources, both authoritative):
 *   __fixtures__/cellartracker/webquery/ — genuine CellarTracker WebQuery
 *     output captured by the mathroule/cellartracker client test suite.
 *   __fixtures__/cellartracker/bundle/  — verified 20-wine adversarial bundle;
 *     every file describes the SAME cellar so counts reconcile across tables
 *     (List = held wines, Inventory = in-cellar + pending bottles,
 *     Bottles = every physical bottle incl. consumed, Purchase = every lot).
 *     Includes a REAL byte-level Windows-1252 CSV.
 *   __fixtures__/cellartracker/generated/ — derived variants (see
 *     generate-variants.js).
 *
 * EVERY expectation below is written BY HAND from the fixture contents —
 * the fixtures define correctness, never the parser's current output.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  decodeImportBuffer,
  detectCellarTrackerTable,
  detectFormat,
  parseAndMap,
  parseCSV,
  guessProducerFromWineName,
  stripProducerPrefix,
} from './importMappers';
import { normalizeBottleSize } from '../config/bottleSizes';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'cellartracker');
const readBytes = (...p) => fs.readFileSync(path.join(FIXTURES, ...p));
const decode = (...p) => decodeImportBuffer(readBytes(...p));
const parseFixture = (...p) => parseAndMap(decode(...p).text);
const headersOf = (...p) => decode(...p).text.split(/\r?\n/)[0].split('\t');

const catchErr = (fn) => {
  try { fn(); } catch (e) { return e; }
  return null;
};

// ---------------------------------------------------------------------------
// Encoding detection — the #1 CellarTracker failure mode. The browser-UI
// export is Windows-1252; reading it as UTF-8 silently corrupts Pétrus,
// Château, Prüm, Romanée-Conti…
// ---------------------------------------------------------------------------
describe('decodeImportBuffer', () => {
  it('decodes the WebQuery UTF-8 TSV as utf-8 with accents intact', () => {
    const { text, encoding } = decode('bundle', 'CellarTracker_List.tsv');
    expect(encoding).toBe('utf-8');
    expect(text).toContain('Pétrus');
    expect(text).toContain("Château d'Yquem");
    expect(text).toContain('Joh. Jos. Prüm');
  });

  it('the win1252 fixture really is Windows-1252 at the byte level', () => {
    const bytes = readBytes('bundle', 'CellarTracker_List_win1252.csv');
    const hasSeq = (seq) => {
      outer: for (let i = 0; i <= bytes.length - seq.length; i++) {
        for (let j = 0; j < seq.length; j++) {
          if (bytes[i + j] !== seq[j]) continue outer;
        }
        return true;
      }
      return false;
    };
    // "Pé" as cp1252: 0x50 0xE9 — a single é byte, present
    expect(hasSeq([0x50, 0xE9])).toBe(true);
    // "é" as UTF-8 would be 0xC3 0xA9 — must NOT be present
    expect(hasSeq([0xC3, 0xA9])).toBe(false);
    // "ü" (Prüm) as cp1252: 0xFC
    expect(hasSeq([0x72, 0xFC, 0x6D])).toBe(true);
  });

  it('detects the Windows-1252 CSV and decodes accents byte-perfectly', () => {
    const { text, encoding } = decode('bundle', 'CellarTracker_List_win1252.csv');
    expect(encoding).toBe('windows-1252');
    expect(text).toContain('Pétrus');
    expect(text).toContain('Joh. Jos. Prüm');
    expect(text).toContain('Château Mouton-Rothschild');
    expect(text).not.toContain('�'); // no replacement characters
  });

  it('utf8 and win1252 CSVs of the same table decode to the identical string', () => {
    expect(decode('bundle', 'CellarTracker_List_win1252.csv').text)
      .toBe(decode('bundle', 'CellarTracker_List_utf8.csv').text);
  });

  it('honours a UTF-8 BOM (and strips it)', () => {
    const body = Buffer.from('iWine\tWine\n1\tPétrus\n', 'utf8');
    const { text, encoding } = decodeImportBuffer(
      Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), body])
    );
    expect(encoding).toBe('utf-8');
    expect(text.startsWith('iWine')).toBe(true);
    expect(text).toContain('Pétrus');
  });

  it('honours a UTF-16LE BOM', () => {
    const body = Buffer.from('iWine,Wine\r\n1,Pétrus\r\n', 'utf16le');
    const { text, encoding } = decodeImportBuffer(
      Buffer.concat([Buffer.from([0xFF, 0xFE]), body])
    );
    expect(encoding).toBe('utf-16le');
    expect(text).toContain('Pétrus');
  });

  it('leaves valid UTF-8 (incl. plain ASCII) untouched — no behaviour change for good files', () => {
    const ascii = Buffer.from('Wine,Producer\nMargaux,CM\n', 'utf8');
    const { text, encoding } = decodeImportBuffer(ascii);
    expect(encoding).toBe('utf-8');
    expect(text).toBe('Wine,Producer\nMargaux,CM\n');
  });
});

// ---------------------------------------------------------------------------
// HTML error page — WebQuery returns HTML when the session is invalid
// ---------------------------------------------------------------------------
describe('CellarTracker error-page detection', () => {
  it('rejects the real not-logged-in HTML page with code ct-error-page', () => {
    const err = catchErr(() => parseFixture('webquery', 'not_logged.html'));
    expect(err).not.toBeNull();
    expect(err.code).toBe('ct-error-page');
  });

  it('rejects generic HTML documents saved as csv', () => {
    const err = catchErr(() => parseAndMap('<!DOCTYPE html><html><body>Login required</body></html>'));
    expect(err?.code).toBe('ct-error-page');
  });
});

// ---------------------------------------------------------------------------
// Table fingerprinting
// ---------------------------------------------------------------------------
describe('detectCellarTrackerTable', () => {
  it('fingerprints every WebQuery table from its real header row', () => {
    expect(detectCellarTrackerTable(headersOf('webquery', 'list.tsv'))).toBe('list');
    expect(detectCellarTrackerTable(headersOf('webquery', 'inventory.tsv'))).toBe('inventory');
    expect(detectCellarTrackerTable(headersOf('webquery', 'bottles.tsv'))).toBe('bottles');
    expect(detectCellarTrackerTable(headersOf('webquery', 'consumed.tsv'))).toBe('consumed');
    expect(detectCellarTrackerTable(headersOf('webquery', 'purchase.tsv'))).toBe('purchase');
    expect(detectCellarTrackerTable(headersOf('webquery', 'pending.tsv'))).toBe('purchase'); // schema-identical; relabeled by Delivered
    expect(detectCellarTrackerTable(headersOf('webquery', 'availability.tsv'))).toBe('availability');
  });

  it('fingerprints the bundle tables identically', () => {
    expect(detectCellarTrackerTable(headersOf('bundle', 'CellarTracker_List.tsv'))).toBe('list');
    expect(detectCellarTrackerTable(headersOf('bundle', 'CellarTracker_Inventory.tsv'))).toBe('inventory');
    expect(detectCellarTrackerTable(headersOf('bundle', 'CellarTracker_Bottles.tsv'))).toBe('bottles');
    expect(detectCellarTrackerTable(headersOf('bundle', 'CellarTracker_Consumed.tsv'))).toBe('consumed');
  });

  it('returns null for loose/browser-UI headers (fallback mapper takes over)', () => {
    expect(detectCellarTrackerTable(['iWine', 'Wine', 'Vintage'])).toBeNull();
    expect(detectCellarTrackerTable(['Wine', 'Vintage', 'Locale', 'Bin'])).toBeNull();
  });

  it('all CT tables are still detected as cellartracker by detectFormat', () => {
    for (const f of ['list.tsv', 'inventory.tsv', 'bottles.tsv', 'consumed.tsv', 'purchase.tsv', 'pending.tsv']) {
      expect(detectFormat(headersOf('webquery', f))).toBe('cellartracker');
    }
  });
});

// ---------------------------------------------------------------------------
// Availability = statistics, not a cellar export → friendly rejection
// ---------------------------------------------------------------------------
describe('Availability table rejection', () => {
  it('rejects the real Availability export with code ct-availability', () => {
    const err = catchErr(() => parseFixture('webquery', 'availability.tsv'));
    expect(err?.code).toBe('ct-availability');
  });
});

// ---------------------------------------------------------------------------
// Header-only exports (user exported an empty table) — parse to zero items,
// never crash
// ---------------------------------------------------------------------------
describe('empty CT exports', () => {
  it.each([
    'list_empty.tsv', 'inventory_empty.tsv', 'bottles_empty.tsv',
    'consumed_empty.tsv', 'purchase_empty.tsv', 'pending_empty.tsv',
    'availability_empty.tsv',
  ])('%s parses to zero items without throwing', (file) => {
    const result = parseFixture('webquery', file);
    expect(result.items).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// List table — one row per WINE, Quantity expands, Pending is NOT quantity
// ---------------------------------------------------------------------------
describe('CT List table (bundle, 20 wines)', () => {
  const result = parseAndMap(decode('bundle', 'CellarTracker_List.tsv').text);

  it('is fingerprinted as the list table', () => {
    expect(result.format).toBe('cellartracker');
    expect(result.ctTable).toBe('list');
  });

  it('expands Quantity to exactly 46 bottles (1+5+6+1+2+3+4+3+1+2+1+6+3+4+1+2+1)', () => {
    expect(result.items).toHaveLength(46);
  });

  it('skips the fully-pending Pétrus (Quantity 0 / Pending 3) and reports it', () => {
    expect(result.items.some((i) => i.producer === 'Pétrus')).toBe(false);
    expect(result.warnings).toEqual([
      { code: 'ct-pending-skipped', count: 3, wines: ['Pétrus'] },
    ]);
  });

  it('maps the Romanée-Conti row completely (and does NOT import the CT community score)', () => {
    const drc = result.items.filter((i) => i.producer === 'Domaine de la Romanée-Conti');
    expect(drc).toHaveLength(1);
    expect(drc[0]).toMatchObject({
      wineName: 'La Tâche', // producer prefix stripped from CT display name
      producer: 'Domaine de la Romanée-Conti',
      vintage: '2003',
      country: 'France',
      region: 'Burgundy',
      appellation: 'La Tâche Grand Cru',
      type: 'red',
      price: 3500,
      currency: 'EUR',
      bottleSize: '750ml',
      location: 'Cellar',
      grapes: ['Pinot Noir'],
      drinkFrom: 2013,
      drinkTo: 2029,
    });
    // CT column holds the community average 94.4117647058823 — never imported
    expect(drc[0].rating).toBeUndefined();
  });

  it('expands Yquem ×5 half-bottles as dessert wine', () => {
    const yquem = result.items.filter((i) => i.producer === "Château d'Yquem");
    expect(yquem).toHaveLength(5);
    expect(yquem[0]).toMatchObject({
      wineName: "Château d'Yquem", // stripping the producer would empty it → kept
      vintage: '2011',
      type: 'dessert', // "White - Sweet/Dessert"
      bottleSize: '375ml',
      drinkFrom: 2019,
      drinkTo: 2054,
    });
  });

  it('maps vintage 1001 (Krug NV Champagne) to NV with blank drink window', () => {
    const krug = result.items.filter((i) => i.producer === 'Krug');
    expect(krug).toHaveLength(6);
    expect(krug[0]).toMatchObject({
      wineName: 'Grande Cuvée',
      vintage: 'NV',
      type: 'sparkling', // "White - Sparkling"
      drinkFrom: null,
      drinkTo: null,
    });
  });

  it('maps the 1.5L Mouton magnum to 1500ml with its Location/Bin joined', () => {
    const mouton = result.items.find((i) => i.producer === 'Château Mouton-Rothschild');
    expect(mouton.bottleSize).toBe('1500ml'); // never 1ml!
    expect(mouton.location).toBe('Cellar / R3C2D1');
    expect(mouton.vintage).toBe('2016');
  });

  it('treats 9999 drink windows (Guigal, free-tier sentinel) as no window', () => {
    const guigal = result.items.find((i) => i.producer === 'E. Guigal');
    expect(guigal.wineName).toBe('Côte-Rôtie La Landonne');
    expect(guigal.drinkFrom).toBeNull();
    expect(guigal.drinkTo).toBeNull();
  });

  it('round-trips Prüm umlauts and expands ×4', () => {
    const pruem = result.items.filter((i) => i.producer === 'Joh. Jos. Prüm');
    expect(pruem).toHaveLength(4);
    expect(pruem[0].wineName).toBe('Wehlener Sonnenuhr Riesling Auslese');
  });

  it('maps NV Lagavulin (Spirits, 700ml) without corrupting it', () => {
    const lag = result.items.find((i) => i.producer === 'Lagavulin');
    expect(lag).toMatchObject({
      wineName: '16 Year Old',
      vintage: 'NV',        // vintage 1001
      bottleSize: '700ml',
      type: 'fortified',    // closest Cellarion bucket for Spirits
    });
  });

  it('survives a comma inside the quoted Designation field (Vega Sicilia)', () => {
    const vega = result.items.filter((i) => i.producer === 'Vega Sicilia');
    expect(vega).toHaveLength(2); // the comma didn't shift any columns
    expect(vega[0]).toMatchObject({ wineName: 'Único', vintage: '2010', price: 395 });
  });

  it('maps the 3.0L Sassicaia to 3000ml', () => {
    const sass = result.items.find((i) => i.producer === 'Tenuta San Guido');
    expect(sass.wineName).toBe('Sassicaia');
    expect(sass.bottleSize).toBe('3000ml');
  });

  it('maps Port to fortified and Rosé to rosé', () => {
    expect(result.items.find((i) => i.producer === 'Taylor Fladgate').type).toBe('fortified');
    const tempier = result.items.find((i) => i.producer === 'Domaine Tempier');
    expect(tempier.type).toBe('rosé');
    expect(tempier.wineName).toBe('Bandol Rosé');
  });

  it('keeps Location blank for the multi-location Cristal (List has no single value)', () => {
    const cristal = result.items.filter((i) => i.producer === 'Louis Roederer');
    expect(cristal).toHaveLength(4);
    expect(cristal[0].location).toBe('');
  });

  it('parses decimal prices (Raveneau 312.50)', () => {
    expect(result.items.find((i) => i.producer === 'Domaine Raveneau').price).toBe(312.5);
  });

  it('keeps the wine name when it equals the producer (Harlan Estate)', () => {
    const harlan = result.items.find((i) => i.producer === 'Harlan Estate');
    expect(harlan.wineName).toBe('Harlan Estate');
  });
});

// ---------------------------------------------------------------------------
// CSV vs TSV vs encodings — all three List files must produce IDENTICAL items
// ---------------------------------------------------------------------------
describe('CT List: TSV / UTF-8 CSV / Windows-1252 CSV equivalence', () => {
  it('the UTF-8 CSV (CRLF, quoted commas) produces the same items as the TSV', () => {
    const tsv = parseFixture('bundle', 'CellarTracker_List.tsv');
    const csv = parseFixture('bundle', 'CellarTracker_List_utf8.csv');
    expect(csv.format).toBe('cellartracker');
    expect(csv.ctTable).toBe('list');
    expect(csv.items).toEqual(tsv.items);
  });

  it('the Windows-1252 CSV produces the same items — Pétrus round-trips byte-perfectly from BOTH encodings', () => {
    const tsv = parseFixture('bundle', 'CellarTracker_List.tsv');
    const win = parseFixture('bundle', 'CellarTracker_List_win1252.csv');
    expect(win.items).toEqual(tsv.items);
    expect(win.warnings).toEqual([{ code: 'ct-pending-skipped', count: 3, wines: ['Pétrus'] }]);
    expect(win.items.some((i) => i.producer === 'Joh. Jos. Prüm')).toBe(true);
  });

  it('quoted comma-bearing fields survive the CSV parser as single fields', () => {
    const { text } = decode('bundle', 'CellarTracker_List_utf8.csv');
    const rows = parseCSV(text, ',');
    const petrus = rows.find((r) => r.Wine === 'Pétrus');
    expect(petrus.Locale).toBe('France, Bordeaux, Libournais, Pomerol');
    const vega = rows.find((r) => r.Wine === 'Vega Sicilia Único');
    expect(vega.Designation).toBe('Reserva Especial, Lote 2');
  });
});

// ---------------------------------------------------------------------------
// Inventory table — one row per bottle; (pending) rows skipped; native currency
// ---------------------------------------------------------------------------
describe('CT Inventory table (bundle)', () => {
  const result = parseAndMap(decode('bundle', 'CellarTracker_Inventory.tsv').text);

  it('yields 46 in-cellar bottles and skips the 3 (pending) Pétrus rows', () => {
    expect(result.ctTable).toBe('inventory');
    expect(result.items).toHaveLength(46);
    expect(result.warnings).toEqual([
      { code: 'ct-pending-skipped', count: 3, wines: ['Pétrus'] },
    ]);
  });

  it('reconciles with the List table (same cellar, same 46 bottles)', () => {
    const list = parseFixture('bundle', 'CellarTracker_List.tsv');
    expect(result.items.length).toBe(list.items.length);
  });

  it('carries per-bottle purchase data (Yquem: Millesima, 11/6/2019 → ISO)', () => {
    const yquem = result.items.filter((i) => i.producer === "Château d'Yquem");
    expect(yquem).toHaveLength(5);
    expect(yquem[0].purchaseDate).toBe('2019-11-06'); // US M/D/YYYY, month first
    expect(yquem[0].purchaseLocation).toBe('Millesima');
    expect(yquem[0].bottleSize).toBe('375ml');
  });

  it('prefers the native purchase currency when it differs from the account currency', () => {
    const ridge = result.items.filter((i) => i.producer === 'Ridge');
    expect(ridge).toHaveLength(3);
    expect(ridge[0].price).toBe(215);
    expect(ridge[0].currency).toBe('USD'); // NativePriceCurrency, not account EUR
    const penfolds = result.items.find((i) => i.producer === 'Penfolds');
    expect(penfolds.price).toBe(580);
    expect(penfolds.currency).toBe('AUD');
    // …and keeps the account currency when they match
    const raveneau = result.items.filter((i) => i.producer === 'Domaine Raveneau');
    expect(raveneau[0].price).toBe(312.5);
    expect(raveneau[0].currency).toBe('EUR');
  });

  it('ingests every freeform bin format via the joined location string', () => {
    const locations = new Set(result.items.map((i) => i.location));
    for (const expected of [
      'Cellar / R3C2D1',            // structured code
      'EuroCave / A12',             // letter+number
      'Offsite Storage / 12-3-4',   // dashed
      'Cellar / 147',               // bare number
      'Basement / Rack B - Top',    // words with dashes
      'Offsite Storage / BIN1',
      'Cellar / D-04-1',
      'Bar',                        // Location only, no bin
    ]) {
      expect(locations).toContain(expected);
    }
  });

  it('contains no consumed bottles (Margaux 1996 must be absent)', () => {
    expect(result.items.some((i) => i.vintage === '1996')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Bottles table — every state: -1 pending (skip), 0 consumed (history), 1 active
// ---------------------------------------------------------------------------
describe('CT Bottles table (bundle)', () => {
  const result = parseAndMap(decode('bundle', 'CellarTracker_Bottles.tsv').text);

  it('yields 50 bottles: 46 active + 4 consumed; 3 pending skipped', () => {
    expect(result.ctTable).toBe('bottles');
    expect(result.items).toHaveLength(50);
    expect(result.items.filter((i) => i.addToHistory)).toHaveLength(4);
    expect(result.items.filter((i) => !i.addToHistory)).toHaveLength(46);
    expect(result.warnings).toEqual([
      { code: 'ct-pending-skipped', count: 3, wines: ['Pétrus'] },
    ]);
  });

  it('maps the consumed-only Margaux 1996 (absent from List/Inventory) into drink history', () => {
    const margaux = result.items.filter((i) => i.producer === 'Château Margaux');
    expect(margaux).toHaveLength(2);
    expect(margaux.every((i) => i.addToHistory === true)).toBe(true);
    const dates = margaux.map((i) => i.consumedAt).sort();
    expect(dates).toEqual(['2021-03-09', '2022-12-24']);
    const first = margaux.find((i) => i.consumedAt === '2021-03-09');
    expect(first).toMatchObject({
      vintage: '1996',
      consumedReason: 'drank',
      consumedNote: 'Perfection. At its peak.',
      purchaseDate: '2015-03-02',
      price: 650,
      currency: 'EUR',
      // geography parsed from the Locale path (Bottles has no Country column)
      country: 'France',
      region: 'Bordeaux',
      appellation: 'Margaux',
    });
    const second = margaux.find((i) => i.consumedAt === '2022-12-24');
    expect(second.consumedNote).toBe('Christmas magnum-worthy. Still stunning.');
  });

  it('maps the consumed DRC and Yquem bottles with their dates and notes', () => {
    const drc = result.items.find((i) => i.producer === 'Domaine de la Romanée-Conti' && i.addToHistory);
    expect(drc.consumedAt).toBe('2020-05-01');
    expect(drc.consumedNote).toBe('Absolutely fantastic wine!');
    const yquem = result.items.find((i) => i.producer === "Château d'Yquem" && i.addToHistory);
    expect(yquem.consumedAt).toBe('2020-05-21');
    expect(yquem.consumedNote).toBe('Excellent!');
    expect(yquem.bottleSize).toBe('375ml'); // Bottles table calls it BottleSize
  });

  it('guesses multi-word producers from the Wine display name (no Producer column)', () => {
    const krug = result.items.filter((i) => i.wineName === 'Krug Grande Cuvée' && !i.addToHistory);
    expect(krug).toHaveLength(6);
    expect(krug[0].vintage).toBe('NV'); // 1001 sentinel again
    expect(krug[0].location).toBe('Wine Fridge / A1');
    const drcActive = result.items.find((i) => i.wineName === 'Domaine de la Romanée-Conti La Tâche' && !i.addToHistory);
    // prefix + particles + substantive token — NOT the old first-word "Domaine"
    expect(drcActive.producer).toBe('Domaine de la Romanée-Conti');
  });
});

// ---------------------------------------------------------------------------
// Consumed table — pure drink history
// ---------------------------------------------------------------------------
describe('CT Consumed table (bundle)', () => {
  const result = parseAndMap(decode('bundle', 'CellarTracker_Consumed.tsv').text);

  it('maps all 4 consumption events to history entries', () => {
    expect(result.ctTable).toBe('consumed');
    expect(result.items).toHaveLength(4);
    expect(result.items.every((i) => i.addToHistory === true)).toBe(true);
    expect(result.items.map((i) => i.consumedAt).sort()).toEqual([
      '2020-05-01', '2020-05-21', '2021-03-09', '2022-12-24',
    ]);
  });

  it('maps the Yquem event fully (heuristic producer, dessert type, 375ml)', () => {
    const yquem = result.items.find((i) => i.consumedAt === '2020-05-21');
    expect(yquem).toMatchObject({
      wineName: "Château d'Yquem",
      producer: "Château d'Yquem", // guessed from the Wine display name
      vintage: '2011',
      type: 'dessert',
      bottleSize: '375ml',
      consumedReason: 'drank',
      consumedNote: 'Excellent!',
      location: 'Cellar',
      price: 230,
      currency: 'EUR',
    });
  });

  it('never maps cNotes/cLabels (community-note COUNTS) into any notes field', () => {
    // Margaux rows carry cNotes=0 and cLabels=5050 — none of it is note text
    const margaux = result.items.filter((i) => i.vintage === '1996');
    expect(margaux).toHaveLength(2);
    for (const m of margaux) {
      expect(m.notes).toBe('');
      expect(m.consumedNote).not.toContain('5050');
    }
    expect(margaux.map((i) => i.consumedNote).sort()).toEqual([
      'Christmas magnum-worthy. Still stunning.',
      'Perfection. At its peak.',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Purchase / Pending tables — one row per ORDER, Quantity expands
// ---------------------------------------------------------------------------
describe('CT Purchase and Pending tables (bundle)', () => {
  it('expands the 19 purchase lots to 53 bottles — every bottle ever bought', () => {
    const result = parseFixture('bundle', 'CellarTracker_Purchase.tsv');
    expect(result.ctTable).toBe('purchase'); // mixed Delivered values
    expect(result.items).toHaveLength(53);   // Σ Quantity, reconciles with Bottles rows
    expect(result.warnings).toBeUndefined();

    const petrus = result.items.filter((i) => i.producer === 'Pétrus');
    expect(petrus).toHaveLength(3);
    expect(petrus[0].purchaseDate).toBe('2020-05-25');
    expect(petrus[0].purchaseLocation).toBe('Farr Vintners');
    expect(petrus[0].price).toBeUndefined(); // CT price 0 = not recorded

    const penfolds = result.items.find((i) => i.producer === 'Penfolds');
    expect(penfolds.price).toBe(580);
    expect(penfolds.currency).toBe('AUD');

    // consumed-since lots are still purchases (Margaux 1996 ×2)
    expect(result.items.filter((i) => i.vintage === '1996')).toHaveLength(2);
  });

  it('relabels an all-undelivered file as the pending table', () => {
    const result = parseFixture('bundle', 'CellarTracker_Pending.tsv');
    expect(result.ctTable).toBe('pending'); // every row Delivered=False
    expect(result.items).toHaveLength(3);
    expect(result.items[0]).toMatchObject({
      wineName: 'Pétrus',
      producer: 'Pétrus',
      vintage: '2008',
      purchaseDate: '2020-05-25',
      purchaseLocation: 'Farr Vintners',
    });
  });
});

// ---------------------------------------------------------------------------
// Truncation warning — CT's UI default exports only the first 25 rows
// ---------------------------------------------------------------------------
describe('25-row truncation warning', () => {
  it('warns on a file with EXACTLY 25 data rows', () => {
    const result = parseFixture('generated', 'list_truncated25.tsv');
    expect(result.warnings?.some((w) => w.code === 'ct-truncated')).toBe(true);
  });

  it('does not warn on other row counts (18-row bundle, 3-row webquery)', () => {
    const bundle = parseFixture('bundle', 'CellarTracker_List.tsv');
    expect(bundle.warnings?.some((w) => w.code === 'ct-truncated')).toBeFalsy();
    const webquery = parseFixture('webquery', 'list.tsv');
    expect(webquery.warnings?.some((w) => w.code === 'ct-truncated')).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// mathroule WebQuery fixtures — genuine CT output, second independent source
// ---------------------------------------------------------------------------
describe('mathroule WebQuery fixtures', () => {
  it('list.tsv → 6 bottles (DRC 1 + Yquem 5), Pétrus pending skipped', () => {
    const result = parseFixture('webquery', 'list.tsv');
    expect(result.ctTable).toBe('list');
    expect(result.items).toHaveLength(6);
    expect(result.warnings).toEqual([
      { code: 'ct-pending-skipped', count: 3, wines: ['Pétrus'] },
    ]);
    const drc = result.items.find((i) => i.producer === 'Domaine de la Romanée-Conti');
    expect(drc.wineName).toBe('La Tâche');
    expect(drc.drinkFrom).toBe(2013);
    expect(drc.drinkTo).toBe(2029);
  });

  it('inventory.tsv → 6 bottles; StoreName "Unknown" is a sentinel, not a store', () => {
    const result = parseFixture('webquery', 'inventory.tsv');
    expect(result.ctTable).toBe('inventory');
    expect(result.items).toHaveLength(6);
    expect(result.items.every((i) => i.purchaseLocation === '')).toBe(true);
    const drc = result.items.find((i) => i.producer === 'Domaine de la Romanée-Conti');
    expect(drc.purchaseDate).toBe('2020-04-08');
  });

  it('bottles.tsv → 8 bottles (6 active + 2 consumed), 3 pending skipped', () => {
    const result = parseFixture('webquery', 'bottles.tsv');
    expect(result.ctTable).toBe('bottles');
    expect(result.items).toHaveLength(8);
    const consumed = result.items.filter((i) => i.addToHistory);
    expect(consumed).toHaveLength(2);
    expect(consumed.map((i) => i.consumedAt).sort()).toEqual(['2020-05-01', '2020-05-21']);
    expect(result.warnings).toEqual([
      { code: 'ct-pending-skipped', count: 3, wines: ['Pétrus'] },
    ]);
  });

  it('consumed.tsv → 2 history entries; Yquem consumed 2020-05-21', () => {
    const result = parseFixture('webquery', 'consumed.tsv');
    expect(result.ctTable).toBe('consumed');
    expect(result.items).toHaveLength(2);
    const yquem = result.items.find((i) => i.wineName === "Château d'Yquem");
    expect(yquem).toMatchObject({
      addToHistory: true,
      consumedAt: '2020-05-21',
      consumedReason: 'drank',
      consumedNote: 'Excellent!',
    });
  });

  it('purchase.tsv → 11 bottles from 3 lots (3+2+6)', () => {
    const result = parseFixture('webquery', 'purchase.tsv');
    expect(result.ctTable).toBe('purchase');
    expect(result.items).toHaveLength(11);
  });

  it('pending.tsv → relabeled pending, 3 bottles', () => {
    const result = parseFixture('webquery', 'pending.tsv');
    expect(result.ctTable).toBe('pending');
    expect(result.items).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Loose fallback — browser-UI CSV exports with drifting headers (MyScore, no iWine)
// ---------------------------------------------------------------------------
describe('loose CellarTracker fallback (browser-UI header drift)', () => {
  const csv = [
    'Wine,Vintage,Locale,Size,Quantity,Price,Currency,MyScore,CT,BeginConsume,EndConsume,Varietal,Location,Bin',
    '"Château Margaux",1001,"France, Bordeaux, Médoc, Margaux",1.5L,2,650,EUR,95,88.5,2020,2040,Red Bordeaux Blend,Cellar,A3',
  ].join('\n');

  it('routes through the loose mapper (no table fingerprint) with full sentinel handling', () => {
    const result = parseAndMap(csv);
    expect(result.format).toBe('cellartracker');
    expect(result.ctTable).toBeUndefined();
    expect(result.items).toHaveLength(2); // quantity expanded
    expect(result.items[0]).toMatchObject({
      wineName: 'Château Margaux',
      producer: 'Château Margaux', // prefix heuristic, not just "Château"
      vintage: 'NV',               // 1001 sentinel
      country: 'France',           // parsed from Locale
      region: 'Bordeaux',
      appellation: 'Margaux',
      bottleSize: '1500ml',
      price: 650,
      currency: 'EUR',
      rating: 95,                  // MyScore (browser-CSV alias for MY)
      ratingScale: '100',
      location: 'Cellar / A3',
      grapes: ['Red Bordeaux Blend'],
      drinkFrom: 2020,
      drinkTo: 2040,
    });
  });

  it('accepts the MY header too and preserves long-float scores exactly', () => {
    const result = parseAndMap(
      'iWine,Wine,Vintage,MY,CT\n1,"Harlan Estate Red",2013,99.1234567890123,96.5'
    );
    expect(result.items[0].rating).toBe(99.1234567890123);
    expect(result.items[0].ratingScale).toBe('100');
  });

  it('never falls back to the CT community-average column when MY is empty', () => {
    const result = parseAndMap('iWine,Wine,Vintage,MY,CT\n1,"Some Wine",2019,,96.625');
    expect(result.items[0].rating).toBeUndefined();
  });

  it('cleans (n/a)/(unknown) location sentinels and Unknown producer', () => {
    const result = parseAndMap(
      'iWine,Wine,Producer,Vintage,Location,Bin\n1,Ridge Monte Bello,Unknown,2019,(n/a),(unknown)'
    );
    expect(result.items[0].location).toBe('');
    expect(result.items[0].producer).toBe('Ridge'); // Unknown → heuristic
  });

  it('treats vintage 9999 as unknown (NV), not the year 9999', () => {
    const result = parseAndMap('iWine,Wine,Vintage\n1,Mystery Wine,9999');
    expect(result.items[0].vintage).toBe('NV');
  });

  it('parses US M/D/YYYY purchase dates month-first', () => {
    const result = parseAndMap('iWine,Wine,Vintage,PurchaseDate\n1,Some Wine,2019,3/9/2021');
    expect(result.items[0].purchaseDate).toBe('2021-03-09'); // March 9, not Sep 3
  });
});

// ---------------------------------------------------------------------------
// Producer heuristic + producer-prefix stripping
// ---------------------------------------------------------------------------
describe('guessProducerFromWineName', () => {
  it('takes prefix + particles + one substantive token for French estate names', () => {
    expect(guessProducerFromWineName('Domaine de la Romanée-Conti La Tâche')).toBe('Domaine de la Romanée-Conti');
    expect(guessProducerFromWineName('Château Mouton-Rothschild')).toBe('Château Mouton-Rothschild');
    expect(guessProducerFromWineName("Château d'Yquem")).toBe("Château d'Yquem");
    expect(guessProducerFromWineName('Clos des Papes Châteauneuf-du-Pape')).toBe('Clos des Papes');
    expect(guessProducerFromWineName('Quinta do Noval Vintage Port')).toBe('Quinta do Noval');
    expect(guessProducerFromWineName('Weingut Egon Müller Scharzhofberger')).toBe('Weingut Egon');
  });

  it('keeps the legacy first-word rule for non-prefixed names', () => {
    expect(guessProducerFromWineName('Ridge Monte Bello')).toBe('Ridge');
    expect(guessProducerFromWineName('Penfolds Grange Shiraz')).toBe('Penfolds');
  });

  it('returns empty for short names it cannot split confidently', () => {
    expect(guessProducerFromWineName('Pétrus')).toBe('');
    expect(guessProducerFromWineName('Opus One')).toBe('');
    expect(guessProducerFromWineName('')).toBe('');
  });
});

describe('stripProducerPrefix', () => {
  it('strips the producer prefix from CT display names', () => {
    expect(stripProducerPrefix('Vega Sicilia Único', 'Vega Sicilia')).toBe('Único');
    expect(stripProducerPrefix('Krug Grande Cuvée', 'Krug')).toBe('Grande Cuvée');
    expect(stripProducerPrefix('E. Guigal Côte-Rôtie La Landonne', 'E. Guigal')).toBe('Côte-Rôtie La Landonne');
  });

  it('keeps the full name when stripping would empty it', () => {
    expect(stripProducerPrefix('Pétrus', 'Pétrus')).toBe('Pétrus');
    expect(stripProducerPrefix('Harlan Estate', 'Harlan Estate')).toBe('Harlan Estate');
  });

  it('leaves names that do not start with the producer untouched', () => {
    expect(stripProducerPrefix('La Tâche', 'Domaine de la Romanée-Conti')).toBe('La Tâche');
  });
});

// ---------------------------------------------------------------------------
// Bottle-size normalisation — the "magnum imported as 1ml" bug lives here
// ---------------------------------------------------------------------------
describe('normalizeBottleSize on CellarTracker size strings', () => {
  it.each([
    ['750ml', '750ml'],
    ['375ml', '375ml'],
    ['375 ml', '375ml'],
    ['700ml', '700ml'],
    ['1.5L', '1500ml'],
    ['1.5 L', '1500ml'],
    ['3.0L', '3000ml'],
    ['6.0L', '6000ml'],
    ['500ml', '500ml'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeBottleSize(input)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// Regression: existing formats are untouched by the CT work
// ---------------------------------------------------------------------------
describe('non-CT formats are unaffected', () => {
  it('Vivino rows map exactly as before', () => {
    const csv = 'Wine name,Winery,Vintage,Country,Wine type,Rating\nMargaux,Chateau Margaux,2015,France,Red,4.5';
    const result = parseAndMap(csv);
    expect(result.format).toBe('vivino');
    expect(result.items[0]).toMatchObject({
      wineName: 'Margaux',
      producer: 'Chateau Margaux',
      rating: 4.5,
      ratingScale: '5',
    });
    expect(result.items[0].grapes).toBeUndefined();
    expect(result.warnings).toBeUndefined();
  });

  it('generic rows map exactly as before (quantity 0 still means 1 bottle)', () => {
    const csv = 'Wine,Producer,Vintage,Quantity\nSassicaia,Tenuta San Guido,2017,0';
    const result = parseAndMap(csv);
    expect(result.format).toBe('generic');
    expect(result.items).toHaveLength(1); // generic mapper clamps qty < 1 to 1
  });

  it('Cellarion CSV still passes through unchanged', () => {
    const csv = 'wineName,producer,vintage,quantity\nMargaux,Chateau Margaux,2015,2';
    const result = parseAndMap(csv);
    expect(result.format).toBe('cellarion');
    expect(result.items).toHaveLength(2);
  });
});
