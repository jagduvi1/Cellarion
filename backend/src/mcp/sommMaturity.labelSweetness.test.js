/**
 * list_maturity_queue and the label sweetness term (GitHub discussion #1754):
 * the PROJECTION decides what is said.
 *
 * WHY THIS TEST EXISTS:
 * The curator setting a drink window reads the term here — once the word has
 * left the names, this row is where "trocken" is stated. The queue selects and
 * populates the field, so a row recorded before the field existed (no key at
 * all on a lean read) must answer label_sweetness: null and the display name,
 * exactly like a row that states none; a recorded term is carried as
 * { name, band, scale, regulated }. Mock preamble copied from sommTools.test.
 */
const chain = (result) => {
  const c = {};
  for (const m of ['populate', 'sort', 'skip', 'limit', 'select']) c[m] = jest.fn(() => c);
  c.lean = jest.fn(() => Promise.resolve(result));
  c.then = (res, rej) => Promise.resolve(result).then(res, rej);
  return c;
};

jest.mock('../models/Cellar', () => ({ find: jest.fn(), findById: jest.fn() }));
jest.mock('../models/Bottle', () => ({ find: jest.fn(), findById: jest.fn(), aggregate: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../models/Rack', () => ({ find: jest.fn(), findOne: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../models/WishlistItem', () => ({ find: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../models/JournalEntry', () => ({ find: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../models/WineDefinition', () => ({ find: jest.fn(), findById: jest.fn(), aggregate: jest.fn(), populate: jest.fn(), updateOne: jest.fn(), distinct: jest.fn() }));
jest.mock('../services/enrichmentJob', () => ({
  releaseHeldProfile: jest.fn(),
  // list_maturity_queue asks whether an ABSENT profile is one automatic
  // enrichment will never write (thin identity) or merely one it has not
  // reached — the real predicate, so the branch is genuinely exercised.
  identityDataSufficient: (w) => !!(w.appellation || w.region) && !!((w.grapes && w.grapes.length) || w.type),
}));
jest.mock('../models/Country', () => ({ findOne: jest.fn() }));
jest.mock('../models/Region', () => ({ findOne: jest.fn() }));
jest.mock('../models/Grape', () => {
  // Constructable (add_grape does `new Grape().save()`) while keeping the
  // findOne static the resolver tests use.
  const ctor = jest.fn(function (doc) {
    Object.assign(this, doc);
    this._id = this._id || 'b'.repeat(24);
    this.save = jest.fn().mockResolvedValue(this);
  });
  ctor.findOne = jest.fn();
  ctor.find = jest.fn();
  return ctor;
});
// list_held_profiles flags rows with an open owner inquiry; none open here.
// Default: none open — individual tests override to assert the flag.
jest.mock('../models/WineOwnerInquiry', () => ({
  find: jest.fn(() => ({ select: () => ({ lean: () => Promise.resolve([]) }) })),
  findOne: jest.fn(),
}));
jest.mock('../models/User', () => ({ findById: jest.fn() }));
jest.mock('../models/WineEmbedding', () => ({ findOne: jest.fn() }));
jest.mock('../models/McpActionLog', () => ({ create: jest.fn(), findOne: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock('../models/WineVintageProfile', () => ({ find: jest.fn(), findById: jest.fn(), findOne: jest.fn(), countDocuments: jest.fn(), deleteOne: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock('../models/WineVintagePrice', () => {
  const M = jest.fn(function (doc) { Object.assign(this, doc); this._id = 'price-1'; this.save = jest.fn().mockResolvedValue(undefined); });
  M.aggregate = jest.fn().mockResolvedValue([]);
  M.deleteOne = jest.fn();
  return M;
});
jest.mock('../models/PriceTrackingRequest', () => ({ find: jest.fn(), findOne: jest.fn(), findById: jest.fn(), deleteOne: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock('../models/PriceTrackingSkip', () => ({ find: jest.fn(), findOne: jest.fn(), findOneAndUpdate: jest.fn(), deleteOne: jest.fn() }));
jest.mock('../models/WineCorrectionProposal', () => ({ create: jest.fn(), findById: jest.fn(), deleteOne: jest.fn(), find: jest.fn(), countDocuments: jest.fn() }));
// The self-apply path (2026-08-21) reaches the admin route's own approveProposal
// rather than duplicating the write. Mocked so this suite stays a unit test of
// the TOOL's routing; the apply itself is covered by wineProposals.test.js and
// the direct/gated decision by services/proposalDirectApply.test.js.
jest.mock('../services/wineProposalDecisionOps', () => ({ approveProposal: jest.fn() }));
// Defaults to GATED so every pre-existing proposal test keeps asserting the
// admin-review path it was written for; the self-apply tests opt in.
jest.mock('../services/proposalDirectApply', () => ({
  classifyProposal: jest.fn(async () => ({ direct: false, reason: 'admin-reviewed' })),
}));
jest.mock('../models/ProfileAuditSample', () => ({ create: jest.fn(), find: jest.fn() }));
jest.mock('../models/WineReport', () => ({ find: jest.fn(), findById: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../utils/cellarCred', () => ({ incrementCred: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../utils/rackGeometry', () => ({ getMaxPosition: jest.fn(() => 12) }));
jest.mock('../services/search', () => ({ getIsAvailable: jest.fn(() => false), search: jest.fn(), searchBottles: jest.fn(), indexWine: jest.fn().mockResolvedValue(undefined), fullSync: jest.fn().mockResolvedValue([]) }));
// edit_grape runs regional names through the admin editor's validator and
// clears the public taxonomy list cache after a grape save; both are pinned
// in editGrape.regionalNames.test.js, so here they pass through.
jest.mock('../services/grapeRegionalNames', () => ({ validateGrapeRegionalNames: jest.fn(async (value) => ({ value })) }));
jest.mock('../routes/taxonomy', () => ({ clearTaxonomyListCache: jest.fn() }));
jest.mock('../services/statsService', () => ({ computeOverview: jest.fn(), buildEmptyStats: jest.fn() }));
jest.mock('../services/vectorStore', () => ({ getPoints: jest.fn(), searchSimilar: jest.fn() }));
jest.mock('../config/aiConfig', () => ({ get: jest.fn(() => ({ vectorIndex: 'v1' })) }));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../services/embeddingJob', () => ({ reembedActiveVintages: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/notifications', () => ({ createNotification: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../utils/exchangeRates', () => ({ getOrCreateDailySnapshot: jest.fn().mockResolvedValue({}) }));
jest.mock('../services/findOrCreateWine', () => ({ findOrCreateWine: jest.fn() }));
jest.mock('../services/bottleOps', () => ({
  consumeBottle: jest.fn(), restoreBottle: jest.fn(), removeFromRacks: jest.fn(),
  RESTORE_WINDOW_MS: 2 * 24 * 60 * 60 * 1000,
  addBottle: jest.fn(), updateBottleFields: jest.fn(), removeBottleCascade: jest.fn(),
  UPDATABLE_FIELDS: ['price', 'currency', 'notes', 'occasion', 'rating', 'ratingScale', 'drinkFrom', 'drinkTo'],
}));
jest.mock('./mutationBudget', () => ({ takeMutationSlot: jest.fn(() => true), WRITE_WINDOW_MS: 15 * 60 * 1000 }));
// list_colour_conflicts reads the deterministic scan; the queue-gap tests
// below exercise the caveat it adds around that scan, not the scan itself.
jest.mock('../services/crossFieldScan', () => ({ scanCrossFieldChecks: jest.fn(async () => ({ rows: [] })) }));
// propose_wine_correction names the registry's other spellings of a proposed
// producer (2026-09-28); the lookup itself is unit-tested in its own suite.
jest.mock('../services/producerSpelling', () => ({
  ...jest.requireActual('../services/producerSpelling'),
  otherProducerSpellings: jest.fn(async () => []),
}));

const WineVintageProfile = require('../models/WineVintageProfile');
const WineVintagePrice = require('../models/WineVintagePrice');
const WineDefinition = require('../models/WineDefinition');
const Bottle = require('../models/Bottle');
const Grape = require('../models/Grape');
const McpActionLog = require('../models/McpActionLog');
const WineReport = require('../models/WineReport');
const { logAudit } = require('../services/audit');
const { createNotification } = require('../services/notifications');
const { allTools, toolsForScopes } = require('./registry');
require('./tools');

const oid = (c) => c.repeat(24);
const ME = oid('a');
const SOMM_CTX = { user: { id: ME, roles: ['somm'] }, scopes: ['read', 'write'], req: { user: { id: ME, roles: ['somm'] }, headers: {}, apiToken: { id: 't1' } } };
const USER_CTX = { user: { id: ME, roles: ['user'] }, scopes: ['read', 'write'], req: { user: { id: ME, roles: ['user'] }, headers: {} } };

const tool = (name) => allTools().find((t) => t.name === name);
const parse = (res) => JSON.parse(res.content[0].text);

beforeEach(() => jest.clearAllMocks());

const row = (wineDefinition) => ({ _id: oid('1'), vintage: '2019', status: 'pending', relative: false, wineDefinition });
const TROCKEN = { name: 'trocken', band: 'dry', scale: 'still', regulated: true };

describe('list_maturity_queue and the label sweetness term', () => {
  test('a legacy row without the field reads as no term: label_sweetness null, display_name the name', async () => {
    WineVintageProfile.countDocuments.mockResolvedValueOnce(1).mockResolvedValueOnce(1);
    WineVintageProfile.find.mockReturnValue(chain([row({ _id: oid('f'), name: 'Riesling Spätlese', producer: 'Weingut Keller', grapes: [] })]));
    const body = parse(await tool('list_maturity_queue').handler({}, SOMM_CTX));
    expect(body.data[0].wine).toMatchObject({ name: 'Riesling Spätlese', label_sweetness: null, display_name: 'Riesling Spätlese' });
  });

  test('a row recording a term carries it, and the display name reads like the label', async () => {
    WineVintageProfile.countDocuments.mockResolvedValueOnce(1).mockResolvedValueOnce(1);
    WineVintageProfile.find.mockReturnValue(chain([row({ _id: oid('f'), name: 'Riesling Spätlese', producer: 'Weingut Keller', grapes: [], labelSweetness: TROCKEN })]));
    const body = parse(await tool('list_maturity_queue').handler({}, SOMM_CTX));
    expect(body.data[0].wine.label_sweetness).toEqual(TROCKEN);
    expect(body.data[0].wine.display_name).toBe('Riesling Spätlese trocken');
  });

  test('the queue populates the term on every row', async () => {
    WineVintageProfile.countDocuments.mockResolvedValueOnce(0).mockResolvedValueOnce(0);
    const c = chain([]);
    WineVintageProfile.find.mockReturnValue(c);
    await tool('list_maturity_queue').handler({}, SOMM_CTX);
    const spec = c.populate.mock.calls[0][0];
    expect(spec.select.split(/\s+/)).toContain('labelSweetness');
    expect(JSON.stringify(spec.populate)).toContain('labelSweetness');
  });
});
