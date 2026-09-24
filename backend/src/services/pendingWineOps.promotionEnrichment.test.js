/**
 * runPromotionFollowThrough under sommelier-owned wine data (2026-09-24).
 *
 * enrichmentOnAdd 'off' has meant "the AI writes nothing automatically" since
 * 2026-08-22, but completing a pending wine or publishing a draft — both run
 * this function — still generated a tasting profile, which the sommelier then
 * overwrote. Pins both sides: 'off' makes no AI call while every other
 * follow-through step still runs; any other mode enriches the promoted wine
 * exactly as before (the self-hosted default).
 */
jest.mock('../models/WineDefinition', () => ({ find: jest.fn(), findById: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../models/BottleImage', () => ({ find: jest.fn() }));
jest.mock('../models/Bottle', () => ({ find: jest.fn(), distinct: jest.fn().mockResolvedValue([]) }));
jest.mock('../models/Country', () => ({ findOne: jest.fn() }));
jest.mock('./labelScanAccess', () => ({ stampPromotedScanRetention: jest.fn().mockResolvedValue(undefined) }));
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
jest.mock('./appellationResolve', () => ({ resolveCanonicalAppellation: jest.fn(async (v) => v) }));
jest.mock('./wineProfileOps', () => ({
  resolveGrapeIdsStrict: jest.fn(),
  GRAPES_MAX: 20,
  GRAPE_NAME_MAX: 200,
  WINE_TYPES: ['red', 'white', 'rosé', 'sparkling', 'dessert', 'fortified'],
}));
jest.mock('../config/aiConfig', () => ({ get: jest.fn() }));

const aiConfig = require('../config/aiConfig');
const { enrichWineById } = require('./enrichmentJob');
const { reembedActiveVintages } = require('./embeddingJob');
const { indexWine } = require('./search');
const { stampPromotedScanRetention } = require('./labelScanAccess');
const { runPromotionFollowThrough } = require('./pendingWineOps');

const WINE = { _id: 'wine-1', slug: 'finca-x-crianza' };

beforeEach(() => jest.clearAllMocks());

test("'off': no AI profile is generated, and the rest of the follow-through still runs", async () => {
  aiConfig.get.mockReturnValue({ enrichmentOnAdd: 'off' });
  await runPromotionFollowThrough(WINE);
  expect(enrichWineById).not.toHaveBeenCalled();
  // Search, embeddings and the scan clock are not profile writes — they stay.
  expect(stampPromotedScanRetention).toHaveBeenCalledWith(WINE);
  expect(indexWine).toHaveBeenCalledWith('wine-1');
  expect(reembedActiveVintages).toHaveBeenCalledWith('wine-1');
});

test.each(['sufficient', 'always'])("'%s': the promoted wine is enriched as before", async (mode) => {
  aiConfig.get.mockReturnValue({ enrichmentOnAdd: mode });
  await runPromotionFollowThrough(WINE);
  expect(enrichWineById).toHaveBeenCalledWith('wine-1');
});
