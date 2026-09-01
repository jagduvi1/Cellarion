const { pradikatOnlyValue } = require('./styleTerms');

/**
 * Telling a ripeness Prädikat from a place, when it turns up in an appellation
 * column (somm ticket 6a966386, 2026-09-01).
 *
 * The two real rows: a Mosel Riesling whose file said appellation "Auslese",
 * and a Nahe one that said "Trokenbeerenauslese" — the owner's misspelling,
 * carried verbatim, in a file that also wrote the wine's own name as "Riesling
 * Troken". Stored as written those wines have no appellation at all, which is
 * what makes auto-enrichment decline them permanently.
 *
 * The rejections carry the weight here. Moving a value that might name a place
 * would trade one wrong field for another, and unlike the write it replaces,
 * nothing downstream would flag it.
 */

describe('values that ARE the Prädikat', () => {
  test.each([
    ['Auslese', 'the Molitor row'],
    ['Trokenbeerenauslese', "the Dönnhoff row — the owner's misspelling"],
    ['Trockenbeerenauslese', 'spelled correctly'],
    ['Spätlese', 'umlaut'],
    ['Spaetlese', 'ue-transliteration of the same tier'],
    ['Kabinett', ''],
    ['Beerenauslese', 'nests inside Trockenbeerenauslese but is its own token'],
    ['Eiswein', ''],
    ['Ausbruch', 'Austrian ladder — the ticket asked about Austria'],
    ['Strohwein', 'Austrian'],
  ])('%s is routed out of the appellation (%s)', (value) => {
    expect(pradikatOnlyValue(value)).toBe(value);
  });

  test('returns the value AS WRITTEN, not a canonical form — it becomes the classification a person reads', () => {
    expect(pradikatOnlyValue('  Auslese  ')).toBe('Auslese');
    expect(pradikatOnlyValue('AUSLESE')).toBe('AUSLESE');
  });
});

describe('values that are, or might be, a place — left alone', () => {
  test.each([
    ['Nahe', 'the appellation the Dönnhoff record should have had'],
    ['Mosel', ''],
    ['Bernkasteler Badstube', 'a single vineyard, not a ripeness level'],
    ['Rheingau', ''],
    ['Wachau', 'Austrian region, near-neighbour of the Austrian tiers'],
  ])('%s is kept (%s)', (value) => {
    expect(pradikatOnlyValue(value)).toBeNull();
  });

  test('a value containing a Prädikat AND something else is refused', () => {
    // "Goldkapsel" is a bottling designation this vocabulary cannot vouch for,
    // and "Mosel Auslese" genuinely contains the place. Refusing the mixed case
    // is the whole point: certain or nothing.
    expect(pradikatOnlyValue('Auslese Goldkapsel')).toBeNull();
    expect(pradikatOnlyValue('Mosel Auslese')).toBeNull();
    expect(pradikatOnlyValue('Auslese Bernkasteler Badstube')).toBeNull();
  });

  test('a sweetness term is NOT a Prädikat — different axis of the same label', () => {
    // Trocken is how the wine finished, not how ripe it was picked. It has no
    // business in the appellation either, but this guard does not claim it.
    expect(pradikatOnlyValue('Trocken')).toBeNull();
    expect(pradikatOnlyValue('Halbtrocken')).toBeNull();
    expect(pradikatOnlyValue('Feinherb')).toBeNull();
  });
});

describe('degenerate input', () => {
  test.each([[''], ['   '], [null], [undefined], ['---'], [42]])('%p yields null', (value) => {
    expect(pradikatOnlyValue(value)).toBeNull();
  });
});

const { pradikatContradictsName } = require('./styleTerms');

/**
 * A Prädikat can be misfiled AND untrue. The second ticket record was both:
 * appellation "Trokenbeerenauslese" on a wine named "Riesling Trocken". Moving
 * it to the classification would have kept the falsehood and changed only which
 * field carried it — and a classification is read as curated fact, so it would
 * have argued for a decades-long dessert window on a dry estate Riesling.
 */
describe('a Prädikat the wine itself contradicts', () => {
  test.each([
    ['Trokenbeerenauslese', 'Riesling Trocken', "the ticket's own record"],
    ['Trokenbeerenauslese', 'Riesling Troken', "and with the file's spelling of the name too"],
    ['Trockenbeerenauslese', 'Riesling Halbtrocken', 'off-dry is no closer to botrytis sugar'],
    ['Beerenauslese', 'Riesling Feinherb', ''],
    ['Eiswein', 'Riesling Sec', 'a French-labelled dry wine'],
    ['Ausbruch', 'Grüner Veltliner Trocken', 'Austrian ladder, same rule'],
  ])('%s on "%s" is refused (%s)', (pradikat, name) => {
    expect(pradikatContradictsName(pradikat, name)).toMatch(/sweet by definition/);
  });

  test('the reason names both halves, because a curator reads it', () => {
    expect(pradikatContradictsName('Trokenbeerenauslese', 'Riesling Trocken'))
      .toBe('trockenbeerenauslese is sweet by definition, but the name states trocken');
  });
});

describe('Prädikate that CAN be dry are never refused', () => {
  // Kabinett, Spätlese and Auslese are routinely bottled trocken — "Spätlese
  // Trocken" is one of the most common label pairs in Germany. Refusing those
  // would throw away the value on exactly the wines the rescue exists for.
  test.each([
    ['Kabinett', 'Riesling Kabinett Trocken'],
    ['Spätlese', 'Riesling Spätlese Trocken'],
    ['Auslese', 'Riesling Auslese Trocken'],
    ['Auslese', 'Riesling Auslese Bernkasteler Badstube'],
    ['Trockenbeerenauslese', 'Riesling'],
    ['Eiswein', 'Riesling Eiswein'],
  ])('%s on "%s" is compatible', (pradikat, name) => {
    expect(pradikatContradictsName(pradikat, name)).toBeNull();
  });

  test('a missing or nameless wine is not a contradiction — silence is not disagreement', () => {
    expect(pradikatContradictsName('Trockenbeerenauslese', '')).toBeNull();
    expect(pradikatContradictsName('Trockenbeerenauslese', null)).toBeNull();
    expect(pradikatContradictsName('Trockenbeerenauslese', undefined)).toBeNull();
  });

  test('"Trocken" inside Trockenbeerenauslese does not make the tier contradict ITSELF', () => {
    // The tier's own name starts with the dry word. Whole-token matching keeps
    // 'trockenbeerenauslese' one token, so it never reads as stating 'trocken'.
    expect(pradikatContradictsName('Trockenbeerenauslese', 'Riesling Trockenbeerenauslese')).toBeNull();
  });
});
