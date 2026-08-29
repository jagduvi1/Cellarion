const { statedStyle, conflictingStyleTerms, SWEETNESS_WORDS } = require('./styleTerms');

// The vineyard the reporter's bottles come from (issue #1134). Kept as one
// constant so a test reads as the tail of the name, which is the only part
// that differs and the whole reason the scorer could not separate them.
const V = 'Brauneberger Juffer-Sonnenuhr Riesling ';

describe('statedStyle', () => {
  it('reads the Prädikat off a name', () => {
    expect([...statedStyle(V + 'Spätlese Feinherb').pradikat]).toEqual(['spatlese']);
    expect([...statedStyle(V + 'Auslese').pradikat]).toEqual(['auslese']);
    expect([...statedStyle(V + 'Kabinett').pradikat]).toEqual(['kabinett']);
  });

  it('reads sweetness separately from the Prädikat', () => {
    const s = statedStyle(V + 'Spätlese Trocken');
    expect([...s.pradikat]).toEqual(['spatlese']);
    expect([...s.sweetness]).toEqual(['trocken']);
  });

  it('folds the "ae" transliteration onto the umlaut spelling', () => {
    expect([...statedStyle('Riesling Spaetlese').pradikat])
      .toEqual([...statedStyle('Riesling Spätlese').pradikat]);
  });

  it('reads the capital eszett off an all-caps label', () => {
    // ẞ (U+1E9E) is the official uppercase ß and only folds to ß under
    // toLowerCase — the v1.181.0 order folded first and read "SÜẞ" as
    // stating nothing, so the guard failed open for all-caps labels.
    expect([...statedStyle('RIESLING SPÄTLESE SÜẞ').sweetness]).toEqual(['suss']);
    expect(conflictingStyleTerms('RIESLING SPÄTLESE SÜẞ', 'Riesling Spätlese Trocken'))
      .toMatch(/different sweetness/);
  });

  it('folds the "ue" transliteration of Süß', () => {
    expect([...statedStyle('Riesling Spätlese Suess').sweetness]).toEqual(['suss']);
    expect(conflictingStyleTerms('Riesling Spätlese Suess', 'Riesling Spätlese Trocken'))
      .toMatch(/different sweetness/);
    // …and the two spellings of the same wine are NOT a conflict.
    expect(conflictingStyleTerms('Riesling Spätlese Suess', 'Riesling Spätlese Süß')).toBeNull();
  });

  it('keeps the nested tier names apart', () => {
    // 'trockenbeerenauslese' contains 'beerenauslese' contains 'auslese' as
    // substrings — whole-token matching must see three different tiers, and
    // must not read a bare 'trocken' out of the longest one.
    expect([...statedStyle('Riesling Trockenbeerenauslese').pradikat]).toEqual(['trockenbeerenauslese']);
    expect([...statedStyle('Riesling Trockenbeerenauslese').sweetness]).toEqual([]);
    expect([...statedStyle('Riesling Beerenauslese').pradikat]).toEqual(['beerenauslese']);
  });

  it('ignores style words that are ordinary name words', () => {
    // "Dry Creek" is a place and "Sweet Cheeks" a winery — neither states a
    // sweetness, though both words are real sweetness vocabulary elsewhere.
    expect([...statedStyle('Dry Creek Zinfandel').sweetness]).toEqual([]);
    expect([...statedStyle('Sweet Cheeks Pinot Noir').sweetness]).toEqual([]);
    expect(SWEETNESS_WORDS.has('dry')).toBe(true);
  });

  it('reads a hyphenated and a spaced spelling as one term', () => {
    expect([...statedStyle('Cuvée Demi-Sec').sweetness]).toEqual(['demisec']);
    expect([...statedStyle('Cuvée Demi Sec').sweetness]).toEqual(['demisec']);
  });

  it('survives a missing name', () => {
    expect(statedStyle(undefined)).toEqual({ pradikat: new Set(), sweetness: new Set() });
    expect(statedStyle('')).toEqual({ pradikat: new Set(), sweetness: new Set() });
  });
});

describe('conflictingStyleTerms', () => {
  it('rejects a different Prädikat', () => {
    expect(conflictingStyleTerms(V + 'Auslese', V + 'Spätlese Feinherb'))
      .toMatch(/different Prädikat/);
    expect(conflictingStyleTerms(V + 'Kabinett', V + 'Spätlese Feinherb'))
      .toMatch(/different Prädikat/);
    expect(conflictingStyleTerms('Riesling Beerenauslese', 'Riesling Trockenbeerenauslese'))
      .toMatch(/different Prädikat/);
  });

  it('rejects a different sweetness at the same Prädikat', () => {
    expect(conflictingStyleTerms(V + 'Spätlese Trocken', V + 'Spätlese Feinherb'))
      .toMatch(/different sweetness/);
  });

  it('treats silence on one side as agreement, not disagreement', () => {
    // The reporter's Alte Reben bottle: both are Spätlesen, only one states a
    // sweetness. Not a conflict — this pair is separated by the resolver's
    // soft zone asking the user, not by this guard.
    expect(conflictingStyleTerms(V + 'Spätlese Alte Reben', V + 'Spätlese Feinherb')).toBeNull();
    expect(conflictingStyleTerms('Riesling Spätlese', 'Riesling Spätlese Trocken')).toBeNull();
  });

  it('treats a subset as agreement', () => {
    expect(conflictingStyleTerms('Cuvée Brut', 'Cuvée Brut Rosé')).toBeNull();
  });

  it('is symmetric', () => {
    const a = V + 'Spätlese Trocken';
    const b = V + 'Spätlese Feinherb';
    expect(Boolean(conflictingStyleTerms(a, b))).toBe(Boolean(conflictingStyleTerms(b, a)));
  });

  it('says nothing about names that state no style', () => {
    expect(conflictingStyleTerms('Bin 389', 'Bin 389 Cabernet Shiraz')).toBeNull();
    expect(conflictingStyleTerms('Kangarilla', 'Old Vines Grenache Kangarilla')).toBeNull();
  });
});
