/**
 * services/grapeRegionalNames — the grape regional-name validators as a
 * service of their own, so a caller outside the admin router can use them.
 *
 * The validators' full behaviour is pinned through the admin router in
 * routes/admin/taxonomy.grapeRegionalNames.test.js; this suite pins the
 * module's own exports: the bounds, the pair rule a second write surface
 * relies on, and that the warning check runs on the service directly.
 */

jest.mock('../models/Country', () => ({ exists: jest.fn() }));
jest.mock('../models/Region', () => ({ findById: jest.fn() }));

const Country = require('../models/Country');
const Region = require('../models/Region');
const Grape = require('../models/Grape');
const {
  REGIONAL_NAMES_MAX,
  REGIONAL_NAME_MAX_LENGTH,
  validateGrapeRegionalNames,
  computeRegionalNameWarnings,
} = require('./grapeRegionalNames');

const PORTUGAL = 'a'.repeat(24);
const regionId = (i) => i.toString(16).padStart(24, '0');

beforeEach(() => {
  jest.clearAllMocks();
  Country.exists.mockResolvedValue({ _id: PORTUGAL });
  // Every region exists and belongs to Portugal.
  Region.findById.mockImplementation((id) => ({
    select: () => ({ lean: async () => ({ _id: String(id), name: `Region ${id}`, country: PORTUGAL }) }),
  }));
});

describe('exports', () => {
  test('the bounds: 20 entries per grape, names as long as the schema allows', () => {
    expect(REGIONAL_NAMES_MAX).toBe(20);
    const nameMax = Grape.schema.path('regionalNames').schema.path('name').options.maxlength;
    expect(REGIONAL_NAME_MAX_LENGTH).toBe(nameMax);
  });
});

describe('validateGrapeRegionalNames', () => {
  test('returns the cleaned entries: trimmed name, string ids, region null when absent', async () => {
    const res = await validateGrapeRegionalNames([
      { country: PORTUGAL, region: regionId(1), name: '  Tinta Roriz ' },
      { country: PORTUGAL, name: 'Aragonez' },
    ]);
    expect(res).toEqual({
      value: [
        { country: PORTUGAL, region: regionId(1), name: 'Tinta Roriz' },
        { country: PORTUGAL, region: null, name: 'Aragonez' },
      ],
    });
    expect(Country.exists).toHaveBeenCalledWith({ _id: PORTUGAL });
  });

  test('a second name for the same place is refused', async () => {
    const res = await validateGrapeRegionalNames([
      { country: PORTUGAL, region: regionId(1), name: 'Tinta Roriz' },
      { country: PORTUGAL, region: regionId(1), name: 'Aragonez' },
    ]);
    expect(res.error).toMatch(/each place carries one display name/);
  });

  test('accepts exactly REGIONAL_NAMES_MAX places and refuses one more before any lookup', async () => {
    const places = (n) => Array.from({ length: n }, (_, i) => ({
      country: PORTUGAL, region: regionId(i + 1), name: `Name ${i}`,
    }));
    const ok = await validateGrapeRegionalNames(places(REGIONAL_NAMES_MAX));
    expect(ok.error).toBeUndefined();
    expect(ok.value).toHaveLength(REGIONAL_NAMES_MAX);

    jest.clearAllMocks();
    const over = await validateGrapeRegionalNames(places(REGIONAL_NAMES_MAX + 1));
    expect(over.error).toMatch(new RegExp(`At most ${REGIONAL_NAMES_MAX}`));
    expect(Country.exists).not.toHaveBeenCalled();
    expect(Region.findById).not.toHaveBeenCalled();
  });

  test('a name of REGIONAL_NAME_MAX_LENGTH passes, one character more is refused', async () => {
    const at = await validateGrapeRegionalNames([{ country: PORTUGAL, name: 'a'.repeat(REGIONAL_NAME_MAX_LENGTH) }]);
    expect(at.error).toBeUndefined();
    const over = await validateGrapeRegionalNames([{ country: PORTUGAL, name: 'a'.repeat(REGIONAL_NAME_MAX_LENGTH + 1) }]);
    expect(over.error).toMatch(new RegExp(`${REGIONAL_NAME_MAX_LENGTH} characters`));
  });
});

describe('computeRegionalNameWarnings', () => {
  const grape = { name: 'Tempranillo', normalizedName: 'tempranillo', synonyms: ['Tinta Roriz'] };

  test('a name that is also a synonym writes back — no warning', () => {
    expect(computeRegionalNameWarnings([{ name: 'Tinta Roriz' }], grape)).toEqual([]);
  });

  test('a name that is not a synonym warns once', () => {
    const w = computeRegionalNameWarnings([{ name: 'Tinta Roriz' }], { ...grape, synonyms: [] });
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/'Tinta Roriz' is not a synonym of Tempranillo/);
  });
});
