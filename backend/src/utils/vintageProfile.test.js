// ensurePendingVintageProfile does a single findOneAndUpdate upsert; mock the
// model so the create-only / skip logic can be asserted without a live MongoDB
// (the full round-trip is covered by the Docker smoke test).
jest.mock('../models/WineVintageProfile', () => ({
  findOneAndUpdate: jest.fn(),
}));

const { ensurePendingVintageProfile } = require('./vintageProfile');
const WineVintageProfile = require('../models/WineVintageProfile');

describe('ensurePendingVintageProfile', () => {
  beforeEach(() => jest.clearAllMocks());

  test('upserts a pending profile for a year vintage', async () => {
    WineVintageProfile.findOneAndUpdate.mockResolvedValue(null);
    await ensurePendingVintageProfile('w1', '2018');
    expect(WineVintageProfile.findOneAndUpdate).toHaveBeenCalledWith(
      { wineDefinition: 'w1', vintage: '2018' },
      { $setOnInsert: { wineDefinition: 'w1', vintage: '2018', status: 'pending' } },
      { upsert: true, new: false }
    );
  });

  test('creates a profile for NV (somms attach notes to non-vintage wines)', async () => {
    WineVintageProfile.findOneAndUpdate.mockResolvedValue(null);
    await ensurePendingVintageProfile('w1', 'NV');
    expect(WineVintageProfile.findOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  test('no-ops for the "Unknown" vintage (no year to recommend a window for)', async () => {
    await ensurePendingVintageProfile('w1', 'Unknown');
    expect(WineVintageProfile.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test('no-ops when the wine id or vintage is missing', async () => {
    await ensurePendingVintageProfile(null, '2018');
    await ensurePendingVintageProfile('w1', '');
    await ensurePendingVintageProfile('w1', undefined);
    expect(WineVintageProfile.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test('swallows errors (best-effort) — never throws', async () => {
    WineVintageProfile.findOneAndUpdate.mockRejectedValue(new Error('E11000 dup key'));
    await expect(ensurePendingVintageProfile('w1', '2018')).resolves.toBeUndefined();
  });
});
