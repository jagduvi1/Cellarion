/**
 * The colour of a sparkling/dessert/fortified wine through the pending-wine
 * fix (and, via the shared validator, the private-draft edit) — support ticket
 * 2026-09-17 ("Colour Sparkling/Rosè"). The validator owns the vocabulary;
 * whether the type can carry a colour is the model hook's call.
 */
jest.mock('../models/WineDefinition', () => ({ find: jest.fn(), findById: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../models/BottleImage', () => ({ find: jest.fn(), updateOne: jest.fn() }));
jest.mock('../models/Bottle', () => ({ find: jest.fn(), distinct: jest.fn().mockResolvedValue([]) }));
jest.mock('../models/Country', () => ({ findOne: jest.fn() }));
jest.mock('./crossFieldScan', () => ({ detectCrossFieldForValues: jest.fn().mockResolvedValue(null) }));
jest.mock('./search', () => ({
  indexWine: jest.fn().mockResolvedValue(undefined),
  bulkIndexBottles: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('./embeddingJob', () => ({ reembedActiveVintages: jest.fn().mockResolvedValue(undefined) }));
jest.mock('./enrichmentJob', () => ({ enrichWineById: jest.fn().mockResolvedValue(undefined) }));
jest.mock('./indexNow', () => ({ submitUrls: jest.fn() }));
jest.mock('../utils/vintageProfile', () => ({ ensurePendingVintageProfile: jest.fn().mockResolvedValue(undefined) }));
jest.mock('./findOrCreateWine', () => ({ findOrCreateRegion: jest.fn() }));
jest.mock('./wineProfileOps', () => ({
  resolveGrapeIdsStrict: jest.fn(),
  GRAPES_MAX: 20, GRAPE_NAME_MAX: 200,
  WINE_TYPES: ['red', 'white', 'rosé', 'sparkling', 'dessert', 'fortified'],
}));

const { validatePendingFix, applyPendingFix, FIXABLE_FIELDS } = require('./pendingWineOps');

describe('validatePendingFix — colour', () => {
  test('is a fixable field', () => {
    expect(FIXABLE_FIELDS).toContain('colour');
  });

  test('accepts red/white/rosé; null or "" clears it', () => {
    expect(validatePendingFix({ colour: 'rosé' })).toEqual({ ok: true, clean: { colour: 'rosé' } });
    expect(validatePendingFix({ colour: null })).toEqual({ ok: true, clean: { colour: null } });
    expect(validatePendingFix({ colour: '' })).toEqual({ ok: true, clean: { colour: null } });
  });

  test('refuses anything else', () => {
    const r = validatePendingFix({ colour: 'orange' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/colour must be one of: red, white, rosé/);
  });
});

// Audit 2026-09-19: refused, not accepted-and-dropped by the model hook.
test('applyPendingFix refuses a colour on a wine that stays red/white/rosé, before any write', async () => {
  const wine = {
    _id: 'wine-2', name: 'Rich Ruby Red', producer: '', appellation: null, type: 'red',
    country: 'country-1', createdBy: 'u1', pendingIdentity: true, identityUnavailable: false,
    save: jest.fn(),
  };
  const res = await applyPendingFix(wine, { colour: 'rosé' }, 'curator-1');
  expect(res).toMatchObject({ ok: false, code: 'invalid_input' });
  expect(res.message).toMatch(/typed red/);
  expect(wine.colour).toBeUndefined();
  expect(wine.save).not.toHaveBeenCalled();
});

test('applyPendingFix writes the colour beside the type', async () => {
  const wine = {
    _id: 'wine-1', name: 'Rosé Extra Brut', producer: '', appellation: null, type: 'rosé',
    country: 'country-1', createdBy: 'u1', pendingIdentity: true, identityUnavailable: false,
    normalizedKey: 'pending~u1:rose extra brut:',
    save: jest.fn(async function save() { return this; }),
  };
  const res = await applyPendingFix(wine, { type: 'sparkling', colour: 'rosé' }, 'curator-1');
  expect(res.ok).toBe(true);
  expect(wine.type).toBe('sparkling');
  expect(wine.colour).toBe('rosé');
});
