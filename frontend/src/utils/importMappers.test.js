import {
  parseCSV,
  detectFormat,
  detectDelimiter,
  parseJSON,
  parseAndMap,
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

  it('maps wine type from Vivino type field', () => {
    const csv = 'Wine name,Winery,Wine type\nBubbly,Domaine,Sparkling';
    const result = parseAndMap(csv);
    expect(result.items[0].type).toBe('sparkling');
  });
});
