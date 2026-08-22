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

const { buildProposedWine, summariseReasons } = require('./import');

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
