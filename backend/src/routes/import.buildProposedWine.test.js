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

const { buildProposedWine } = require('./import');

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
