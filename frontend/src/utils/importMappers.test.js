import {
  parseCSV,
  detectFormat,
  detectDelimiter,
  parseJSON,
  parseAndMap,
  parseCombinedRackLocation,
  parseOenoExport,
  detectOenoExportBoundary,
  parseLocaleNumber,
} from './importMappers';

// ---------------------------------------------------------------------------
// parseCSV
// ---------------------------------------------------------------------------
describe('parseCSV', () => {
  it('parses simple CSV with header and data rows', () => {
    const csv = 'Name,Vintage,Country\nChateau Margaux,2015,France\nOpus One,2018,USA';
    const rows = parseCSV(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ Name: 'Chateau Margaux', Vintage: '2015', Country: 'France' });
    expect(rows[1]).toEqual({ Name: 'Opus One', Vintage: '2018', Country: 'USA' });
  });

  it('handles newlines inside quoted fields by keeping them on one logical line', () => {
    // The outer quote-aware parser joins multi-line quoted content into one line.
    // Quote characters are stripped by the outer loop, but newlines within quotes
    // are preserved as part of the field content rather than splitting the row.
    const csv = 'Name,Notes\n"Wine A","Line1\nLine2"\nWine B,Simple';
    const rows = parseCSV(csv);
    // Wine A and its notes are on the same logical row due to quotes around newline
    expect(rows).toHaveLength(2);
    expect(rows[0].Name).toBe('Wine A');
    expect(rows[0].Notes).toBe('Line1\nLine2');
    expect(rows[1].Name).toBe('Wine B');
    expect(rows[1].Notes).toBe('Simple');
  });

  it('returns empty array for single line (header only, no data rows)', () => {
    const csv = 'Name,Vintage,Country';
    const rows = parseCSV(csv);
    expect(rows).toEqual([]);
  });

  it('returns empty array for empty string', () => {
    expect(parseCSV('')).toEqual([]);
  });

  it('works with semicolon delimiter', () => {
    const csv = 'Name;Vintage;Country\nMargaux;2015;France';
    const rows = parseCSV(csv, ';');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ Name: 'Margaux', Vintage: '2015', Country: 'France' });
  });

  it('works with tab delimiter', () => {
    const csv = 'Name\tVintage\nMargaux\t2015';
    const rows = parseCSV(csv, '\t');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ Name: 'Margaux', Vintage: '2015' });
  });

  it('skips empty rows', () => {
    const csv = 'Name,Vintage\nMargaux,2015\n\n\nOpus One,2018';
    const rows = parseCSV(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0].Name).toBe('Margaux');
    expect(rows[1].Name).toBe('Opus One');
  });

  it('handles CRLF line endings', () => {
    const csv = 'Name,Vintage\r\nMargaux,2015\r\nOpus One,2018';
    const rows = parseCSV(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0].Name).toBe('Margaux');
  });

  it('handles missing values (fewer columns than headers)', () => {
    const csv = 'Name,Vintage,Country\nMargaux,2015';
    const rows = parseCSV(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0].Country).toBe('');
  });
});

// ---------------------------------------------------------------------------
// detectFormat
// ---------------------------------------------------------------------------
describe('detectFormat', () => {
  it('returns "vivino" for Vivino headers', () => {
    expect(detectFormat(['Wine name', 'Winery', 'Vintage'])).toBe('vivino');
  });

  it('returns "vivino" when "Wine Name" header is present (case-insensitive)', () => {
    expect(detectFormat(['Wine Name', 'Region', 'Rating'])).toBe('vivino');
  });

  it('returns "vivino" when "Winery" header is present', () => {
    expect(detectFormat(['Producer', 'Winery', 'Year'])).toBe('vivino');
  });

  it('returns "cellartracker" for CellarTracker headers with iWine', () => {
    expect(detectFormat(['iWine', 'Wine', 'Vintage'])).toBe('cellartracker');
  });

  it('returns "cellartracker" for CellarTracker headers with Barcode', () => {
    expect(detectFormat(['Barcode', 'Wine', 'Vintage'])).toBe('cellartracker');
  });

  it('returns "cellartracker" when Wine+Vintage+Locale headers are present', () => {
    expect(detectFormat(['Wine', 'Vintage', 'Locale'])).toBe('cellartracker');
  });

  it('returns "cellartracker" when Wine+Vintage+Bin headers are present', () => {
    expect(detectFormat(['Wine', 'Vintage', 'Bin'])).toBe('cellartracker');
  });

  it('returns "cellarion" for own format with camelCase headers', () => {
    expect(detectFormat(['wineName', 'producer', 'vintage'])).toBe('cellarion');
  });

  it('returns "generic" for unknown headers', () => {
    expect(detectFormat(['Col A', 'Col B', 'Col C'])).toBe('generic');
  });

  it('returns "generic" for empty headers', () => {
    expect(detectFormat([])).toBe('generic');
  });
});

// ---------------------------------------------------------------------------
// detectDelimiter
// ---------------------------------------------------------------------------
describe('detectDelimiter', () => {
  it('returns tab for tab-separated text', () => {
    expect(detectDelimiter('Name\tVintage\tCountry\nMargaux\t2015\tFrance')).toBe('\t');
  });

  it('returns semicolon for semicolon-separated text', () => {
    expect(detectDelimiter('Name;Vintage;Country\nMargaux;2015;France')).toBe(';');
  });

  it('returns comma for comma-separated text (default)', () => {
    expect(detectDelimiter('Name,Vintage,Country\nMargaux,2015,France')).toBe(',');
  });

  it('returns comma when no delimiter is found', () => {
    expect(detectDelimiter('JustOneColumn\nValue')).toBe(',');
  });

  it('prefers tab over semicolon when both are present on first line', () => {
    // Tab is checked first, so it wins
    expect(detectDelimiter('Name\tVintage;Country')).toBe('\t');
  });
});

// ---------------------------------------------------------------------------
// parseLocaleNumber — locale-aware replacement for parseFloat in CSV imports.
// Catches the EU-decimal bug where parseFloat('1.234,56') returned 1.234.
// ---------------------------------------------------------------------------
describe('parseLocaleNumber', () => {
  describe('invalid input', () => {
    it('returns NaN for null/undefined/empty/whitespace', () => {
      expect(parseLocaleNumber(null)).toBeNaN();
      expect(parseLocaleNumber(undefined)).toBeNaN();
      expect(parseLocaleNumber('')).toBeNaN();
      expect(parseLocaleNumber('   ')).toBeNaN();
    });

    it('returns NaN for non-numeric strings', () => {
      expect(parseLocaleNumber('abc')).toBeNaN();
      expect(parseLocaleNumber('-')).toBeNaN();
      expect(parseLocaleNumber('+')).toBeNaN();
    });
  });

  describe('plain numbers (no separator)', () => {
    it('parses positive integers', () => {
      expect(parseLocaleNumber('260')).toBe(260);
      expect(parseLocaleNumber('0')).toBe(0);
      expect(parseLocaleNumber('1')).toBe(1);
    });

    it('accepts numeric input directly', () => {
      expect(parseLocaleNumber(260)).toBe(260);
      expect(parseLocaleNumber(0.75)).toBe(0.75);
    });
  });

  describe('US format (period decimal, comma thousands)', () => {
    it('parses simple US decimals', () => {
      expect(parseLocaleNumber('1234.56')).toBe(1234.56);
      expect(parseLocaleNumber('0.75')).toBe(0.75);
      expect(parseLocaleNumber('260.00')).toBe(260);
    });

    it('parses US thousands+decimal', () => {
      expect(parseLocaleNumber('1,234.56')).toBe(1234.56);
      expect(parseLocaleNumber('1,234,567.89')).toBe(1234567.89);
    });

    it('parses US thousands only (3 digits after comma)', () => {
      expect(parseLocaleNumber('1,234')).toBe(1234);
      expect(parseLocaleNumber('12,345')).toBe(12345);
      expect(parseLocaleNumber('1,234,567')).toBe(1234567);
    });
  });

  describe('EU format (comma decimal, period thousands)', () => {
    it('parses simple EU decimals — the production bug case', () => {
      // parseFloat('1234,56') returned 1234 — losing the .56
      expect(parseLocaleNumber('1234,56')).toBe(1234.56);
      // parseFloat('0,75') returned 0 — bottle size was wrong
      expect(parseLocaleNumber('0,75')).toBe(0.75);
      // parseFloat('260,00') accidentally returned 260, which was right
      expect(parseLocaleNumber('260,00')).toBe(260);
    });

    it('parses EU thousands+decimal', () => {
      // parseFloat('1.234,56') returned 1.234 — 1000x too low
      expect(parseLocaleNumber('1.234,56')).toBe(1234.56);
      expect(parseLocaleNumber('1.234.567,89')).toBe(1234567.89);
    });

    it('parses Swedish space-separated thousands', () => {
      expect(parseLocaleNumber('1 234,56')).toBe(1234.56);
      expect(parseLocaleNumber('1 234 567,89')).toBe(1234567.89);
    });

    it('treats "0,375" with leading zero as bottle-size decimal, not thousands', () => {
      expect(parseLocaleNumber('0,375')).toBe(0.375);  // 375ml in litres
      expect(parseLocaleNumber('0,75')).toBe(0.75);    // 750ml in litres
    });

    it('parses EU thousands when no decimal is present', () => {
      // Multiple periods unambiguously = EU thousands
      expect(parseLocaleNumber('1.234.567')).toBe(1234567);
    });

    it('keeps a single period as US-style decimal (asymmetric to comma)', () => {
      // "1.234" is ambiguous (could be 1.234 US-decimal or 1234 EU-thousands).
      // We pick US-decimal because bottle sizes like "0.375" / "1.5" are
      // common in litres, and the multi-period case handles real EU
      // thousands ("1.234.567") correctly.
      expect(parseLocaleNumber('1.234')).toBe(1.234);
      expect(parseLocaleNumber('1.5')).toBe(1.5);
      expect(parseLocaleNumber('0.375')).toBe(0.375);
    });
  });

  describe('currency symbols and trailing words', () => {
    it('strips $ € £ ¥ and similar leading symbols', () => {
      expect(parseLocaleNumber('$25.00')).toBe(25);
      expect(parseLocaleNumber('€25,00')).toBe(25);
      expect(parseLocaleNumber('£1,234.56')).toBe(1234.56);
      expect(parseLocaleNumber('¥1000')).toBe(1000);
    });

    it('strips trailing currency words', () => {
      expect(parseLocaleNumber('25 kr')).toBe(25);
      expect(parseLocaleNumber('260 USD')).toBe(260);
      expect(parseLocaleNumber('1234,56 EUR')).toBe(1234.56);
    });
  });

  describe('drop-in replacement compatibility', () => {
    it('matches parseFloat behaviour on plain US numbers', () => {
      const cases = ['25.00', '260', '0.75', '1234.56', '0'];
      for (const c of cases) {
        expect(parseLocaleNumber(c)).toBe(parseFloat(c));
      }
    });

    it('FIXES the parseFloat bugs that broke EU imports', () => {
      // These are the EU-format inputs that parseFloat got wrong
      expect(parseFloat('1.234,56')).toBe(1.234);   // bug: should be 1234.56
      expect(parseLocaleNumber('1.234,56')).toBe(1234.56);

      expect(parseFloat('0,75')).toBe(0);           // bug: bottle size → 0ml
      expect(parseLocaleNumber('0,75')).toBe(0.75);

      expect(parseFloat('1,234.56')).toBe(1);       // bug: US thousands lost everything
      expect(parseLocaleNumber('1,234.56')).toBe(1234.56);
    });
  });
});

// ---------------------------------------------------------------------------
// parseJSON
// ---------------------------------------------------------------------------
describe('parseJSON', () => {
  it('parses an array of bottles', () => {
    const json = JSON.stringify([
      { wineName: 'Margaux', producer: 'Chateau Margaux', vintage: '2015' },
    ]);
    const result = parseJSON(json);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].wineName).toBe('Margaux');
    expect(result.format).toBe('cellarion');
  });

  it('parses a Cellarion export object with bottles array', () => {
    const json = JSON.stringify({
      cellarName: 'My Cellar',
      exportedAt: '2025-01-01',
      bottles: [
        { wineName: 'Opus One', producer: 'Opus One Winery', vintage: '2018' },
      ],
    });
    const result = parseJSON(json);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].wineName).toBe('Opus One');
    expect(result.format).toBe('cellarion');
  });

  it('expands quantity > 1 into individual items', () => {
    const json = JSON.stringify([
      { wineName: 'Margaux', producer: 'Chateau Margaux', quantity: 3 },
    ]);
    const result = parseJSON(json);
    expect(result.items).toHaveLength(3);
    result.items.forEach(item => {
      expect(item.wineName).toBe('Margaux');
      expect(item).not.toHaveProperty('quantity');
    });
  });

  it('defaults quantity to 1 when not specified', () => {
    const json = JSON.stringify([
      { wineName: 'Margaux', producer: 'Chateau Margaux' },
    ]);
    const result = parseJSON(json);
    expect(result.items).toHaveLength(1);
  });

  it('skips items with no wineName and no producer', () => {
    const json = JSON.stringify([
      { vintage: '2015' },
      { wineName: 'Margaux', producer: 'CM' },
    ]);
    const result = parseJSON(json);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].wineName).toBe('Margaux');
  });

  it('throws on invalid JSON', () => {
    expect(() => parseJSON('not valid json')).toThrow('Invalid JSON file');
  });

  it('throws on non-array/non-export object', () => {
    expect(() => parseJSON('"just a string"')).toThrow(
      'JSON must be an array or a Cellarion export object with a "bottles" array'
    );
  });

  it('throws on object without bottles array', () => {
    expect(() => parseJSON('{"name":"test"}')).toThrow(
      'JSON must be an array or a Cellarion export object with a "bottles" array'
    );
  });

  it('returns headers from first item', () => {
    const json = JSON.stringify([
      { wineName: 'Margaux', producer: 'CM', vintage: '2015' },
    ]);
    const result = parseJSON(json);
    expect(result.headers).toEqual(expect.arrayContaining(['wineName', 'producer', 'vintage']));
  });

  it('returns empty headers when no items', () => {
    const json = JSON.stringify([]);
    const result = parseJSON(json);
    expect(result.headers).toEqual([]);
    expect(result.items).toEqual([]);
  });

  it('strips BOM from JSON text', () => {
    const json = '\uFEFF' + JSON.stringify([{ wineName: 'Test', producer: 'P' }]);
    const result = parseJSON(json);
    expect(result.items).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// parseAndMap
// ---------------------------------------------------------------------------
describe('parseAndMap', () => {
  it('maps Vivino CSV correctly', () => {
    const csv = 'Wine name,Winery,Vintage,Country,Wine type,Rating\nMargaux,Chateau Margaux,2015,France,Red,4.5';
    const result = parseAndMap(csv);
    expect(result.format).toBe('vivino');
    expect(result.items).toHaveLength(1);
    expect(result.items[0].wineName).toBe('Margaux');
    expect(result.items[0].producer).toBe('Chateau Margaux');
    expect(result.items[0].vintage).toBe('2015');
    expect(result.items[0].country).toBe('France');
    expect(result.items[0].type).toBe('red');
    expect(result.items[0].rating).toBe(4.5);
  });

  it('maps CellarTracker CSV correctly', () => {
    const csv = 'iWine,Wine,Vintage,Country,Quantity\n12345,Opus One,2018,USA,1';
    const result = parseAndMap(csv);
    expect(result.format).toBe('cellartracker');
    expect(result.items).toHaveLength(1);
    expect(result.items[0].wineName).toBe('Opus One');
    expect(result.items[0].vintage).toBe('2018');
  });

  it('maps generic CSV correctly', () => {
    const csv = 'Wine,Producer,Vintage,Country\nSassicaia,Tenuta San Guido,2017,Italy';
    const result = parseAndMap(csv);
    expect(result.format).toBe('generic');
    expect(result.items).toHaveLength(1);
    expect(result.items[0].wineName).toBe('Sassicaia');
    expect(result.items[0].producer).toBe('Tenuta San Guido');
    expect(result.items[0].country).toBe('Italy');
  });

  it('maps Cellarion CSV correctly', () => {
    const csv = 'wineName,producer,vintage,country\nMargaux,Chateau Margaux,2015,France';
    const result = parseAndMap(csv);
    expect(result.format).toBe('cellarion');
    expect(result.items).toHaveLength(1);
    expect(result.items[0].wineName).toBe('Margaux');
    expect(result.items[0].producer).toBe('Chateau Margaux');
  });

  it('expands quantity in Cellarion-format CSV (hand-written files)', () => {
    const csv = 'wineName,producer,vintage,quantity\nMargaux,Chateau Margaux,2015,3\nOpus One,Opus One Winery,2018,1';
    const result = parseAndMap(csv);
    expect(result.format).toBe('cellarion');
    expect(result.items).toHaveLength(4);
    expect(result.items.filter(i => i.wineName === 'Margaux')).toHaveLength(3);
    expect(result.items[0].quantity).toBeUndefined();
  });

  it('accepts capitalized Quantity header in Cellarion-format CSV', () => {
    const csv = 'wineName,producer,vintage,Quantity\nMargaux,Chateau Margaux,2015,2';
    const result = parseAndMap(csv);
    expect(result.items).toHaveLength(2);
  });

  it('returns empty items for empty CSV (header only)', () => {
    const csv = 'Wine name,Winery,Vintage';
    const result = parseAndMap(csv);
    expect(result.items).toEqual([]);
    expect(result.format).toBe('unknown');
  });

  it('expands quantity into multiple items', () => {
    const csv = 'Wine name,Winery,Vintage,Quantity\nMargaux,Chateau Margaux,2015,3';
    const result = parseAndMap(csv);
    expect(result.items).toHaveLength(3);
    result.items.forEach(item => {
      expect(item.wineName).toBe('Margaux');
      expect(item).not.toHaveProperty('quantity');
    });
  });

  it('forceFormat overrides auto-detection', () => {
    // Headers look like CellarTracker (iWine present), but we force vivino mapper
    const csv = 'iWine,Wine name,Winery,Vintage\n123,Margaux,Chateau Margaux,2015';
    const result = parseAndMap(csv, 'vivino');
    expect(result.format).toBe('vivino');
    expect(result.items).toHaveLength(1);
    expect(result.items[0].wineName).toBe('Margaux');
    expect(result.items[0].producer).toBe('Chateau Margaux');
  });

  it('skips rows with no wine name and no producer', () => {
    const csv = 'Wine,Producer,Vintage\n,,2015\nMargaux,CM,2016';
    const result = parseAndMap(csv);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].wineName).toBe('Margaux');
  });

  it('handles BOM-prefixed CSV', () => {
    const csv = '\uFEFFWine name,Winery,Vintage\nMargaux,Chateau Margaux,2015';
    const result = parseAndMap(csv);
    expect(result.items).toHaveLength(1);
  });

  it('returns headers array from parsed rows', () => {
    const csv = 'Wine name,Winery,Vintage\nMargaux,Chateau Margaux,2015';
    const result = parseAndMap(csv);
    expect(result.headers).toEqual(expect.arrayContaining(['Wine name', 'Winery', 'Vintage']));
  });

  it('detects and uses semicolon delimiter automatically', () => {
    const csv = 'Wine name;Winery;Vintage\nMargaux;Chateau Margaux;2015';
    const result = parseAndMap(csv);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].wineName).toBe('Margaux');
  });

  it('sets default vintage to NV when missing', () => {
    const csv = 'Wine name,Winery,Vintage\nMargaux,Chateau Margaux,';
    const result = parseAndMap(csv);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].vintage).toBe('NV');
  });

  it('sets default bottle size to 750ml when missing', () => {
    const csv = 'Wine name,Winery,Vintage\nMargaux,Chateau Margaux,2015';
    const result = parseAndMap(csv);
    expect(result.items[0].bottleSize).toBe('750ml');
  });

  it('normalises purchaseDate, consumedAt and dateAdded to ISO dates', () => {
    const csv = 'wineName,producer,vintage,purchaseDate,consumedAt,dateAdded\n' +
      'Margaux,Chateau Margaux,2015,10/30/2024,11/26/2024,2024-01-05';
    const result = parseAndMap(csv);
    expect(result.items[0].purchaseDate).toBe('2024-10-30');
    expect(result.items[0].consumedAt).toBe('2024-11-26');
    expect(result.items[0].dateAdded).toBe('2024-01-05');
  });

  it('keeps the calendar date of full ISO timestamps (no timezone day-shift)', () => {
    const json = JSON.stringify([
      { wineName: 'Margaux', producer: 'CM', consumedAt: '2024-11-26T23:30:00.000Z' },
    ]);
    const result = parseJSON(json);
    expect(result.items[0].consumedAt).toBe('2024-11-26');
  });

  it('maps wine type from Vivino type field', () => {
    const csv = 'Wine name,Winery,Wine type\nBubbly,Domaine,Sparkling';
    const result = parseAndMap(csv);
    expect(result.items[0].type).toBe('sparkling');
  });

  describe('parseCombinedRackLocation', () => {
    it('parses "M2-11" into { rackName: "M2", rackPosition: 11 }', () => {
      expect(parseCombinedRackLocation('M2-11')).toEqual({ rackName: 'M2', rackPosition: 11 });
    });

    it('handles leading-zero positions like "M3-04"', () => {
      expect(parseCombinedRackLocation('M3-04')).toEqual({ rackName: 'M3', rackPosition: 4 });
    });

    it('splits on the LAST hyphen so rack names with hyphens still work', () => {
      expect(parseCombinedRackLocation('Cabinet-A-15')).toEqual({ rackName: 'Cabinet-A', rackPosition: 15 });
    });

    it('returns null for missing or empty input', () => {
      expect(parseCombinedRackLocation('')).toBeNull();
      expect(parseCombinedRackLocation(null)).toBeNull();
      expect(parseCombinedRackLocation(undefined)).toBeNull();
    });

    it('returns null when right side is not a positive integer', () => {
      expect(parseCombinedRackLocation('M2-AB')).toBeNull();
      expect(parseCombinedRackLocation('M2-0')).toBeNull();
      expect(parseCombinedRackLocation('M2-')).toBeNull();
    });

    it('returns null when there is no hyphen', () => {
      expect(parseCombinedRackLocation('M2')).toBeNull();
    });
  });

  describe('rack columns (row/col/rackRows/rackCols/rackType)', () => {
    it('maps Row, Col, Rack Rows, Rack Cols, Rack Type for generic CSV', () => {
      const csv = 'Wine,Producer,Vintage,Rack,Row,Col,Rack Rows,Rack Cols,Rack Type\n' +
        'Margaux,Chateau Margaux,2015,Main Cabinet,3,2,18,6,grid';
      const result = parseAndMap(csv);
      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toMatchObject({
        rackName: 'Main Cabinet',
        row: 3,
        col: 2,
        rackRows: 18,
        rackCols: 6,
        rackType: 'grid',
      });
    });

    it('maps Bin Row / Bin Col aliases', () => {
      const csv = 'Wine,Producer,Vintage,Rack,Bin Row,Bin Col\n' +
        'Margaux,Chateau Margaux,2015,Cabinet A,5,3';
      const result = parseAndMap(csv);
      expect(result.items[0]).toMatchObject({ row: 5, col: 3 });
    });

    it('preserves rackPosition when row/col absent', () => {
      const csv = 'Wine,Producer,Vintage,Rack,Position\n' +
        'Margaux,Chateau Margaux,2015,Cabinet A,42';
      const result = parseAndMap(csv);
      expect(result.items[0]).toMatchObject({ rackName: 'Cabinet A', rackPosition: 42 });
      expect(result.items[0].row).toBeUndefined();
    });

    it('parses Rack_Location "M2-11" into rackName + rackPosition (generic format)', () => {
      // Rack_Location is parsed by the generic mapper as a fallback; the
      // dedicated "Oeno" format detection is reserved for real Oeno
      // two-section exports, not for spreadsheets with Rack_Location columns.
      const csv = 'Producer,Wine,Vintage,Quantity,Rack_Location,type,Size,Price,Country\n' +
        'Producer A,Test White Wine,2019,3,M3-11,White Wine,750,35,New Zealand\n' +
        'Producer B,Test Red Wine,2018,1,M2-11,Red Wine,750,35,New Zealand';
      const result = parseAndMap(csv);
      expect(result.format).toBe('generic');
      // Quantity 3 + 1 = 4 bottles
      expect(result.items).toHaveLength(4);
      const m3 = result.items[0];
      expect(m3.rackName).toBe('M3');
      expect(m3.rackPosition).toBe(11);
      expect(m3.type).toBe('white');
      expect(m3.bottleSize).toBe('750ml');
      const m2 = result.items[3];
      expect(m2.rackName).toBe('M2');
      expect(m2.rackPosition).toBe(11);
      expect(m2.type).toBe('red');
    });

    it('expands quantity while preserving row/col on each generated bottle', () => {
      const csv = 'Wine,Producer,Vintage,Quantity,Rack,Row,Col,Rack Rows,Rack Cols\n' +
        'Margaux,Chateau Margaux,2015,3,Cabinet,1,1,18,6';
      const result = parseAndMap(csv);
      expect(result.items).toHaveLength(3);
      result.items.forEach(item => {
        expect(item.row).toBe(1);
        expect(item.col).toBe(1);
        expect(item.rackRows).toBe(18);
        expect(item.rackCols).toBe(6);
        expect(item.rackName).toBe('Cabinet');
      });
    });
  });
});

// ---------------------------------------------------------------------------
// Oeno-by-Vintec real two-section export
// ---------------------------------------------------------------------------
describe('parseOenoExport', () => {
  // Minimal fixture mirroring the real Oeno-by-Vintec export shape: one
  // multi-column cabinet, one single-column cabinet, plus four bottles
  // covering placed / unshelved and active / consumed paths.
  const fixture = [
    'Cabinet ID,Cabinet Label,Cabinet Brand,Cabinet Model,Column Index,Shelf Index,Layer Index,Layer ID,Disabled Slots,Total Slots,Empty Slots,Cabinet Added Date,Cabinet Purchased Date,Unshelved Bottle Count',
    '10001,Main Cellar,TRANSTHERM,Espace Cellar,3,18,1,1001,"6, 5",702,30,2024-07-05,,0',
    '10001,Main Cellar,TRANSTHERM,Espace Cellar,3,18,2,1002,0,702,30,2024-07-05,,0',
    '10001,Main Cellar,TRANSTHERM,Espace Cellar,3,1,1,1003,0,702,30,2024-07-05,,0',
    '10001,Main Cellar,TRANSTHERM,Espace Cellar,4,13,1,1004,0,702,30,2024-07-05,,0',
    '10002,Wine Fridge,Eurocave,,1,5,1,2001,0,92,23,2024-08-13,,0',
    '',
    '',
    'User Bottles Details',
    '',
    'Bottle ID,Cabinet ID,Column ID,Shelf ID,Layer ID,Slot,Bottle Size Liters,Wine Year,Wine Type,Bottle Note,Wine Title,Wine Country,Wine Region,Wine Winery,Purchase Cost,Purchase Currency,Purchase Date,Opened On,Consumed On',
    '5001,10001,500,5500,1001,5,0.75,2018,Red Wine,,Test Wine A,NZ,Test Region,Producer A,30.50,NZD,2024-10-30,,',
    '5002,10002,501,5501,2001,1,0.75,2020,Red Wine,,Test Wine B,NZ,Test Region,Producer B,null,NZD,2024-11-02,,',
    '5003,null,null,null,null,null,0.75,2014,Red Wine,,Test Wine C,NZ,Test Region,Producer C,null,NZD,2024-10-30,,2024-11-26',
    '5004,10001,500,5502,1004,3,0.75,2019,White Wine,Aged on lees,Test Wine D,NZ,Test Region,Producer D,42,NZD,2024-10-30,,'
  ].join('\n');

  it('detects the two-section boundary at the "Bottle ID" header row', () => {
    const lines = fixture.split('\n');
    const idx = detectOenoExportBoundary(lines);
    expect(lines[idx].startsWith('Bottle ID')).toBe(true);
  });

  it('returns format=oeno-export with one item per bottle (no quantity expansion)', () => {
    const result = parseOenoExport(fixture);
    expect(result.format).toBe('oeno-export');
    expect(result.items).toHaveLength(4);
  });

  it('builds per-cabinet/column rack specs with shelf + 6 front + 5 back', () => {
    const result = parseOenoExport(fixture);
    expect(result.oenoRackSpecs).toMatchObject({
      'Main Cellar – Module 3': {
        type: 'shelf',
        cols: 6,
        typeConfig: { bottlesPerCell: 1, backCols: 5 }
      },
      'Main Cellar – Module 4': {
        type: 'shelf',
        cols: 6,
        typeConfig: { bottlesPerCell: 1, backCols: 5 }
      },
      // Single-column cabinet keeps just the label (no module suffix)
      'Wine Fridge': {
        type: 'shelf',
        cols: 6,
        typeConfig: { bottlesPerCell: 1, backCols: 5 }
      }
    });
    // Module 3 has shelves 1 and 18 referenced → rows = max observed (18)
    expect(result.oenoRackSpecs['Main Cellar – Module 3'].rows).toBe(18);
    expect(result.oenoRackSpecs['Main Cellar – Module 4'].rows).toBe(13);
  });

  it('maps shelved bottles to rackName + shelfNumber + layer + slotInLayer', () => {
    const result = parseOenoExport(fixture);
    const wineA = result.items.find(i => i.wineName === 'Test Wine A');
    expect(wineA).toMatchObject({
      rackName: 'Main Cellar – Module 3',
      vintage: '2018',
      type: 'red',
      country: 'NZ',
      region: 'Test Region',
      producer: 'Producer A',
      bottleSize: '750ml',
      price: 30.5,
      currency: 'NZD',
      layer: 1,
      slotInLayer: 5,
    });
    expect(wineA.rackPosition).toBe(18); // shelf 18
  });

  it('imports unshelved bottles without rack placement', () => {
    const result = parseOenoExport(fixture);
    const unshelved = result.items.find(i => i.wineName === 'Test Wine C');
    expect(unshelved).toBeDefined();
    expect(unshelved.rackName).toBeUndefined();
    expect(unshelved.rackPosition).toBeUndefined();
  });

  it('routes Consumed-On bottles through the addToHistory path', () => {
    const result = parseOenoExport(fixture);
    const consumed = result.items.find(i => i.wineName === 'Test Wine C');
    expect(consumed.addToHistory).toBe(true);
    expect(consumed.consumedReason).toBe('drank');
    expect(consumed.consumedAt).toBe('2024-11-26');
  });

  it('reads per-row currency directly from the CSV', () => {
    const result = parseOenoExport(fixture);
    result.items.forEach(item => expect(item.currency).toBe('NZD'));
  });

  it('parseAndMap routes Oeno-export text through parseOenoExport automatically', () => {
    const result = parseAndMap(fixture);
    expect(result.format).toBe('oeno-export');
    expect(result.items.length).toBe(4);
    expect(result.oenoRackSpecs).toBeDefined();
  });
});
