/**
 * mcp/tools/somm/shared — the row mappers every sommelier queue uses. The
 * tool suites pin whole rows; this file pins the honesty rules of the parts:
 * grapes and provenance only when they are known, and a profile that reports
 * its own absence or withholding instead of a silent null.
 */
jest.mock('../../../config/aiConfig', () => ({ get: jest.fn(() => ({})) }));
jest.mock('../../../services/enrichmentJob', () => ({ identityDataSufficient: jest.fn(() => true) }));
jest.mock('../../toolUtil', () => ({ labelSweetnessFields: jest.fn(() => ({})) }));

const aiConfig = require('../../../config/aiConfig');
const { identityDataSufficient } = require('../../../services/enrichmentJob');
const { labelSweetnessFields } = require('../../toolUtil');
const { wineLite, grapesLite, provenanceLite, profileLite } = require('./shared');

beforeEach(() => {
  jest.clearAllMocks();
  aiConfig.get.mockReturnValue({});
  identityDataSufficient.mockReturnValue(true);
  labelSweetnessFields.mockReturnValue({});
});

describe('grapesLite and provenanceLite', () => {
  test('grapes: names when populated, [] when genuinely empty, omitted for ids or an unselected field', () => {
    expect(grapesLite([{ name: 'Nebbiolo' }, { name: 'Barbera' }])).toEqual({ grapes: ['Nebbiolo', 'Barbera'] });
    expect(grapesLite([])).toEqual({ grapes: [] });
    expect(grapesLite(['64b0000000000000000000aa'])).toEqual({});
    expect(grapesLite(undefined)).toEqual({});
  });

  test('provenance: the model-supplied fields, sorted, from a Map or a plain object, and nothing when none', () => {
    expect(provenanceLite(new Map([['grapes', 'model'], ['region', 'person'], ['appellation', 'model']]))).toEqual({ inferred_fields: ['appellation', 'grapes'] });
    expect(provenanceLite({ grapes: 'model' })).toEqual({ inferred_fields: ['grapes'] });
    expect(provenanceLite({ grapes: 'person' })).toEqual({});
    expect(provenanceLite(null)).toEqual({});
  });
});

describe('wineLite', () => {
  test('null in, null out; identity fields read with nulls, grapes and provenance only when known, the term through labelSweetnessFields', () => {
    expect(wineLite(null)).toBeNull();
    labelSweetnessFields.mockReturnValue({ label_sweetness: { name: 'trocken' }, display_name: 'Riesling trocken' });
    const row = wineLite({
      _id: 'w1', name: 'Riesling', producer: 'Weingut X', type: 'white', country: { name: 'Germany' },
      grapes: [{ name: 'Riesling' }], identityProvenance: { grapes: 'model' },
    }, { termLoaded: true });
    expect(row).toEqual({
      wine_id: 'w1', name: 'Riesling', producer: 'Weingut X', type: 'white', country: 'Germany', region: null, appellation: null,
      label_sweetness: { name: 'trocken' }, display_name: 'Riesling trocken',
      grapes: ['Riesling'], inferred_fields: ['grapes'],
    });
    expect(labelSweetnessFields).toHaveBeenCalledWith(expect.objectContaining({ _id: 'w1' }), { loaded: true });
  });
});

describe('profileLite', () => {
  test('no profile: absent, with what will actually happen to it', () => {
    expect(profileLite(undefined, { region: 'r' })).toEqual({ absent: true, reason: 'not enriched yet', auto_enrich: 'pending' });
    aiConfig.get.mockReturnValue({ enrichmentOnAdd: 'off' });
    expect(profileLite({}, { region: 'r' })).toMatchObject({ absent: true, auto_enrich: 'off' });
    identityDataSufficient.mockReturnValue(false);
    expect(profileLite({ description: '' }, { name: 'thin' })).toMatchObject({ absent: true, auto_enrich: 'skipped_thin_identity' });
  });

  test('a held profile reports itself withheld with the reason, no prose', () => {
    const held = profileLite({ generatedAt: new Date(), heldAt: new Date(), heldReason: 'low_confidence', confidence: 0.2, searchUsed: true }, {});
    expect(held).toMatchObject({ withheld: true, held_reason: 'low_confidence', description: null, ai_confidence: 0.2, search_assisted: true });
    expect(held.withheld_reason).toMatch(/confidence floor/);
    expect(profileLite({ generatedAt: new Date(), heldAt: new Date(), heldReason: 'producer_suspect', producerNote: 'brand, not estate' }, {}).withheld_reason).toBe('brand, not estate');
  });

  test('a published profile reads in full; a curator profile carries no confidence; a generated stamp with no content is null', () => {
    expect(profileLite({ generatedAt: new Date(), description: 'Bright cherry.', body: 'light', confidence: 0.7, producerUnknown: true }, {}))
      .toMatchObject({ description: 'Bright cherry.', body: 'light', ai_confidence: 0.7, producer_unknown: true, source: 'ai', flavors: [], food_pairings: [] });
    expect(profileLite({ description: 'Written by hand.', source: 'curator', confidence: 0.9 }, {}).ai_confidence).toBeNull();
    expect(profileLite({ generatedAt: new Date() }, {})).toBeNull();
  });
});
