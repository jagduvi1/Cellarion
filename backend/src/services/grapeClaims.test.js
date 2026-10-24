/**
 * grapeClaims — the claim key is the wine write path's fold (static alias map
 * first, then normalizeString), and the claim probe asks for every key at once.
 */

jest.mock('../models/Grape', () => ({ findOne: jest.fn() }));

const Grape = require('../models/Grape');
const { claimKey, findGrapeClaim } = require('./grapeClaims');

const probeReturns = (doc) => {
  const lean = jest.fn().mockResolvedValue(doc);
  const select = jest.fn().mockReturnValue({ lean });
  Grape.findOne.mockReturnValue({ select });
  return { select, lean };
};

beforeEach(() => jest.clearAllMocks());

describe('claimKey', () => {
  test('a static alias folds to its canonical variety', () => {
    expect(claimKey('Shiraz')).toBe('syrah');
    expect(claimKey('Primitivo')).toBe('zinfandel');
    expect(claimKey('Pinot Grigio')).toBe('pinot gris');
  });

  test('a name with no alias folds as normalizeString does', () => {
    expect(claimKey('St. Pepin')).toBe('st pepin');
    expect(claimKey('Mourvèdre')).toBe('mourvedre');
  });

  test('a blend percentage is not part of the key', () => {
    expect(claimKey('70% Monastrell')).toBe('mourvedre');
  });
});

describe('findGrapeClaim', () => {
  test('probes the folded keys by name and synonym, deduplicated', async () => {
    const { select } = probeReturns({ name: 'Syrah', synonyms: [] });
    const taken = await findGrapeClaim(['Shiraz', 'Syrah', 'SYRAH']);
    expect(taken).toEqual({ name: 'Syrah', synonyms: [] });
    expect(Grape.findOne).toHaveBeenCalledWith({
      $or: [{ normalizedName: { $in: ['syrah'] } }, { normalizedSynonyms: { $in: ['syrah'] } }],
    });
    expect(select).toHaveBeenCalledWith('name synonyms');
  });

  test('excludeId leaves the row being edited out of the probe', async () => {
    probeReturns(null);
    const taken = await findGrapeClaim(['Primitivo'], { excludeId: 'e'.repeat(24) });
    expect(taken).toBeNull();
    expect(Grape.findOne).toHaveBeenCalledWith({
      _id: { $ne: 'e'.repeat(24) },
      $or: [{ normalizedName: { $in: ['zinfandel'] } }, { normalizedSynonyms: { $in: ['zinfandel'] } }],
    });
  });

  test('strings that fold to nothing claim nothing and query nothing', async () => {
    expect(await findGrapeClaim(['', '%%%'])).toBeNull();
    expect(await findGrapeClaim([])).toBeNull();
    expect(Grape.findOne).not.toHaveBeenCalled();
  });
});
