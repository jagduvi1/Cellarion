/**
 * Ploc import — the three-file join.
 *
 * Ploc exports a SET of files that only mean anything together: the wines with
 * their stock counts, the slots that say where each bottle physically sits, and
 * the purchase/consumption log. They are joined on a GUID that Ploc writes in
 * mixed case, and the file names are French whatever the app language is (and
 * the first real samples arrived renamed), so everything here keys off columns.
 *
 * The fixtures are trimmed from a real export sent by a migrating user, keeping
 * every shape that bit: percentage-prefixed grape lists, an "Apogee" window,
 * Magnum formats, wines with no producer, a leading space in a wine name, and
 * mixed-case GUIDs between the wines file and the slots file.
 */
import { describe, it, expect } from 'vitest';
import {
  detectPlocFile,
  parsePlocFiles,
  parsePlocGrapes,
  parsePlocApogee,
  buildPlocDateParser,
  inferPlocRatingScale,
  parseCSV,
  detectDelimiter,
  getDefaultRackConfig,
} from './importMappers';

const WINES = [
  'Wine name;Vintage;Color;Stock;Stock (en cave);Producer;Country;Region;Appellation;Grapes;Bottle format;Classification;Cuvee;Degree of alcohol;Reference;Tags;Apogee;Service temperature;Estimate;Note;Comments;IdVin;IdContact;IdDocument;IdDocumentCouverture',
  'Château Grand Puy Lacoste;2009;Red;12;12;Château Grand-Puy-Lacoste;France;Bordeaux;Pauillac;80% Cabernet Sauvignon,18% Merlot,2% Cabernet Franc;Bottle;5ème Cru Classé;;13.5;;;2025/2029;16;90;;;7406D964-D766-4FC6-9DC6-FD634BFC4703;;A5C05F57;',
  'Benjamin Leroux Meursault 1er Cru  Charmes-Dessus;2019;White;1;1;Maison & Domaine Leroux;France;Burgundy;Meursault;Chardonnay;Magnum;1er Cru;;13.5;;;;12;170;;;b76416fd-f3e7-4870-a1aa-23297fa5c6f6;;c53cbb99;',
  ' Billecart Salmon Brut Rosé;;Sparkling;10;10;Champagne Billecart-Salmon;France;Champagne;Champagne;Chardonnay, Pinot Meunier, Pinot Noir;Bottle;;;12;;;;8;70;;;fb9b64ed-753f-40a2-a0be-2eb4ad5eb78f;;739771f9;',
  'Corton Charlemagne Grand Cru Henri Boillot;2023;White;4;4;;France;Burgundy;Charlemagne;;;;;;;;;;400;;;7F693272-EDD0-4293-9A57-E8307FFC534E;;95304694;',
  'Château Suduiraut;1989;Sweet;2;2;Château Suduiraut;France;Bordeaux;Sauternes;Sauvignon Blanc, Sémillon;Bottle;1er Cru Classé;;;;;;8;50;;;215d3dd5-a91a-42a9-9a4f-0958b4a5a282;;4edbb00b;',
].join('\n');

const CELLARS = [
  'Name;Row;Column;Wine name;Vintage;IdVin',
  'Column H - Red Bordeaux £70-£100;2;1;Château Grand Puy Lacoste;2009;7406D964-D766-4FC6-9DC6-FD634BFC4703',
  'Column H - Red Bordeaux £70-£100;4;6;Château Grand Puy Lacoste;2009;7406d964-d766-4fc6-9dc6-fd634bfc4703',
  'Column I - Red Burgundy £75-£200;19;5;Benjamin Leroux Meursault;2019;b76416fd-f3e7-4870-a1aa-23297fa5c6f6',
  'Column L - Sweet wines;5;5;Château Suduiraut;1989;215d3dd5-a91a-42a9-9a4f-0958b4a5a282',
  'Column L - Sweet wines;1;1;;;',
  'Column L - Sweet wines;6;7;;;',
].join('\n');

const HISTORY = [
  'Date;Wine name;Vintage;Purchase;Consumption;Unit price;Selling price;Currency;Opportunity;Vendor;Comments;IdContact;IdVin',
  '12/03/2024;Château Suduiraut;1989;3;0;45;0;£;;Berry Bros;;;215d3dd5-a91a-42a9-9a4f-0958b4a5a282',
  '28/06/2025;Château Suduiraut;1989;0;1;0;0;£;Anniversary dinner;;Still fresh;;215d3dd5-a91a-42a9-9a4f-0958b4a5a282',
  '02/12/2025;Château Grand Puy Lacoste;2009;12;0;72;0;£;;Farr Vintners;;;7406D964-D766-4FC6-9DC6-FD634BFC4703',
].join('\n');

const headersOf = (text) => Object.keys(parseCSV(text, detectDelimiter(text))[0]);
const bottlesOf = (items, match) => items.filter((i) => match.test(i.wineName));

describe('recognising Ploc files by their columns, never their name', () => {
  it('tells the three files apart', () => {
    expect(detectPlocFile(headersOf(WINES))).toBe('wines');
    expect(detectPlocFile(headersOf(CELLARS))).toBe('cellars');
    expect(detectPlocFile(headersOf(HISTORY))).toBe('history');
  });

  it('recognises the French headers of a French-locale export', () => {
    expect(detectPlocFile(['Nom du vin', 'Millésime', 'Stock', 'IdVin'])).toBe('wines');
    expect(detectPlocFile(['Nom', 'Ligne', 'Colonne', 'IdVin'])).toBe('cellars');
    expect(detectPlocFile(['Date', 'Achat', 'Conso', 'IdVin'])).toBe('history');
  });

  it('is not fooled by another app that happens to have a Stock column', () => {
    expect(detectPlocFile(['Wine', 'Vintage', 'Stock'])).toBeNull();
    expect(detectPlocFile(['Wine name', 'Producer', 'Quantity'])).toBeNull();
  });
});

describe('field mapping', () => {
  const { items, warnings } = parsePlocFiles({ wines: WINES, cellars: CELLARS, history: HISTORY });

  it('expands each wine into one item per bottle in stock', () => {
    expect(bottlesOf(items, /Grand Puy/)).toHaveLength(12);
    expect(bottlesOf(items, /Billecart/)).toHaveLength(10);
    expect(bottlesOf(items, /Corton/)).toHaveLength(4);
  });

  it('strips blend percentages, which are proportions and not variety names', () => {
    expect(parsePlocGrapes('80% Cabernet Sauvignon,18% Merlot,2% Cabernet Franc'))
      .toEqual(['Cabernet Sauvignon', 'Merlot', 'Cabernet Franc']);
    expect(bottlesOf(items, /Grand Puy/)[0].grapes).toEqual(['Cabernet Sauvignon', 'Merlot', 'Cabernet Franc']);
  });

  it('maps colour to wine type, with Sweet meaning dessert', () => {
    expect(bottlesOf(items, /Grand Puy/)[0].type).toBe('red');
    expect(bottlesOf(items, /Billecart/)[0].type).toBe('sparkling');
    expect(bottlesOf(items, /Suduiraut/)[0].type).toBe('dessert');
  });

  it('reads the Apogee window onto the bottle', () => {
    expect(parsePlocApogee('2025/2029')).toEqual({ drinkFrom: 2025, drinkTo: 2029 });
    expect(parsePlocApogee('2030')).toEqual({ drinkFrom: 2030 });
    expect(parsePlocApogee('')).toEqual({});
    expect(bottlesOf(items, /Grand Puy/)[0]).toMatchObject({ drinkFrom: 2025, drinkTo: 2029 });
  });

  it('maps the bottle format, and trims the stray leading space in a wine name', () => {
    expect(bottlesOf(items, /Leroux/)[0].bottleSize).toBe('1500ml');
    expect(bottlesOf(items, /Grand Puy/)[0].bottleSize).toBe('750ml');
    expect(items.some((i) => i.wineName === 'Billecart Salmon Brut Rosé')).toBe(true);
  });

  it('keeps a wine with no producer and no vintage rather than dropping it', () => {
    const corton = bottlesOf(items, /Corton/)[0];
    expect(corton.producer).toBeUndefined();
    expect(corton.region).toBe('Burgundy');
    const billecart = bottlesOf(items, /Billecart/)[0];
    expect(billecart.vintage).toBe('NV');
  });

  it('does not import the producer address-book reference', () => {
    for (const item of items) expect(item.IdContact).toBeUndefined();
  });

  it('says nothing about ratings when the file carries none', () => {
    expect(inferPlocRatingScale(['', '', ''])).toBeNull();
    expect(items.every((i) => i.rating === undefined)).toBe(true);
    expect(warnings.find((w) => w.code === 'ploc-rating-scale')).toBeUndefined();
  });
});

describe('rating scale, which the file never states', () => {
  it('infers the scale from the values present', () => {
    expect(inferPlocRatingScale(['4', '5', '3'])).toBe('5');
    expect(inferPlocRatingScale(['16', '18.5'])).toBe('20');
    expect(inferPlocRatingScale(['92', '88'])).toBe('100');
  });

  it('carries the assumption into the items and warns about it', () => {
    const wines = WINES.replace(';16;90;;;7406D964', ';16;90;92;;7406D964');
    const { items, warnings } = parsePlocFiles({ wines });
    expect(warnings).toContainEqual({ code: 'ploc-rating-scale', scale: '100' });
    expect(bottlesOf(items, /Grand Puy/)[0]).toMatchObject({ rating: 92, ratingScale: '100' });
  });
});

describe('slots become exact rack placements', () => {
  const { items, rackSpecs, warnings } = parsePlocFiles({ wines: WINES, cellars: CELLARS, history: HISTORY });

  it('sizes each rack from the furthest slot actually used, empty ones included', () => {
    // "Column L" holds one bottle, but its empty slots reach row 6, column 7.
    expect(rackSpecs['Column L - Sweet wines']).toEqual({ type: 'grid', rows: 6, cols: 7, typeConfig: {} });
    expect(rackSpecs['Column I - Red Burgundy £75-£200']).toEqual({ type: 'grid', rows: 19, cols: 5, typeConfig: {} });
  });

  it('places bottles at their own row and column, matching the GUID case-insensitively', () => {
    const gpl = bottlesOf(items, /Grand Puy/).filter((i) => i.rackName);
    expect(gpl).toHaveLength(2); // two slot rows, one of them lower-cased in the file
    expect(gpl.map((i) => [i.row, i.col])).toEqual([[2, 1], [4, 6]]);
    expect(gpl[0].rackName).toBe('Column H - Red Bordeaux £70-£100');
  });

  it('leaves stock beyond the recorded slots unplaced rather than inventing positions', () => {
    const gpl = bottlesOf(items, /Grand Puy/);
    expect(gpl.filter((i) => i.rackName)).toHaveLength(2);
    expect(gpl.filter((i) => !i.rackName)).toHaveLength(10);
    expect(warnings.find((w) => w.code === 'ploc-placed')).toMatchObject({ count: 4 });
  });

  it('offers the stated geometry to the review screen ahead of any guess', () => {
    const spec = rackSpecs['Column I - Red Burgundy £75-£200'];
    expect(getDefaultRackConfig('ploc', { rackSpec: spec, count: 1, maxPosition: 0 })).toBe(spec);
  });

  it('refuses to distort a rack larger than the schema allows', () => {
    const big = ['Name;Row;Column;Wine name;Vintage;IdVin', 'Huge;41;3;x;2020;abc'].join('\n');
    const { rackSpecs: specs, warnings: w } = parsePlocFiles({ wines: WINES, cellars: big });
    expect(specs.Huge).toBeUndefined();
    expect(w).toContainEqual({ code: 'ploc-rack-too-big', rack: 'Huge', rows: 41, cols: 3 });
  });
});

describe('purchase and consumption history', () => {
  const { items, warnings } = parsePlocFiles({ wines: WINES, cellars: CELLARS, history: HISTORY });
  const suduiraut = bottlesOf(items, /Suduiraut/);

  it('creates a consumed bottle for every bottle drunk, on top of what is still held', () => {
    // Stock says 2 remain; the log says 3 were bought and 1 drunk.
    expect(suduiraut).toHaveLength(3);
    expect(suduiraut.filter((i) => i.addToHistory)).toHaveLength(1);
    expect(suduiraut.filter((i) => !i.addToHistory)).toHaveLength(2);
    expect(warnings.find((w) => w.code === 'ploc-history')).toMatchObject({ count: 1 });
  });

  it('carries the date, occasion and note onto the consumed bottle', () => {
    const drunk = suduiraut.find((i) => i.addToHistory);
    expect(drunk).toMatchObject({
      consumedReason: 'drank',
      consumedAt: '2025-06-28',
      occasion: 'Anniversary dinner',
      consumedNote: 'Still fresh',
    });
  });

  it('gives every bottle its real purchase date, price and vendor', () => {
    for (const b of suduiraut) {
      expect(b.purchaseDate).toBe('2024-03-12');
      expect(b.price).toBe(45);          // what it cost, not the 50 estimate
      expect(b.currency).toBe('GBP');    // from the "£" symbol
      expect(b.purchaseLocation).toBe('Berry Bros');
    }
  });

  it('falls back to the estimated value when nothing was ever purchased', () => {
    const corton = bottlesOf(items, /Corton/)[0];
    expect(corton.price).toBe(400);
    expect(corton.purchaseDate).toBeUndefined();
  });

  it('imports stock only when no history file is given', () => {
    const { items: only, warnings: w } = parsePlocFiles({ wines: WINES, cellars: CELLARS });
    expect(only.some((i) => i.addToHistory)).toBe(false);
    expect(bottlesOf(only, /Suduiraut/)).toHaveLength(2);
    expect(w).toContainEqual({ code: 'ploc-no-history' });
  });

  it('reports history rows whose wine is not in the wines file', () => {
    const orphan = `${HISTORY}\n01/01/2025;Ghost;2020;1;0;10;0;£;;;;;deadbeef-0000-0000-0000-000000000000`;
    const { warnings: w } = parsePlocFiles({ wines: WINES, history: orphan });
    expect(w).toContainEqual({ code: 'ploc-unmatched-history', count: 1 });
  });
});

describe('dates, whose format Ploc never states', () => {
  it('learns the order from a row that can only be read one way', () => {
    const dmy = buildPlocDateParser(['12/03/2024', '28/06/2025']); // 28 can only be a day
    expect(dmy.dayFirst).toBe(true);
    expect(dmy.inferred).toBe(true);
    expect(dmy.parse('12/03/2024')).toBe('2024-03-12');

    const mdy = buildPlocDateParser(['8/31/26', '1/2/26']); // 31 can only be a day
    expect(mdy.dayFirst).toBe(false);
    expect(mdy.parse('1/2/26')).toBe('2026-01-02');
    expect(mdy.parse('8/31/26')).toBe('2026-08-31');
  });

  it('assumes day-first when nothing in the file settles it, and says so', () => {
    const p = buildPlocDateParser(['01/02/2026', '03/04/2026']);
    expect(p.inferred).toBe(false);
    expect(p.parse('01/02/2026')).toBe('2026-02-01');
    const { warnings } = parsePlocFiles({
      wines: WINES,
      history: 'Date;Purchase;Consumption;IdVin\n01/02/2026;1;0;215d3dd5-a91a-42a9-9a4f-0958b4a5a282',
    });
    expect(warnings).toContainEqual({ code: 'ploc-date-order-assumed', dayFirst: true });
  });

  it('reads ISO and Unix seconds without guessing at all', () => {
    const p = buildPlocDateParser([]);
    expect(p.parse('2026-08-31')).toBe('2026-08-31');
    expect(p.parse('1788134400')).toMatch(/^2026-/);
    expect(p.parse('')).toBeUndefined();
    expect(p.parse('not a date')).toBeUndefined();
    expect(p.parse('2026')).toBeUndefined();      // a bare year is not an epoch
    expect(p.parse('45/45/2026')).toBeUndefined(); // impossible, not silently coerced
  });
});

describe('what the import refuses to do', () => {
  it('needs the wines file, because stock counts live only there', () => {
    expect(() => parsePlocFiles({ cellars: CELLARS })).toThrow(/wines file is required/);
    expect(() => parsePlocFiles({})).toThrow();
  });

  it('imports the wines file alone, with everything unplaced', () => {
    const { items, warnings } = parsePlocFiles({ wines: WINES });
    expect(items).toHaveLength(29); // 12 + 1 + 10 + 4 + 2
    expect(items.every((i) => !i.rackName)).toBe(true);
    expect(warnings).toContainEqual({ code: 'ploc-no-cellars' });
  });

  it('gives each bottle its own grape array, so editing one cannot change another', () => {
    const { items } = parsePlocFiles({ wines: WINES });
    const gpl = bottlesOf(items, /Grand Puy/);
    gpl[0].grapes.push('Petit Verdot');
    expect(gpl[1].grapes).toEqual(['Cabernet Sauvignon', 'Merlot', 'Cabernet Franc']);
  });
});
