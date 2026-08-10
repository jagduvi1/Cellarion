/**
 * ensurePendingVintageProfile — queue-seeding invariants.
 *
 * Pins the NV `relative` derivation (support ticket d49d2b36: the flag is
 * fully determined by the vintage string, and seeding it false shipped every
 * NV wine into the maturity queue self-contradictory), the $setOnInsert
 * idempotence contract, the Unknown-vintage no-op, the nonWine-quarantine
 * skip (a quarantined cider must not re-enter the somm queue on every
 * re-added bottle), and the non-throwing best-effort behaviour.
 */

jest.mock('../models/WineVintageProfile', () => ({ findOneAndUpdate: jest.fn() }));
jest.mock('../models/WineDefinition', () => ({ exists: jest.fn() }));

const WineVintageProfile = require('../models/WineVintageProfile');
const WineDefinition = require('../models/WineDefinition');
const { ensurePendingVintageProfile } = require('./vintageProfile');

const WINE = 'a'.repeat(24);

beforeEach(() => {
  jest.clearAllMocks();
  WineVintageProfile.findOneAndUpdate.mockResolvedValue(null);
  WineDefinition.exists.mockResolvedValue(null); // not quarantined by default
});

test('a year vintage seeds a pending stub with relative:false', async () => {
  await ensurePendingVintageProfile(WINE, '2018');
  expect(WineVintageProfile.findOneAndUpdate).toHaveBeenCalledWith(
    { wineDefinition: WINE, vintage: '2018' },
    { $setOnInsert: { wineDefinition: WINE, vintage: '2018', status: 'pending', relative: false } },
    { upsert: true, new: false }
  );
});

test('NV seeds with relative:true — the flag is derived, never defaulted', async () => {
  await ensurePendingVintageProfile(WINE, 'NV');
  const [, update] = WineVintageProfile.findOneAndUpdate.mock.calls[0];
  expect(update.$setOnInsert).toMatchObject({ vintage: 'NV', status: 'pending', relative: true });
});

test('everything lives under $setOnInsert so an existing profile is never touched', async () => {
  await ensurePendingVintageProfile(WINE, 'NV');
  const [, update] = WineVintageProfile.findOneAndUpdate.mock.calls[0];
  expect(Object.keys(update)).toEqual(['$setOnInsert']);
});

test('Unknown vintage and missing args are no-ops', async () => {
  await ensurePendingVintageProfile(WINE, 'Unknown');
  await ensurePendingVintageProfile(null, '2018');
  await ensurePendingVintageProfile(WINE, '');
  expect(WineVintageProfile.findOneAndUpdate).not.toHaveBeenCalled();
});

test('a nonWine-quarantined wine never seeds — the quarantine covers the somm queue too', async () => {
  WineDefinition.exists.mockResolvedValue({ _id: WINE });
  await ensurePendingVintageProfile(WINE, '2018');
  expect(WineDefinition.exists).toHaveBeenCalledWith({ _id: WINE, nonWine: true });
  expect(WineVintageProfile.findOneAndUpdate).not.toHaveBeenCalled();
});

test('a write failure is swallowed — seeding is best-effort next to the bottle save', async () => {
  WineVintageProfile.findOneAndUpdate.mockRejectedValue(new Error('duplicate key'));
  await expect(ensurePendingVintageProfile(WINE, '2018')).resolves.toBeUndefined();
  // The quarantine pre-check is inside the same best-effort envelope.
  WineDefinition.exists.mockRejectedValue(new Error('db down'));
  await expect(ensurePendingVintageProfile(WINE, '2018')).resolves.toBeUndefined();
});
