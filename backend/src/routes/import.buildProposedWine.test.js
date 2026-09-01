/**
 * File geography beats AI geography, and the confidence floor never touches
 * the file.
 *
 * The bug this pins (found 2026-08-21): the parsers had been reading
 * CellarTracker's Appellation column all along, /validate matched on it — and
 * then every path that MINTED a wine used the AI's value instead, dropping it
 * entirely below AI_GEOGRAPHY_MIN_CONFIDENCE. One 231-wine import produced 86
 * null/null registry rows, and over half of a curation day went on putting
 * back appellations the user's own file had stated.
 */
// Requiring the route pulls its whole dependency tree; meilisearch ships ESM
// that jest does not transform, so the module boundary is stubbed exactly as
// the other import suites do. Nothing below touches any of it — this is a pure
// function test.
jest.mock('../services/search', () => ({
  indexWine: jest.fn(), bulkIndexBottles: jest.fn(), getIsAvailable: jest.fn(() => false),
}));
jest.mock('../services/labelScan', () => ({ identifyWineFromText: jest.fn() }));
jest.mock('../services/findOrCreateWine', () => ({ findOrCreateWine: jest.fn(), findOrCreateRegion: jest.fn() }));
jest.mock('../middleware/aiBurstLimiter', () => (req, res, next) => next());
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));

const { buildProposedWine, summariseReasons, fileCompleteIdentity } = require('./import');

// Below AI_GEOGRAPHY_MIN_CONFIDENCE (0.6) the model is inferring, not knowing.
const SURE = 0.8;
const UNSURE = 0.4;

const ai = (over = {}) => ({
  name: 'Barolo', producer: 'Cà di Bruno', country: 'Italy',
  region: 'Piedmont', appellation: 'Barolo', classification: null,
  type: 'red', grapes: ['Nebbiolo'], confidence: SURE, ...over,
});

describe('the confidence floor applies to the AI, never to the file', () => {
  it('keeps the FILE appellation even when the AI is unsure', () => {
    // The whole bug in one case: pre-fix this returned null.
    const out = buildProposedWine(ai({ confidence: UNSURE }), { appellation: 'Barolo', region: 'Piedmont' });
    expect(out.appellation).toBe('Barolo');
    expect(out.region).toBe('Piedmont');
  });

  it('still drops AI geography below the floor when the file says nothing', () => {
    const out = buildProposedWine(ai({ confidence: UNSURE }), {});
    expect(out.appellation).toBeNull();
    expect(out.region).toBeNull();
    expect(out.classification).toBeNull();
  });

  it('keeps AI geography above the floor', () => {
    const out = buildProposedWine(ai({ confidence: SURE }), {});
    expect(out.appellation).toBe('Barolo');
    expect(out.region).toBe('Piedmont');
  });

  it('prefers the FILE over the AI even when the AI is confident', () => {
    // The owner read the label; the model is recalling. Disagreement is a
    // curator question, and the curator should see what the label said.
    const out = buildProposedWine(
      ai({ appellation: 'Barolo', confidence: 0.95 }),
      { appellation: 'Barbaresco' });
    expect(out.appellation).toBe('Barbaresco');
  });
});

describe('country keeps AI-first precedence, with the file as a fallback', () => {
  it('prefers the AI country — it normalizes what the raw column does not', () => {
    // "Deutschland" in a column, "Germany" from the model.
    const out = buildProposedWine(ai({ country: 'Germany' }), { country: 'Deutschland' });
    expect(out.country).toBe('Germany');
  });

  it('falls back to the file country when the AI could not place it', () => {
    // Pre-fix this row was REFUSED outright ("country could not be
    // determined") and cost the user the bottle.
    const out = buildProposedWine(ai({ country: null }), { country: 'Australia' });
    expect(out.country).toBe('Australia');
  });

  it('is null when neither knows, so the caller can still refuse the row', () => {
    expect(buildProposedWine(ai({ country: null }), {}).country).toBeNull();
  });
});

describe('summariseReasons — why rows failed, not just how many', () => {
  it('groups reasons with counts', () => {
    expect(summariseReasons([
      { index: 0, reason: 'Wine definition not found' },
      { index: 1, reason: 'Wine definition not found' },
      { index: 2, reason: 'Invalid consumed reason' },
    ])).toEqual({ 'Wine definition not found': 2, 'Invalid consumed reason': 1 });
  });

  it('carries no wine name, producer or note — only the failure mode', () => {
    // The audit needs the mode; the row's identity is the user's own data.
    const out = summariseReasons([{ index: 0, reason: 'Invalid wine definition ID', wineName: 'Areni' }]);
    expect(JSON.stringify(out)).not.toMatch(/Areni/);
  });

  it('never loses count when it truncates the tail', () => {
    // A cap that hides its own truncation is how you end up trusting a
    // partial picture — the spill is reported, not dropped.
    const many = Array.from({ length: 20 }, (_, i) => ({ index: i, reason: `distinct failure ${i}` }));
    const out = summariseReasons(many);
    const total = Object.values(out).reduce((s, n) => s + n, 0);
    expect(total).toBe(20);
    expect(Object.keys(out).some((k) => /more reason kind/.test(k))).toBe(true);
  });

  it('truncates a long caught err.message rather than storing it whole', () => {
    const out = summariseReasons([{ index: 0, reason: 'x'.repeat(500) }]);
    const key = Object.keys(out)[0];
    expect(key.length).toBeLessThan(200);
    expect(key.endsWith('…')).toBe(true);
  });

  it('records a missing reason as such instead of "undefined"', () => {
    expect(summariseReasons([{ index: 0 }, { index: 1, reason: '  ' }]))
      .toEqual({ '(no reason recorded)': 2 });
  });
});

describe('hygiene', () => {
  it('treats whitespace-only file values as absent, not as data', () => {
    const out = buildProposedWine(ai({ confidence: UNSURE }), { appellation: '   ', region: '' });
    expect(out.appellation).toBeNull();
    expect(out.region).toBeNull();
  });

  it('trims a file value rather than storing the padding', () => {
    expect(buildProposedWine(ai(), { appellation: '  Chianti Classico  ' }).appellation).toBe('Chianti Classico');
  });

  it('survives a missing item entirely (cached/duplicate rows)', () => {
    expect(() => buildProposedWine(ai(), undefined)).not.toThrow();
    expect(buildProposedWine(ai(), undefined).appellation).toBe('Barolo');
  });

  it('passes name, producer, type, grapes and confidence through untouched', () => {
    const out = buildProposedWine(ai(), { appellation: 'Barolo' });
    expect(out).toMatchObject({
      name: 'Barolo', producer: 'Cà di Bruno', type: 'red',
      grapes: ['Nebbiolo'], confidence: SURE,
    });
  });
});

describe('type: the file states, the model recalls (2026-08-22)', () => {
  it('prefers the file type over the AI type', () => {
    expect(buildProposedWine(ai({ type: 'red' }), { type: 'white' }).type).toBe('white');
  });

  it('falls back to the AI when the file says nothing', () => {
    // The parsers now emit null for an unknown colour rather than guessing
    // 'red', so a null here is an honest "the file did not say".
    expect(buildProposedWine(ai({ type: 'red' }), { type: null }).type).toBe('red');
    expect(buildProposedWine(ai({ type: 'red' }), {}).type).toBe('red');
  });

  it('IGNORES a file type the schema would reject, rather than failing the mint', () => {
    // A client can send anything; an invalid colour must fall through to the
    // AI, not poison the row or 400 the whole import.
    for (const bad of ['orange', 'RED', 'vin jaune', '', '  ', 42, {}]) {
      expect(buildProposedWine(ai({ type: 'red' }), { type: bad }).type).toBe('red');
    }
  });

  it('leaves type null when neither the file nor the model states one', () => {
    expect(buildProposedWine(ai({ type: null }), { type: null }).type).toBeNull();
  });
});

// ── Prädikat in the appellation column (somm ticket 6a966386, 2026-09-01) ────
//
// Both rows below are verbatim from the import archive that produced the
// ticket. The owner put the ripeness Prädikat in his appellation column, and
// the same file misspelled the wine's own name ("Riesling Troken") — which is
// how we know the typo is his and not ours. Taken literally, those wines end
// up with no appellation at all: the thin-identity condition that makes
// auto-enrichment decline them permanently.
describe('a Prädikat in the appellation column moves to classification', () => {
  const molitor = {
    wineName: 'Riesling Auslese Bernkasteler Badstube', producer: 'Markus Molitor',
    country: 'Allemagne', region: 'Moselle', appellation: 'Auslese',
  };

  test("the file's Prädikat becomes the classification, and the model supplies the place", () => {
    const out = buildProposedWine(ai({ appellation: 'Mosel', classification: null }), molitor);
    expect(out.classification).toBe('Auslese');
    expect(out.appellation).toBe('Mosel');
  });

  test('a Prädikat the wine CONTRADICTS is dropped, not moved to another field', () => {
    // The second ticket record. Its file said "Trokenbeerenauslese" on a wine
    // the model minted as "Riesling Trocken" — the sweetest botrytis category
    // German law defines, on a bone-dry wine. Rescuing it would keep the
    // falsehood and change only which field carried it, and a classification
    // reads as curated fact: it would have argued for a decades-long dessert
    // window on an estate dry Riesling. An honest gap is what asks to be filled.
    //
    // This is independently the judgement the sommelier reached on these two
    // records (proposals 6a965b19 / 6a965b0e, 2026-09-01): Auslese kept as a
    // classification, Trockenbeerenauslese dropped, appellation Nahe.
    const donnhoff = { wineName: 'Riesling Troken', producer: 'Dönnhoff', country: 'Allemagne', appellation: 'Trokenbeerenauslese' };
    const out = buildProposedWine(ai({ name: 'Riesling Trocken', appellation: 'Nahe', classification: null }), donnhoff);
    expect(out.appellation).toBe('Nahe');
    expect(out.classification).toBeFalsy();
  });

  test('the contradiction drops the value — it does not leave it in the appellation', () => {
    // Belt and braces on the above: a ripeness level is not a place whether or
    // not it is true of this wine, so it leaves the field either way.
    const donnhoff = { wineName: 'Riesling Troken', producer: 'Dönnhoff', country: 'Allemagne', appellation: 'Trokenbeerenauslese' };
    const out = buildProposedWine(ai({ name: 'Riesling Trocken', appellation: null, classification: null }), donnhoff);
    expect(out.appellation).toBeFalsy();
    expect(out.classification).toBeFalsy();
  });

  test('a dry Spätlese still keeps its Prädikat — that tier can legally be dry', () => {
    // The rescue must not over-fire. "Spätlese Trocken" is one of the most
    // common label pairs in Germany; refusing it would throw the value away on
    // exactly the wines this exists for.
    const row = { wineName: 'Riesling Spätlese Trocken', producer: 'Dönnhoff', appellation: 'Spätlese' };
    const out = buildProposedWine(ai({ name: 'Riesling Spätlese Trocken', appellation: 'Nahe', classification: null }), row);
    expect(out.classification).toBe('Spätlese');
    expect(out.appellation).toBe('Nahe');
  });

  test('a real appellation is untouched — the file still outranks the model', () => {
    const row = { ...molitor, appellation: 'Bernkasteler Badstube' };
    const out = buildProposedWine(ai({ appellation: 'Mosel' }), row);
    expect(out.appellation).toBe('Bernkasteler Badstube');
  });

  test("a classification the file states of its own wins — the rescue never overwrites it", () => {
    const row = { ...molitor, classification: 'Prädikatswein' };
    const out = buildProposedWine(ai({ appellation: 'Mosel', classification: 'VDP' }), row);
    expect(out.classification).toBe('Prädikatswein');
    expect(out.appellation).toBe('Mosel');
  });

  test('with no model appellation either, the field is empty rather than wrong', () => {
    // Honest emptiness beats a ripeness level masquerading as a place: the
    // curator sees a gap, which is the state that asks to be filled.
    const out = buildProposedWine(ai({ appellation: null, classification: null }), molitor);
    expect(out.appellation).toBeFalsy();
    expect(out.classification).toBe('Auslese');
  });
});

/**
 * The complete-row AI bypass is the OTHER way a wine enters the registry, and
 * it had the same defect. It writes the file's columns with no model involved,
 * so a German row that happens to carry a type column would have stored the
 * Prädikat as the appellation with nothing to catch it.
 *
 * The two ticket rows did not take this path (neither file row had a type), but
 * the next German import with a type column would have.
 */
describe('the complete-row bypass routes the Prädikat the same way', () => {
  const colourOf = (g) => (/riesling/i.test(g) ? 'White' : null);
  const row = (over = {}) => ({
    wineName: 'Riesling Auslese Bernkasteler Badstube', producer: 'Markus Molitor',
    country: 'Germany', region: 'Mosel', appellation: 'Auslese', type: 'white', ...over,
  });

  test('the Prädikat becomes the classification and the appellation is left empty', () => {
    // Empty rather than wrong. There is no model on this path to supply the
    // place, and enrichment's place axis is satisfied by the region — whereas
    // a ripeness level in the appellation would key the wine differently from
    // the same bottle arriving with a proper appellation, and mint a twin.
    const out = fileCompleteIdentity(row(), colourOf);
    expect(out.appellation).toBeNull();
    expect(out.classification).toBe('Auslese');
  });

  test('a contradicted Prädikat is dropped here too — the paths agree', () => {
    const out = fileCompleteIdentity(
      row({ wineName: 'Riesling Trocken', appellation: 'Trokenbeerenauslese' }), colourOf,
    );
    expect(out.appellation).toBeNull();
    expect(out.classification).toBeNull();
  });

  test('a real appellation is untouched', () => {
    const out = fileCompleteIdentity(row({ appellation: 'Bernkasteler Badstube' }), colourOf);
    expect(out.appellation).toBe('Bernkasteler Badstube');
    expect(out.classification).toBeNull();
  });

  test("the file's own classification still wins over the rescued Prädikat", () => {
    const out = fileCompleteIdentity(row({ classification: 'VDP Grosse Lage' }), colourOf);
    expect(out.classification).toBe('VDP Grosse Lage');
    expect(out.appellation).toBeNull();
  });
});
