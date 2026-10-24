/**
 * Oeno-by-Vintec export — quoting inside bottle notes.
 *
 * The Oeno parser splits the file into records and cells with the same
 * boundary-aware rules as parseCSV: a newline inside a quoted Bottle Note is
 * part of the note, not the end of the record, and a double quote that is not
 * at a field boundary (an inch mark, written doubled or not) is a literal
 * character that never swallows the columns after it.
 */
import { describe, it, expect } from 'vitest';
import { parseOenoExport, parseAndMap } from './importMappers';

// Bare dialect: unquoted cells, quotes only where a cell holds a comma.
const BARE = [
  'Cabinet ID,Cabinet Label,Cabinet Brand,Cabinet Model,Column Index,Shelf Index,Layer Index,Layer ID,Disabled Slots,Total Slots,Empty Slots,Cabinet Added Date,Cabinet Purchased Date,Unshelved Bottle Count',
  '10001,Main Cellar,TRANSTHERM,Espace Cellar,3,18,1,1001,"6, 5",702,30,2024-07-05,,0',
  '10001,Main Cellar,TRANSTHERM,Espace Cellar,4,13,1,1004,0,702,30,2024-07-05,,0',
  '',
  'User Bottles Details',
  '',
  'Bottle ID,Cabinet ID,Column ID,Shelf ID,Layer ID,Slot,Bottle Size Liters,Wine Year,Wine Type,Bottle Note,Wine Title,Wine Country,Wine Region,Wine Winery,Purchase Cost,Purchase Currency,Purchase Date,Opened On,Consumed On',
  '5001,10001,500,5500,1001,5,0.75,2018,Red Wine,NOTE_A,Test Wine A,NZ,Test Region,Producer A,30.50,NZD,2024-10-30,,',
  '5002,null,null,null,null,null,0.75,2014,Red Wine,,Test Wine B,NZ,Test Region,Producer B,null,NZD,2024-10-30,,2024-11-26',
  '5003,10001,500,5502,1004,3,0.75,2019,White Wine,NOTE_C,Test Wine C,NZ,Test Region,Producer C,42,NZD,2024-10-30,,',
].join('\n');

// Quoted dialect: every cell quoted, title block above the cabinet header.
const QUOTED = [
  ',,,,,,,,,,,,,',
  '"User Cabinets Details With Unshelved Bottle Count"',
  ',,,,,,,,,,,,,',
  '"Cabinet ID","Cabinet Label","Cabinet Brand","Cabinet Model","Column Index","Shelf Index","Layer Index","Layer ID","Disabled Slots","Total Slots","Empty Slots","Cabinet Added Date","Cabinet Purchased Date","Unshelved Bottle Count"',
  '"43999","Darcy big","Vintec","VWM148SBA","1","1","1","820798","0","122","0","2025-10-26","","0"',
  '"43999","Darcy big","Vintec","VWM148SBA","1","1","2","820799","0","122","0","2025-10-26","","0"',
  ',,,,,,,,,,,,,',
  '"User Bottles Details"',
  ',,,,,,,,,,,,,,,,,,',
  '"Bottle ID","Cabinet ID","Column ID","Shelf ID","Layer ID","Slot","Bottle Size Liters","Wine Year","Wine Type","Bottle Note","Wine Title","Wine Country","Wine Region","Wine Winery","Purchase Cost","Purchase Currency","Purchase Date","Opened On","Consumed On"',
  '"1001","43999","72709","396601","820798","5","0.375","2018","Dessert Wine","NOTE_A","Sauternes","FR","Sauternes","Producer S","900.0","AUD","2025-10-26","",""',
  '"1002","43999","72709","396601","820799","4","0.75","2023","White Wine","","Riesling Kabinett","DE","Graach","Producer R","143.3","AUD","2025-10-26","",""',
  '"1003","null","null","null","null","null","0.75","1998","Red Wine","NOTE_C","Shiraz","AU","South Australia","Producer G","null","AUD","2002-10-02","","2026-02-28"',
  ',,,,,,,,,,,,,,,,,,',
].join('\n');

const bare = (noteA, noteC = '') => BARE.replace('NOTE_A', noteA).replace('NOTE_C', noteC);
const quoted = (noteA, noteC = '') => QUOTED.replace('"NOTE_A"', noteA).replace('"NOTE_C"', noteC);

describe('parseOenoExport — quoted multi-line Bottle Notes', () => {
  it('keeps a newline inside a quoted note as part of that bottle (bare dialect)', () => {
    const result = parseOenoExport(bare('"Aged on lees.\nDecant an hour."'));
    expect(result.items).toHaveLength(3);
    expect(result.items.map((i) => i.wineName)).toEqual(['Test Wine A', 'Test Wine B', 'Test Wine C']);
    expect(result.items[0]).toMatchObject({
      notes: 'Aged on lees.\nDecant an hour.',
      producer: 'Producer A',
      vintage: '2018',
      price: 30.5,
      currency: 'NZD',
      rackName: 'Main Cellar – Module 3',
      slotInLayer: 5,
    });
  });

  it('keeps a multi-line note in the fully quoted dialect, and the boundary is still found', () => {
    const text = quoted('"Opened for a dinner.\nStill closed."', '"Line one\n\nLine three, with a comma"');
    const result = parseAndMap(text);
    expect(result.format).toBe('oeno-export');
    expect(result.items).toHaveLength(3);
    expect(result.items.map((i) => i.wineName)).toEqual(['Sauternes', 'Riesling Kabinett', 'Shiraz']);
    expect(result.items[0]).toMatchObject({ notes: 'Opened for a dinner.\nStill closed.', producer: 'Producer S', price: 900 });
    expect(result.items[2]).toMatchObject({
      notes: 'Line one\n\nLine three, with a comma',
      producer: 'Producer G',
      addToHistory: true,
      consumedAt: '2026-02-28',
    });
  });

  it('handles CRLF line endings around a multi-line note', () => {
    const text = bare('"First line\nsecond line"').replace(/\n(?!second)/g, '\r\n');
    const result = parseOenoExport(text);
    expect(result.items).toHaveLength(3);
    expect(result.items[0]).toMatchObject({ wineName: 'Test Wine A', notes: 'First line\nsecond line', producer: 'Producer A' });
    expect(result.items[2]).toMatchObject({ wineName: 'Test Wine C', producer: 'Producer C', price: 42 });
  });
});

describe('parseOenoExport — inch marks in Bottle Notes', () => {
  it('reads an RFC-doubled inch mark inside a quoted note', () => {
    const result = parseOenoExport(bare('"Magnum, 2"" taller"'));
    expect(result.items[0]).toMatchObject({
      notes: 'Magnum, 2" taller',
      wineName: 'Test Wine A',
      country: 'NZ',
      producer: 'Producer A',
      price: 30.5,
    });
  });

  it('an undoubled inch mark in a bare note does not swallow the later columns', () => {
    const result = parseOenoExport(bare('Poured a 2" taste', 'Cork 1.5" long'));
    expect(result.items).toHaveLength(3);
    expect(result.items[0]).toMatchObject({
      notes: 'Poured a 2" taste',
      wineName: 'Test Wine A',
      country: 'NZ',
      region: 'Test Region',
      producer: 'Producer A',
      price: 30.5,
      currency: 'NZD',
      purchaseDate: '2024-10-30',
    });
    expect(result.items[2]).toMatchObject({ notes: 'Cork 1.5" long', wineName: 'Test Wine C', producer: 'Producer C', price: 42 });
  });

  it('an undoubled inch mark inside a quoted note does not swallow the later columns', () => {
    const result = parseOenoExport(quoted('"Magnum 2" taller"'));
    expect(result.items).toHaveLength(3);
    expect(result.items[0]).toMatchObject({
      notes: 'Magnum 2" taller',
      wineName: 'Sauternes',
      country: 'FR',
      producer: 'Producer S',
      price: 900,
      currency: 'AUD',
      rackName: 'Darcy big',
      slotInLayer: 5,
    });
  });
});

describe('parseOenoExport — a quote that opens a bare cell', () => {
  // The bare dialect does not escape quotes, so a cell may open with a quoted
  // word whose closing quote is not at a field boundary. That quote must not
  // swallow the rest of the file, and its row still reads as before.
  it('keeps every bottle when a bare note starts with a quoted word', () => {
    const result = parseOenoExport(bare('"Reserve" bottle for Dad'));
    expect(result.items.map((i) => i.wineName)).toEqual(['Test Wine A', 'Test Wine B', 'Test Wine C']);
    expect(result.items[0]).toMatchObject({ notes: 'Reserve bottle for Dad', producer: 'Producer A', country: 'NZ' });
  });

  it('still finds the bottle section when a cabinet label starts with a quoted word', () => {
    const text = bare('').replace('Main Cellar,TRANSTHERM,Espace Cellar,4,13', '"Big" Vintec,TRANSTHERM,Espace Cellar,4,13');
    const result = parseOenoExport(text);
    expect(result).not.toBeNull();
    expect(result.items.map((i) => i.wineName)).toEqual(['Test Wine A', 'Test Wine B', 'Test Wine C']);
  });

  it('reads a later quoted multi-line note after such a quote', () => {
    const result = parseOenoExport(bare('"Reserve" bottle for Dad', '"Aged on lees.\nDecant an hour."'));
    expect(result.items.map((i) => i.wineName)).toEqual(['Test Wine A', 'Test Wine B', 'Test Wine C']);
    expect(result.items[0].notes).toBe('Reserve bottle for Dad');
    expect(result.items[2].notes).toBe('Aged on lees.\nDecant an hour.');
  });

  it('parseAndMap reads such a file as an Oeno export', () => {
    const result = parseAndMap(bare('"Reserve" bottle for Dad'));
    expect(result.format).toBe('oeno-export');
    expect(result.items).toHaveLength(3);
  });
});
