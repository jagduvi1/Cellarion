/**
 * Somm MCP tools — role-gating + shared-data safety invariants.
 *
 * Pins: structural invisibility without the somm/admin role (registry level)
 * AND the in-handler re-check; the NV-relative vs absolute-year validation
 * mirror; phase ordering; prev snapshots for undo; append-only price entries
 * with currency validation; ledger attribution.
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
jest.mock('../models/WineDefinition', () => ({ find: jest.fn(), findById: jest.fn(), aggregate: jest.fn(), populate: jest.fn(), updateOne: jest.fn() }));
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
  return ctor;
});
// list_held_profiles flags rows with an open owner inquiry (somm 6a872b98).
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
jest.mock('../routes/admin/wineProposals', () => ({ approveProposal: jest.fn() }));
// Defaults to GATED so every pre-existing proposal test keeps asserting the
// admin-review path it was written for; the self-apply tests opt in.
jest.mock('../services/proposalDirectApply', () => ({
  classifyProposal: jest.fn(async () => ({ direct: false, reason: 'admin-reviewed' })),
}));
jest.mock('../models/ProfileAuditSample', () => ({ create: jest.fn(), find: jest.fn() }));
jest.mock('../models/WineReport', () => ({ find: jest.fn(), findById: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../utils/cellarCred', () => ({ incrementCred: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../utils/rackGeometry', () => ({ getMaxPosition: jest.fn(() => 12) }));
jest.mock('../services/search', () => ({ getIsAvailable: jest.fn(() => false), search: jest.fn(), searchBottles: jest.fn(), indexWine: jest.fn().mockResolvedValue(undefined) }));
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
const SOMM_TOOLS = ['list_maturity_queue', 'set_vintage_maturity', 'remove_from_maturity_queue', 'set_wine_profile', 'add_grape', 'edit_grape', 'propose_wine_correction', 'list_price_tracking_requests', 'set_vintage_price', 'reject_price_request', 'list_wine_reports', 'respond_to_wine_report', 'sample_published_profiles', 'list_unverified_core_wines', 'list_held_profiles', 'review_held_profile', 'list_pending_corrections', 'record_profile_audit', 'list_profile_audits', 'list_colour_conflicts', 'dismiss_colour_conflict', 'restore_colour_conflict', 'list_rule_downgrades', 'list_ungrounded_descriptions'];

beforeEach(() => {
  jest.clearAllMocks();
  McpActionLog.create.mockResolvedValue({});
});

describe('role gating (structural + in-handler)', () => {
  test('somm tools are INVISIBLE without the role, visible with somm or admin', () => {
    const plain = toolsForScopes(['read', 'write'], ['user']).map((t) => t.name);
    for (const n of SOMM_TOOLS) expect(plain).not.toContain(n);
    const somm = toolsForScopes(['read', 'write'], ['somm']).map((t) => t.name);
    const admin = toolsForScopes(['read', 'write'], ['admin']).map((t) => t.name);
    for (const n of SOMM_TOOLS) {
      expect(somm).toContain(n);
      expect(admin).toContain(n);
    }
    // scope still applies on top of role: read-only somm token sees listers only
    const readSomm = toolsForScopes(['read'], ['somm']).map((t) => t.name);
    expect(readSomm).toContain('list_maturity_queue');
    expect(readSomm).not.toContain('set_vintage_maturity');
    expect(readSomm).not.toContain('reject_price_request');
  });

  test('defense-in-depth: handlers refuse a role-less ctx even if reached', async () => {
    for (const n of SOMM_TOOLS) {
      const res = await tool(n).handler({ profile_id: oid('1'), wine_id: oid('2'), vintage: 'NV', price: 1 }, USER_CTX);
      expect(parse(res).error.code).toBe('forbidden_scope');
    }
  });
});

describe('list_maturity_queue', () => {
  test('defaults to pending, reports the pending count, pages at ≤50', async () => {
    WineVintageProfile.countDocuments.mockResolvedValueOnce(7).mockResolvedValueOnce(7);
    WineVintageProfile.find.mockReturnValue(chain([{
      _id: oid('1'), vintage: '2019', status: 'pending', relative: false,
      wineDefinition: { _id: oid('f'), name: 'Barolo', producer: 'P', grapes: [] },
    }]));
    const res = await tool('list_maturity_queue').handler({}, SOMM_CTX);
    const body = parse(res);
    expect(body.summary).toMatch(/7 pending/);
    expect(WineVintageProfile.find.mock.calls[0][0]).toEqual({ status: 'pending' });
    expect(body.data[0].profile_id).toBe(oid('1'));
    expect(body.data[0].phases).toHaveProperty('peakFrom', null);
  });

  // Curator feedback on v1.101.0: reaching one wine's reviewed rows meant
  // paginating ~5,600 profiles at 50/page. A wine-scoped call is one call —
  // and defaults to status 'all', because "what is curated for THIS wine"
  // wants reviewed rows, not the pending default.
  test('wine_id scopes the queue and defaults to all statuses; vintage narrows further (nv → NV)', async () => {
    WineVintageProfile.countDocuments.mockResolvedValue(0);
    WineVintageProfile.find.mockReturnValue(chain([]));
    await tool('list_maturity_queue').handler({ wine_id: oid('f') }, SOMM_CTX);
    expect(WineVintageProfile.find.mock.calls[0][0]).toEqual({ wineDefinition: oid('f') });

    await tool('list_maturity_queue').handler({ wine_id: oid('f'), status: 'pending' }, SOMM_CTX);
    expect(WineVintageProfile.find.mock.calls[1][0]).toEqual({ status: 'pending', wineDefinition: oid('f') });

    await tool('list_maturity_queue').handler({ wine_id: oid('f'), vintage: 'nv ' }, SOMM_CTX);
    expect(WineVintageProfile.find.mock.calls[2][0]).toEqual({ wineDefinition: oid('f'), vintage: 'NV' });

    // Unscoped calls keep the pending-queue default — the killer workflow is untouched.
    await tool('list_maturity_queue').handler({}, SOMM_CTX);
    expect(WineVintageProfile.find.mock.calls[3][0]).toEqual({ status: 'pending' });
  });

  // #787: the note was fetched but dropped in the row mapping — write-only data.
  test('reviewed rows carry the curator note; absent note reads as null', async () => {
    WineVintageProfile.countDocuments.mockResolvedValueOnce(2).mockResolvedValueOnce(0);
    WineVintageProfile.find.mockReturnValue(chain([
      {
        _id: oid('1'), vintage: '2023', status: 'reviewed', relative: false,
        sommNotes: 'Drink young — fruit fades fast.',
        wineDefinition: { _id: oid('f'), name: 'Pinot Noir', producer: 'Matua', grapes: [] },
      },
      {
        _id: oid('2'), vintage: '2019', status: 'reviewed', relative: false,
        wineDefinition: { _id: oid('f'), name: 'Barolo', producer: 'P', grapes: [] },
      },
    ]));
    const body = parse(await tool('list_maturity_queue').handler({ status: 'reviewed' }, SOMM_CTX));
    expect(body.data[0].somm_notes).toBe('Drink young — fruit fades fast.');
    expect(body.data[1].somm_notes).toBeNull();
  });

  // Somm ticket 6a911643 (2026-08-28). The inline tasting_profile reported
  // curator-verified profiles as {absent: true}, because presence was tested
  // by generatedAt — the AI's stamp, which a hand-written profile never has.
  // On production 1,769 of 2,113 curator profiles were misreported. Acting on
  // the field, a curator overwrote another curator's deliberate decision not
  // to set a window, and set_wine_profile accepted it silently.
  describe('inline tasting_profile reflects the STORED profile (6a911643)', () => {
    const aiConfig = require('../config/aiConfig');
    const row = (aiProfile, wineExtra = {}) => ({
      _id: oid('1'), vintage: '2016', status: 'pending', relative: false,
      wineDefinition: {
        _id: oid('f'), name: 'Signature Blend', producer: 'The Winery at St. George',
        region: { name: 'Somewhere' }, type: 'red', grapes: [], aiProfile, ...wineExtra,
      },
    });
    const queue = async () => {
      WineVintageProfile.countDocuments.mockResolvedValue(1);
      const body = parse(await tool('list_maturity_queue').handler({}, SOMM_CTX));
      return body.data[0].tasting_profile;
    };
    beforeEach(() => aiConfig.get.mockReturnValue({ vectorIndex: 'v1', enrichmentOnAdd: 'off' }));

    test('a curator-written profile (no generatedAt) is returned in full, not as absent', async () => {
      // Exactly the shape of the five wines in the ticket: source curator,
      // verifiedAt set, generatedAt null, description present.
      WineVintageProfile.find.mockReturnValue(chain([row({
        source: 'curator', generatedAt: null, verifiedAt: new Date('2026-08-26'),
        description: 'Cannot be identified; no drinking window should be set. Owner inquiry open.',
        body: 'medium',
      })]));
      const tp = await queue();
      expect(tp.absent).toBeUndefined();
      expect(tp.source).toBe('curator');
      expect(tp.description).toMatch(/no drinking window should be set/);
      expect(tp.verified_at).toBeTruthy();
      expect(tp.ai_confidence).toBeNull();
    });

    test('a genuinely empty profile is still absent', async () => {
      WineVintageProfile.find.mockReturnValue(chain([row({ source: 'ai', generatedAt: null, description: null })]));
      const tp = await queue();
      expect(tp.absent).toBe(true);
    });

    test('no aiProfile at all is absent', async () => {
      WineVintageProfile.find.mockReturnValue(chain([row(undefined)]));
      expect((await queue()).absent).toBe(true);
    });

    test('with enrichment OFF, an absent profile says "off" — never a "pending" that will not arrive', async () => {
      // "pending" read as "someone else will write this". With enrichmentOnAdd
      // off since 2026-08-22, nothing was ever coming.
      WineVintageProfile.find.mockReturnValue(chain([row(undefined)]));
      const tp = await queue();
      expect(tp.auto_enrich).toBe('off');
      expect(tp.reason).toMatch(/switched off/);
      expect(tp.reason).toMatch(/yours to write/);
    });

    test('with enrichment ON, an absent profile on a sufficient record is "pending"', async () => {
      aiConfig.get.mockReturnValue({ vectorIndex: 'v1', enrichmentOnAdd: 'sufficient' });
      WineVintageProfile.find.mockReturnValue(chain([row(undefined)]));
      const tp = await queue();
      expect(tp.auto_enrich).toBe('pending');
      expect(tp.reason).toBe('not enriched yet');
    });

    test('a thin-identity record is "skipped_thin_identity" regardless of the mode', async () => {
      aiConfig.get.mockReturnValue({ vectorIndex: 'v1', enrichmentOnAdd: 'sufficient' });
      WineVintageProfile.find.mockReturnValue(chain([row(undefined, { region: null, appellation: null })]));
      const tp = await queue();
      expect(tp.auto_enrich).toBe('skipped_thin_identity');
    });

    test('a curator profile on a THIN record is still reported in full — the highest-risk case', async () => {
      // Thin-identity records are the ones where the curator profile is the
      // only one that will ever exist; misreporting those as absent came with
      // a reason string that instructed the curator to overwrite it.
      WineVintageProfile.find.mockReturnValue(chain([row(
        { source: 'curator', generatedAt: null, description: 'Hand-written for a placeless record.' },
        { region: null, appellation: null },
      )]));
      const tp = await queue();
      expect(tp.absent).toBeUndefined();
      expect(tp.source).toBe('curator');
    });
  });
});

describe('set_vintage_maturity', () => {
  const profile = (over = {}) => {
    const p = {
      _id: oid('1'), vintage: '2019', status: 'pending', relative: false,
      wineDefinition: { _id: oid('f'), name: 'Barolo' },
      save: jest.fn().mockResolvedValue(undefined),
      ...over,
    };
    WineVintageProfile.findById.mockReturnValue(chain(p));
    return p;
  };

  test('year vintages validate 1900–2200; ordering enforced', async () => {
    profile();
    let res = await tool('set_vintage_maturity').handler({ profile_id: oid('1'), peak_from: 1500 }, SOMM_CTX);
    expect(parse(res).error.message).toMatch(/1900–2200/);
    profile();
    res = await tool('set_vintage_maturity').handler({ profile_id: oid('1'), peak_from: 2030, peak_until: 2025 }, SOMM_CTX);
    expect(parse(res).error.message).toMatch(/cannot be before/);
    profile();
    res = await tool('set_vintage_maturity').handler({ profile_id: oid('1'), early_from: 2030, peak_from: 2025 }, SOMM_CTX);
    expect(parse(res).error.message).toMatch(/peak_from cannot be before early_from/);
  });

  test('NV vintages use relative offsets 0–100 and set relative=true', async () => {
    const p = profile({ vintage: 'NV' });
    let res = await tool('set_vintage_maturity').handler({ profile_id: oid('1'), peak_from: 1990 }, SOMM_CTX);
    expect(parse(res).error.message).toMatch(/relative offsets 0–100/);
    const p2 = profile({ vintage: 'NV' });
    res = await tool('set_vintage_maturity').handler({ profile_id: oid('1'), peak_from: 1, peak_until: 5 }, SOMM_CTX);
    expect(parse(res).error).toBeUndefined();
    expect(p2.relative).toBe(true);
    expect(p2.status).toBe('reviewed');
  });

  // #787: the write landed but the response echoed phases only, so a curator
  // had no way to confirm the note saved.
  test('echoes the note it just saved, and the pre-existing note when none is sent', async () => {
    const p = profile();
    let body = parse(await tool('set_vintage_maturity').handler(
      { profile_id: oid('1'), peak_from: 2026, somm_notes: 'Hold two more years.' }, SOMM_CTX));
    expect(body.error).toBeUndefined();
    expect(p.sommNotes).toBe('Hold two more years.');
    expect(body.data.somm_notes).toBe('Hold two more years.');

    profile({ sommNotes: 'Existing note.' });
    body = parse(await tool('set_vintage_maturity').handler({ profile_id: oid('1'), peak_from: 2026 }, SOMM_CTX));
    expect(body.data.somm_notes).toBe('Existing note.');

    profile();
    body = parse(await tool('set_vintage_maturity').handler({ profile_id: oid('1'), peak_from: 2026 }, SOMM_CTX));
    expect(body.data.somm_notes).toBeNull();
  });

  // Ticket d49cc924: once a pair left the pending queue nothing returned its
  // profile_id, so a published-but-wrong window was unreachable over MCP.
  test('wine_id + vintage reaches a REVIEWED profile (the published-window correction path)', async () => {
    const p = {
      _id: oid('1'), vintage: '2017', status: 'reviewed', relative: false,
      peakFrom: 2024, peakUntil: 2029,
      wineDefinition: { _id: oid('f'), name: 'The Dead Arm Shiraz' },
      save: jest.fn().mockResolvedValue(undefined),
    };
    WineVintageProfile.findOne.mockReturnValue(chain(p));
    const body = parse(await tool('set_vintage_maturity').handler(
      { wine_id: oid('f'), vintage: '2017', peak_from: 2024, peak_until: 2036 }, SOMM_CTX));
    expect(body.error).toBeUndefined();
    expect(WineVintageProfile.findOne).toHaveBeenCalledWith({ wineDefinition: oid('f'), vintage: '2017' });
    expect(WineVintageProfile.findById).not.toHaveBeenCalled();
    expect(p.peakUntil).toBe(2036);
    expect(p.status).toBe('reviewed');
    expect(p.save).toHaveBeenCalled();
  });

  test('wine_id route canonicalizes the vintage ("nv " → NV) and misses with a seeding hint', async () => {
    WineVintageProfile.findOne.mockReturnValue(chain(null));
    const body = parse(await tool('set_vintage_maturity').handler(
      { wine_id: oid('f'), vintage: 'nv ', peak_from: 1, peak_until: 5 }, SOMM_CTX));
    expect(WineVintageProfile.findOne).toHaveBeenCalledWith({ wineDefinition: oid('f'), vintage: 'NV' });
    expect(body.error.code).toBe('not_found');
    expect(body.error.message).toMatch(/seeded when a bottle/);
  });

  test('profile_id wins when both address forms are sent; neither/half-address is invalid_input', async () => {
    const p = profile();
    let body = parse(await tool('set_vintage_maturity').handler(
      { profile_id: oid('1'), wine_id: oid('f'), vintage: '2019', peak_from: 2026 }, SOMM_CTX));
    expect(body.error).toBeUndefined();
    expect(WineVintageProfile.findOne).not.toHaveBeenCalled();
    expect(p.save).toHaveBeenCalled();

    body = parse(await tool('set_vintage_maturity').handler({ peak_from: 2026 }, SOMM_CTX));
    expect(body.error.code).toBe('invalid_input');
    body = parse(await tool('set_vintage_maturity').handler({ vintage: '2019', peak_from: 2026 }, SOMM_CTX));
    expect(body.error.code).toBe('invalid_input');
    body = parse(await tool('set_vintage_maturity').handler({ wine_id: oid('f'), peak_from: 2026 }, SOMM_CTX));
    expect(body.error.code).toBe('invalid_input');
  });

  // Audit 2026-08-10: profiles predating the relative-flag derivation hold
  // absolute years under vintage 'NV'; a partial write flips relative=true on
  // save, silently reinterpreting retained years as offsets. Must refuse.
  test('a partial write on an NV profile carrying absolute years is refused, a full rewrite lands', async () => {
    profile({ vintage: 'NV', relative: false, peakFrom: 2024, peakUntil: 2029 });
    let body = parse(await tool('set_vintage_maturity').handler(
      { profile_id: oid('1'), somm_notes: 'legacy row' }, SOMM_CTX));
    expect(body.error.code).toBe('conflict');
    expect(body.error.message).toMatch(/retained from the stored profile/);

    const p = profile({ vintage: 'NV', relative: false, peakFrom: 2024, peakUntil: 2029 });
    body = parse(await tool('set_vintage_maturity').handler(
      { profile_id: oid('1'), early_from: 0, early_until: 1, peak_from: 2, peak_until: 4, late_from: null, late_until: null }, SOMM_CTX));
    expect(body.error).toBeUndefined();
    expect(p.relative).toBe(true);
    expect(p.save).toHaveBeenCalled();
  });

  test('prev snapshot captures phases + review state for undo; audit uses the REST action string', async () => {
    const p = profile({ peakFrom: 2020, peakUntil: 2030, status: 'reviewed', setBy: oid('b'), setAt: new Date('2026-01-01') });
    await tool('set_vintage_maturity').handler({ profile_id: oid('1'), peak_from: 2026, peak_until: 2040 }, SOMM_CTX);
    const row = McpActionLog.create.mock.calls[0][0];
    expect(row.action).toBe('somm_maturity');
    expect(row.prev).toMatchObject({ peakFrom: 2020, peakUntil: 2030, status: 'reviewed', setBy: oid('b') });
    expect(logAudit).toHaveBeenCalledWith(SOMM_CTX.req, 'somm.maturity.review',
      expect.anything(), expect.objectContaining({ via: 'mcp' }));
    expect(p.setBy).toBe(ME);
  });
});

describe('remove_from_maturity_queue', () => {
  const profile = (over = {}) => {
    const p = {
      _id: oid('1'), vintage: '2027', status: 'pending', relative: false,
      wineDefinition: { _id: oid('f'), name: 'Barolo' },
      ...over,
    };
    WineVintageProfile.findById.mockReturnValue(chain(p));
    return p;
  };

  beforeEach(() => {
    WineVintageProfile.deleteOne.mockResolvedValue({ deletedCount: 1 });
  });

  test('deletes a pending row; the ledger prev carries wine+vintage so undo can re-seed', async () => {
    profile();
    const body = parse(await tool('remove_from_maturity_queue').handler(
      { profile_id: oid('1'), reason: '2027 not released' }, SOMM_CTX));
    expect(body.error).toBeUndefined();
    expect(WineVintageProfile.deleteOne).toHaveBeenCalledWith({ _id: oid('1') });
    const row = McpActionLog.create.mock.calls[0][0];
    expect(row.action).toBe('somm_maturity_remove');
    // The row being deleted, wine+vintage is ALL the undo has to work from.
    expect(row.prev).toEqual({ wineDefinition: oid('f'), vintage: '2027' });
    expect(logAudit).toHaveBeenCalledWith(SOMM_CTX.req, 'somm.maturity.remove',
      expect.anything(), expect.objectContaining({ reason: '2027 not released', via: 'mcp' }));
  });

  test('refuses a reviewed row — reset it first rather than silently retiring curated data', async () => {
    profile({ status: 'reviewed' });
    const body = parse(await tool('remove_from_maturity_queue').handler({ profile_id: oid('1') }, SOMM_CTX));
    expect(body.error.code).toBe('conflict');
    expect(WineVintageProfile.deleteOne).not.toHaveBeenCalled();
  });

  test('undo re-seeds the pending stub via upsert and CLAIMS the ledger row', async () => {
    const row = {
      _id: 'sr', action: 'somm_maturity_remove', reversed: false,
      detail: { profileId: oid('1'), vintage: '2027' },
      prev: { wineDefinition: oid('f'), vintage: '2027' },
    };
    McpActionLog.findOne.mockReturnValue(chain(row));
    McpActionLog.findOneAndUpdate.mockResolvedValue(row);
    WineVintageProfile.findOneAndUpdate.mockResolvedValue({});
    const res = await tool('undo_last').handler({}, { ...SOMM_CTX, scopes: ['consume', 'write'] });
    expect(parse(res).data.undone).toBe('remove_from_maturity_queue');
    // Upsert, not insert: a bottle add may already have re-seeded the pair, and
    // the undo must land on "it is in the queue again" either way.
    expect(WineVintageProfile.findOneAndUpdate).toHaveBeenCalledWith(
      { wineDefinition: oid('f'), vintage: '2027' },
      { $setOnInsert: { wineDefinition: oid('f'), vintage: '2027', status: 'pending' } },
      { upsert: true }
    );
    expect(McpActionLog.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'sr', reversed: false }, { $set: { reversed: true, idempotencyKey: null } });
  });
});

describe('set_wine_profile', () => {
  const wine = (over = {}) => {
    const w = {
      _id: oid('f'), name: 'Vintage Port', producer: 'Sandeman',
      aiProfile: { description: 'Built for immediate drinking.', source: 'ai', confidence: 0.6 },
      markModified: jest.fn(),
      save: jest.fn().mockResolvedValue(undefined),
      ...over,
    };
    WineDefinition.findById.mockResolvedValue(w);
    return w;
  };

  test('applies the patch, stamps curator provenance, and logs an undoable ledger row', async () => {
    const w = wine();
    const body = parse(await tool('set_wine_profile').handler(
      { wine_id: oid('f'), description: 'Among the longest-ageing wines in the Douro.' }, SOMM_CTX));
    expect(body.error).toBeUndefined();
    expect(w.aiProfile.description).toBe('Among the longest-ageing wines in the Douro.');
    // 'curator' is what stops enrichmentJob regenerating over the correction.
    expect(w.aiProfile.source).toBe('curator');
    expect(w.save).toHaveBeenCalled();
    const row = McpActionLog.create.mock.calls[0][0];
    expect(row.action).toBe('somm_wine_profile');
    expect(row.prev).toMatchObject({ description: 'Built for immediate drinking.', source: 'ai' });
    expect(logAudit).toHaveBeenCalledWith(SOMM_CTX.req, 'somm.wineProfile.update',
      expect.anything(), expect.objectContaining({ via: 'mcp' }));
  });

  // Ticket d4a1aef5: the vin jaune case — accurate prose, wrong type, empty
  // grapes. The record fields must be correctable without claiming the
  // (already-correct) tasting profile was curator-verified.
  test('type + grapes correct the record WITHOUT claiming the profile verified', async () => {
    const w = wine({ type: 'fortified', grapes: [] });
    Grape.findOne.mockReturnValue(chain({ _id: oid('9'), name: 'Savagnin' }));
    const body = parse(await tool('set_wine_profile').handler(
      { wine_id: oid('f'), type: 'white', grapes: ['Savagnin'] }, SOMM_CTX));
    expect(body.error).toBeUndefined();
    expect(w.type).toBe('white');
    expect(w.grapes).toEqual([oid('9')]);
    expect(w.aiProfile.source).toBe('ai'); // profile untouched, still enrichment-eligible
    expect(body.summary).toMatch(/record fields corrected/);
    expect(body.data.record).toEqual({ type: 'white', grapes: ['Savagnin'] });
    // The undo snapshot carries the record fields so undo_last can put them back.
    expect(McpActionLog.create.mock.calls[0][0].prev).toMatchObject({ type: 'fortified', grapes: [] });
  });

  // Ticket 2026-08-11: "Tinta Roriz" was silently stored as Tempranillo. The
  // canonicalisation itself is the design (one variety doc keeps search and
  // stats coherent) — but the response must SAY it happened, at every reading
  // depth: summary, record payload, and note.
  test('a synonym-stored grape is REPORTED as a substitution, never silent', async () => {
    const w = wine({ type: 'fortified', grapes: [] });
    Grape.findOne.mockReturnValue(chain({ _id: oid('9'), name: 'Tempranillo' }));
    const body = parse(await tool('set_wine_profile').handler(
      { wine_id: oid('f'), grapes: ['Tinta Roriz'] }, SOMM_CTX));
    expect(body.error).toBeUndefined();
    expect(w.grapes).toEqual([oid('9')]);
    expect(body.summary).toMatch(/"Tinta Roriz" as Tempranillo/);
    expect(body.data.record.grapes).toEqual(['Tempranillo']);
    expect(body.data.record.grape_substitutions).toEqual(['Tinta Roriz → Tempranillo']);
    expect(body.data.note).toMatch(/canonical variety doc/);
  });

  test('an unknown grape variety refuses the whole write — match-only, nothing minted', async () => {
    const w = wine({ type: 'white', grapes: [] });
    Grape.findOne.mockReturnValue(chain(null));
    const body = parse(await tool('set_wine_profile').handler(
      { wine_id: oid('f'), grapes: ['Savagnin Rose'] }, SOMM_CTX));
    expect(body.error.code).toBe('invalid_input');
    expect(body.error.message).toMatch(/Savagnin Rose/);
    expect(w.save).not.toHaveBeenCalled();
  });

  // Ticket d49ca3af: clearing used to curator-freeze the wine out of
  // enrichment — the worst-sourced rows got locked empty.
  test('a write that ONLY clears does not curator-freeze; the response says so', async () => {
    const w = wine(); // ai-sourced with a description
    const body = parse(await tool('set_wine_profile').handler(
      { wine_id: oid('f'), description: null }, SOMM_CTX));
    expect(body.error).toBeUndefined();
    expect(w.aiProfile.description).toBeNull();
    expect(w.aiProfile.source).toBe('ai');
    expect(body.summary).toMatch(/still eligible/);
    expect(body.data.note).toMatch(/may regenerate/);
    // Still undoable — the ledger row exists even for a clear.
    expect(McpActionLog.create.mock.calls[0][0].action).toBe('somm_wine_profile');
  });

  test('undo restores the values AND the provenance, and CLAIMS the ledger row', async () => {
    // The claim is the point: without it undo_last keeps selecting the same
    // edit forever and a concurrent twin can restore the snapshot twice.
    const row = {
      _id: 'sw', action: 'somm_wine_profile', reversed: false,
      detail: { wineId: oid('f') },
      prev: { description: 'Built for immediate drinking.', source: 'ai', verifiedBy: null, verifiedAt: null, profileReviewedAt: null },
    };
    McpActionLog.findOne.mockReturnValue(chain(row));
    McpActionLog.findOneAndUpdate.mockResolvedValue(row);
    const w = wine({ aiProfile: { description: 'Corrected.', source: 'curator' } });
    const res = await tool('undo_last').handler({}, { ...SOMM_CTX, scopes: ['consume', 'write'] });
    expect(parse(res).data.undone).toBe('set_wine_profile');
    expect(w.aiProfile.source).toBe('ai');
    expect(w.aiProfile.description).toBe('Built for immediate drinking.');
    expect(McpActionLog.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'sw', reversed: false }, { $set: { reversed: true, idempotencyKey: null } });
  });

  test('a second undo of the same row is refused once it is claimed', async () => {
    const row = { _id: 'sw', action: 'somm_wine_profile', reversed: false, detail: { wineId: oid('f') }, prev: {} };
    McpActionLog.findOne.mockReturnValue(chain(row));
    McpActionLog.findOneAndUpdate.mockResolvedValue(null); // already claimed
    const w = wine();
    const res = await tool('undo_last').handler({}, { ...SOMM_CTX, scopes: ['consume', 'write'] });
    expect(parse(res).error.code).toBe('conflict');
    expect(w.save).not.toHaveBeenCalled();
  });
});

describe('set_vintage_price', () => {
  test('rejects unsupported currency; creates an append-only snapshot with setBy; ledger keeps entryId', async () => {
    let res = await tool('set_vintage_price').handler({ wine_id: oid('f'), vintage: '2019', price: 100, currency: 'XXX' }, SOMM_CTX);
    expect(parse(res).error.message).toMatch(/Unsupported currency/);

    WineDefinition.findById.mockReturnValue(chain({ _id: oid('f'), name: 'Barolo' }));
    const PriceTrackingRequest = require('../models/PriceTrackingRequest');
    PriceTrackingRequest.findOne.mockReturnValue(chain(null));
    res = await tool('set_vintage_price').handler({ wine_id: oid('f'), vintage: '2019', price: 100, currency: 'sek' }, SOMM_CTX);
    const body = parse(res);
    expect(body.error).toBeUndefined();
    expect(body.data.currency).toBe('SEK');
    const created = WineVintagePrice.mock.calls[0][0];
    expect(created).toMatchObject({ vintage: '2019', price: 100, currency: 'SEK', setBy: ME });
    const row = McpActionLog.create.mock.calls[0][0];
    expect(row.action).toBe('somm_price');
    expect(row.detail.entryId).toBe('price-1');
    expect(logAudit).toHaveBeenCalledWith(SOMM_CTX.req, 'somm.price.add', expect.anything(), expect.objectContaining({ via: 'mcp' }));
    // Requesters (none here) would be notified with the somm-prices link.
    const { createNotification } = require('../services/notifications');
    expect(createNotification).not.toHaveBeenCalled(); // no requesters on this pair
  });
});

describe('list_price_tracking_requests', () => {
  test('declined pairs (PriceTrackingSkip) no longer appear in the queue', async () => {
    const PriceTrackingRequest = require('../models/PriceTrackingRequest');
    const PriceTrackingSkip = require('../models/PriceTrackingSkip');
    PriceTrackingRequest.find.mockReturnValue(chain([
      { _id: oid('1'), wineDefinition: { _id: oid('e'), name: 'Kept', producer: 'A' }, vintage: '2019', requesters: [{ user: oid('b') }] },
      { _id: oid('2'), wineDefinition: { _id: oid('f'), name: 'Declined', producer: 'B' }, vintage: '2016', requesters: [{ user: oid('b') }] },
    ]));
    PriceTrackingSkip.find.mockReturnValue(chain([{ wineDefinition: oid('f'), vintage: '2016' }]));
    const body = parse(await tool('list_price_tracking_requests').handler({}, SOMM_CTX));
    expect(body.error).toBeUndefined();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].wine.name).toBe('Kept');
    expect(body.summary).toMatch(/1 actionable/);
  });

  test('a skip on the SAME wine but a DIFFERENT vintage does not hide the pair', async () => {
    const PriceTrackingRequest = require('../models/PriceTrackingRequest');
    const PriceTrackingSkip = require('../models/PriceTrackingSkip');
    PriceTrackingRequest.find.mockReturnValue(chain([
      { _id: oid('1'), wineDefinition: { _id: oid('f'), name: 'Barolo', producer: 'P' }, vintage: '2019', requesters: [] },
    ]));
    PriceTrackingSkip.find.mockReturnValue(chain([{ wineDefinition: oid('f'), vintage: '2016' }]));
    const body = parse(await tool('list_price_tracking_requests').handler({}, SOMM_CTX));
    expect(body.data).toHaveLength(1);
  });
});

describe('sample_published_profiles (6a8464ea phase 3 — the weekly spot-check)', () => {
  test('samples only published, AI-sourced, un-held rows and returns judgeable shapes', async () => {
    WineDefinition.aggregate.mockResolvedValue([{
      _id: oid('9'), name: 'Bacchus Trocken', producer: 'Weingut X', appellation: 'Rheinhessen',
      type: 'white', grapes: [{ name: 'Bacchus' }],
      aiProfile: { body: 'light', tannin: null, acidity: 'high', sweetness: 'dry', flavors: ['pear'], description: 'Crisp and bright.', confidence: 0.6, producerUnknown: true },
    }]);
    WineDefinition.populate.mockResolvedValue(undefined);
    const body = parse(await tool('sample_published_profiles').handler({ count: 20 }, SOMM_CTX));
    expect(body.error).toBeUndefined();
    // The sample never draws curator or held rows — those are not spot-check material.
    const match = WineDefinition.aggregate.mock.calls[0][0][0].$match;
    expect(match['aiProfile.heldAt']).toBeNull();
    expect(match['aiProfile.source']).toEqual({ $ne: 'curator' });
    expect(WineDefinition.aggregate.mock.calls[0][0][1]).toEqual({ $sample: { size: 20 } });
    expect(body.data[0]).toMatchObject({ producer: 'Weingut X', grapes: ['Bacchus'], producer_unknown: true });
    expect(body.data[0].profile.acidity).toBe('high');
  });
});

describe('gap-report items 2/3/5/6 (2026-08-18 evening)', () => {
  const WineCorrectionProposal = require('../models/WineCorrectionProposal');
  const ProfileAuditSample = require('../models/ProfileAuditSample');

  test('core worklist inlines the profile for ai_published rows and pages with offset', async () => {
    Bottle.aggregate.mockResolvedValue([
      { _id: oid('1'), ownerCount: 6 }, { _id: oid('2'), ownerCount: 5 }, { _id: oid('3'), ownerCount: 4 },
    ]);
    WineDefinition.find.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      populate: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([
        { _id: oid('1'), name: 'A', producer: 'P', region: { name: 'Hunter Valley' }, aiProfile: { description: 'x', body: 'light', acidity: 'high', flavors: ['pear'], foodPairings: [] } },
        { _id: oid('2'), name: 'B', producer: 'P', aiProfile: { heldAt: new Date(), heldReason: 'low_confidence' } },
        { _id: oid('3'), name: 'C', producer: 'P', aiProfile: { description: 'y' } },
      ]),
    });
    let body = parse(await tool('list_unverified_core_wines').handler({ min_owners: 3, limit: 30, offset: 0 }, SOMM_CTX));
    expect(body.data[0].profile).toMatchObject({ description: 'x', body: 'light', acidity: 'high' });
    expect(body.data[1].profile).toBeNull(); // held rows store no content by design

    body = parse(await tool('list_unverified_core_wines').handler({ min_owners: 3, limit: 30, offset: 2 }, SOMM_CTX));
    expect(body.data.map((r) => String(r.wine_id))).toEqual([oid('3')]);
  });

  test('list_pending_corrections filters and maps decided fields only when decided', async () => {
    const chain = {
      sort: jest.fn().mockReturnThis(), skip: jest.fn().mockReturnThis(), limit: jest.fn().mockReturnThis(),
      populate: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([{
        _id: oid('9'), wineDefinition: { _id: oid('1'), name: 'Crianza', producer: 'Finca X' },
        kind: 'merge', status: 'pending', mergeTargetId: { _id: oid('2'), name: 'Crianza', producer: 'Finca X SA' },
        reason: 'same wine, producer suffix split', createdAt: new Date('2026-08-18'),
      }]),
    };
    WineCorrectionProposal.find.mockReturnValue(chain);
    WineCorrectionProposal.countDocuments.mockResolvedValue(1);
    const body = parse(await tool('list_pending_corrections').handler({ kind: 'merge', status: 'pending', limit: 30, offset: 0 }, SOMM_CTX));
    expect(body.error).toBeUndefined();
    expect(WineCorrectionProposal.find).toHaveBeenCalledWith({ status: 'pending', kind: 'merge' });
    expect(body.data[0]).toMatchObject({ kind: 'merge', wine: 'Finca X — Crianza' });
    expect(body.data[0].merge_target.wine).toBe('Finca X SA — Crianza');
    expect(body.data[0].decided_at).toBeUndefined(); // pending rows carry no decision fields
  });

  test('record_profile_audit validates corrections <= sample_size, persists, returns the running rate', async () => {
    let body = parse(await tool('record_profile_audit').handler({ sample_size: 20, corrections: 21 }, SOMM_CTX));
    expect(body.error.code).toBe('invalid_input');
    expect(ProfileAuditSample.create).not.toHaveBeenCalled();

    ProfileAuditSample.create.mockResolvedValue({ sampleSize: 20, corrections: 3, recordedAt: new Date('2026-08-18') });
    ProfileAuditSample.find.mockReturnValue({
      sort: jest.fn().mockReturnThis(), limit: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([
        { recordedAt: new Date('2026-08-18'), sampleSize: 20, corrections: 3 },
        { recordedAt: new Date('2026-08-11'), sampleSize: 20, corrections: 5 },
      ]),
    });
    body = parse(await tool('record_profile_audit').handler({ sample_size: 20, corrections: 3 }, SOMM_CTX));
    expect(body.error).toBeUndefined();
    expect(ProfileAuditSample.create).toHaveBeenCalledWith(expect.objectContaining({ sampleSize: 20, corrections: 3, recordedBy: ME }));
    expect(body.data.running_rate_pct).toBe(20); // 8 of 40
    expect(body.data.history).toHaveLength(2);
  });
});

describe('held-profile review queue over MCP (somm ticket 2026-08-18)', () => {
  const { releaseHeldProfile } = require('../services/enrichmentJob');
  const heldWine = (over = {}) => ({
    _id: oid('7'), name: 'Crianza', producer: 'Finca X',
    aiProfile: { heldAt: new Date('2026-08-18'), heldReason: 'low_confidence', producerSuspect: false, description: null, generatedAt: new Date('2026-08-17'), source: 'ai' },
    ...over,
  });
  const selectChain = (doc) => ({ select: jest.fn().mockResolvedValue(doc) });

  const heldListChain = (rows) => {
    const chain = {
      select: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      populate: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue(rows),
    };
    return chain;
  };

  test('list returns held + published_suspect rows impact-first, outstanding-filtered, with the legacy reason filter', async () => {
    WineDefinition.find.mockImplementation(() => heldListChain([
      { _id: oid('1'), name: 'A', producer: 'P1', grapes: [{ name: 'Shiraz' }], country: { name: 'Australia' }, aiProfile: { heldAt: new Date(), heldReason: 'low_confidence', confidence: 0.2, generatedAt: new Date() } },
      { _id: oid('2'), name: 'B', producer: 'P2', aiProfile: { heldAt: new Date(), heldReason: null, confidence: 0.5, generatedAt: new Date() } },
      { _id: oid('3'), name: 'C', producer: 'P3', aiProfile: { heldAt: null, producerSuspect: true, description: 'x', confidence: 0.5, generatedAt: new Date() } },
    ]));
    Bottle.aggregate.mockResolvedValue([{ _id: oid('3'), ownerCount: 4 }, { _id: oid('1'), ownerCount: 1 }]);

    let body = parse(await tool('list_held_profiles').handler({ include_published_suspects: true, limit: 30, offset: 0 }, SOMM_CTX));
    expect(body.error).toBeUndefined();
    // Impact-first: the 4-owner suspect row leads; states are labelled.
    expect(body.data[0]).toMatchObject({ state: 'published_suspect', owner_count: 4 });
    expect(body.data.map((r) => r.state).sort()).toEqual(['held', 'held', 'published_suspect']);
    // Registry facts ride inline (gap report 4) — never generated content.
    expect(body.data.find((r) => String(r.wine_id) === oid('1'))).toMatchObject({ grapes: ['Shiraz'], country: 'Australia' });
    // The query never lists decided rows — the outstanding comparison is in the filter.
    const filter = WineDefinition.find.mock.calls[0][0];
    expect(JSON.stringify(filter.$expr)).toMatch(/profileReviewedAt/);

    // held_reason "legacy" keeps only the reason-less held row (suspects untouched).
    body = parse(await tool('list_held_profiles').handler({ held_reason: 'legacy', include_published_suspects: true, limit: 30, offset: 0 }, SOMM_CTX));
    expect(body.data.filter((r) => r.state === 'held').map((r) => r.wine_id)).toEqual([oid('2')]);
  });

  // Somm 6a872b98: a held profile was released over the top of an open
  // inquiry asking the owner whether that very label reads Hunter Valley or
  // Lodi. The flag makes the escalation visible where the decision is made.
  test('a row with an open owner inquiry carries open_owner_inquiry; others do not', async () => {
    const WineOwnerInquiry = require('../models/WineOwnerInquiry');
    WineDefinition.find.mockImplementation(() => heldListChain([
      { _id: oid('1'), name: 'A', producer: 'P1', aiProfile: { heldAt: new Date(), heldReason: 'producer_suspect', confidence: 0.3, generatedAt: new Date() } },
      { _id: oid('2'), name: 'B', producer: 'P2', aiProfile: { heldAt: new Date(), heldReason: 'low_confidence', confidence: 0.3, generatedAt: new Date() } },
    ]));
    Bottle.aggregate.mockResolvedValue([]);
    WineOwnerInquiry.find.mockImplementation(() => ({
      select: () => ({
        lean: () => Promise.resolve([
          { _id: oid('9'), wineDefinition: oid('1'), question: 'What does the label say the region is?', createdAt: new Date('2026-08-18'), expiresAt: new Date('2026-10-17') },
        ]),
      }),
    }));

    const body = parse(await tool('list_held_profiles').handler({ limit: 30, offset: 0 }, SOMM_CTX));
    const flagged = body.data.find((r) => String(r.wine_id) === oid('1'));
    const clean = body.data.find((r) => String(r.wine_id) === oid('2'));
    expect(flagged.open_owner_inquiry).toMatchObject({ inquiry_id: oid('9'), question: expect.stringMatching(/label/) });
    // Absent, not null — the field only appears when there is something to see.
    expect(clean).not.toHaveProperty('open_owner_inquiry');
  });

  test('producer filter reaches the query; group_by returns clusters; counts_only returns uncapped totals (gap report 2/5a)', async () => {
    WineDefinition.find.mockImplementation(() => heldListChain([
      { _id: oid('1'), producer: 'Thomas Allen', aiProfile: { heldAt: new Date(), heldReason: 'low_confidence' } },
      { _id: oid('2'), producer: 'Thomas Allen', aiProfile: { heldAt: new Date(), heldReason: null } },
      { _id: oid('3'), producer: 'Zeroine', aiProfile: { heldAt: null, producerSuspect: true, description: 'x' } },
    ]));
    Bottle.aggregate.mockResolvedValue([{ _id: oid('1'), ownerCount: 2 }]);

    let body = parse(await tool('list_held_profiles').handler({ producer: 'thomas', include_published_suspects: true, group_by: 'producer', limit: 30, offset: 0 }, SOMM_CTX));
    expect(body.error).toBeUndefined();
    expect(WineDefinition.find.mock.calls[0][0].producer).toEqual({ $regex: 'thomas', $options: 'i' });
    const ta = body.data.find((g) => g.producer === 'Thomas Allen');
    expect(ta).toMatchObject({ row_count: 2, max_owner_count: 2 });
    expect(ta.reasons).toMatchObject({ low_confidence: 1, legacy: 1 });

    body = parse(await tool('list_held_profiles').handler({ include_published_suspects: true, counts_only: true, limit: 30, offset: 0 }, SOMM_CTX));
    expect(body.data).toMatchObject({ total: 3, held: 2, published_suspect: 1 });
    expect(body.data.held_by_reason).toMatchObject({ low_confidence: 1, legacy: 1 });
    expect(body.data.by_owner_tier).toMatchObject({ 0: 2, 2: 1 });
  });

  test('counts_only counts published_suspect WITHOUT the include flag (ticket 6a8ffaa1)', async () => {
    // The listing default exists to keep suspects out of held-row paging; a
    // count has no paging to protect. The regression reported suspect as a
    // hard 0 — "adjudicated clear" — while three quarters of the backlog sat
    // in the uncounted state. Assert on the QUERY, not just the totals: the
    // suspect $or branch must be present with no include flag passed.
    WineDefinition.find.mockImplementation(() => heldListChain([
      { _id: oid('1'), producer: 'Thomas Allen', aiProfile: { heldAt: new Date(), heldReason: 'low_confidence' } },
      { _id: oid('3'), producer: 'Zeroine', aiProfile: { heldAt: null, producerSuspect: true, description: 'x' } },
    ]));
    Bottle.aggregate.mockResolvedValue([]);

    const body = parse(await tool('list_held_profiles').handler({ counts_only: true, limit: 30, offset: 0 }, SOMM_CTX));
    expect(body.error).toBeUndefined();
    const or = WineDefinition.find.mock.calls[0][0].$or;
    expect(or.some((b) => b['aiProfile.producerSuspect'] === true)).toBe(true);
    expect(body.data).toMatchObject({ total: 2, held: 1, published_suspect: 1 });
  });

  test('batch confirm decides per-row; batch release and misplaced context are refused (gap report 3 / enh 1)', async () => {
    WineDefinition.findById.mockImplementation(() => selectChain(heldWine()));
    let body = parse(await tool('review_held_profile').handler({ wine_ids: [oid('7'), oid('8')], decision: 'confirm', limit: undefined }, SOMM_CTX));
    expect(body.error).toBeUndefined();
    expect(body.data).toHaveLength(2);
    expect(body.data.every((r) => r.decision === 'confirm')).toBe(true);
    expect(WineDefinition.updateOne).toHaveBeenCalledTimes(2);

    body = parse(await tool('review_held_profile').handler({ wine_ids: [oid('7')], decision: 'release' }, SOMM_CTX));
    expect(body.error.code).toBe('invalid_input');

    body = parse(await tool('review_held_profile').handler({ wine_id: oid('7'), decision: 'confirm', context: 'facts' }, SOMM_CTX));
    expect(body.error.code).toBe('invalid_input');
  });

  test('release forwards curator context into the regeneration (enh 1)', async () => {
    WineDefinition.findById.mockReturnValue(selectChain(heldWine()));
    releaseHeldProfile.mockResolvedValueOnce(true);
    const body = parse(await tool('review_held_profile').handler(
      { wine_id: oid('7'), decision: 'release', context: 'Hunter Valley; dry-farmed vines planted 1969' }, SOMM_CTX));
    expect(body.error).toBeUndefined();
    expect(releaseHeldProfile).toHaveBeenCalledWith(expect.anything(), { context: 'Hunter Valley; dry-farmed vines planted 1969' });
  });

  test('list_profile_audits reads the trend without writing a row (gap report 5b)', async () => {
    const ProfileAuditSample = require('../models/ProfileAuditSample');
    ProfileAuditSample.find.mockReturnValue({
      sort: jest.fn().mockReturnThis(), limit: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([
        { recordedAt: new Date('2026-08-18'), sampleSize: 20, corrections: 2 },
        { recordedAt: new Date('2026-08-11'), sampleSize: 20, corrections: 6 },
      ]),
    });
    const body = parse(await tool('list_profile_audits').handler({ limit: 12 }, SOMM_CTX));
    expect(body.error).toBeUndefined();
    expect(ProfileAuditSample.create).not.toHaveBeenCalled();
    expect(body.data.running_rate_pct).toBe(20);
    expect(body.data.history).toHaveLength(2);
  });

  test('release awaits the shared helper — success reports published, failure leaves the row queued', async () => {
    WineDefinition.findById.mockReturnValue(selectChain(heldWine()));
    releaseHeldProfile.mockResolvedValueOnce(true);
    let body = parse(await tool('review_held_profile').handler({ wine_id: oid('7'), decision: 'release' }, SOMM_CTX));
    expect(body.error).toBeUndefined();
    expect(body.data.published).toBe(true);
    // Same audit action string as the REST twin.
    expect(logAudit).toHaveBeenCalledWith(SOMM_CTX.req, 'admin.wine.profileReviewed',
      expect.anything(), expect.objectContaining({ decision: 'release', via: 'mcp' }));

    releaseHeldProfile.mockResolvedValueOnce(false);
    WineDefinition.findById.mockReturnValue(selectChain(heldWine()));
    body = parse(await tool('review_held_profile').handler({ wine_id: oid('7'), decision: 'release' }, SOMM_CTX));
    expect(body.error.code).toBe('unavailable');
  });

  test('confirm STAMPS profileReviewedAt — the rule the 57 unstamped rows exist to teach', async () => {
    WineDefinition.findById.mockReturnValue(selectChain(heldWine()));
    const body = parse(await tool('review_held_profile').handler({ wine_id: oid('7'), decision: 'confirm' }, SOMM_CTX));
    expect(body.error).toBeUndefined();
    const [, update] = WineDefinition.updateOne.mock.calls[0];
    expect(update.$set.profileReviewedAt).toBeInstanceOf(Date);
  });

  // Somm ticket 6a85f5e8: profileReviewedAt was doing two jobs. A curator
  // profile write stamps it, so fixing a wine's grapes silently closed the
  // producer-suspect question nobody had answered — 23 prod rows left that way
  // against ONE genuine uphold, and upheld-count is the number the scaling
  // review reads. The verdict now lives in its own field.
  describe('the suspect verdict is recorded separately from "a human looked"', () => {
    const publishedSuspect = (over = {}) => heldWine({
      aiProfile: { heldAt: null, producerSuspect: true, description: 'x', generatedAt: new Date(), source: 'ai', ...over },
    });

    test('uphold records suspectDecision, not just the reviewed stamp', async () => {
      WineDefinition.findById.mockReturnValue(selectChain(publishedSuspect()));
      const body = parse(await tool('review_held_profile').handler({ wine_id: oid('7'), decision: 'uphold' }, SOMM_CTX));
      expect(body.error).toBeUndefined();
      const [, update] = WineDefinition.updateOne.mock.calls[0];
      expect(update.$set['aiProfile.suspectDecision']).toBe('upheld');
      expect(update.$set['aiProfile.suspectDecidedAt']).toBeInstanceOf(Date);
      // Still stamped, because that field still means "a human looked" elsewhere.
      expect(update.$set.profileReviewedAt).toBeInstanceOf(Date);
      // And the flag survives — that is the whole point of uphold.
      expect(update.$set['aiProfile.producerSuspect']).toBeUndefined();
    });

    test('confirm on a published suspect records the opposite verdict and clears the flag', async () => {
      WineDefinition.findById.mockReturnValue(selectChain(publishedSuspect()));
      const body = parse(await tool('review_held_profile').handler({ wine_id: oid('7'), decision: 'confirm' }, SOMM_CTX));
      expect(body.error).toBeUndefined();
      const [, update] = WineDefinition.updateOne.mock.calls[0];
      expect(update.$set['aiProfile.producerSuspect']).toBe(false);
      expect(update.$set['aiProfile.suspectDecision']).toBe('confirmed');
    });

    // Somm ticket 6a882f3e. The note used to be kept "for curator context"
    // after the flag it explained was cleared — so a confirmed row could still
    // read "the true producing estate is unclear to me" with nothing left to
    // qualify it, and no lever existed to correct it.
    describe('the producerNote goes with the flag it explains', () => {
      test('confirm clears the note alongside producerSuspect', async () => {
        WineDefinition.findById.mockReturnValue(selectChain(publishedSuspect({
          producerNote: 'This appears to be a branded line rather than a wine made by Donnafugata.',
        })));
        const body = parse(await tool('review_held_profile').handler({ wine_id: oid('7'), decision: 'confirm' }, SOMM_CTX));
        const [, update] = WineDefinition.updateOne.mock.calls[0];
        expect(update.$set['aiProfile.producerNote']).toBeNull();
        // Told, not silent — the curator can no longer see it to check.
        expect(body.data.producer_note_cleared).toBe(true);
      });

      test('the cleared note survives in the audit, not just in the void', async () => {
        const note = 'Alessandro is not a producer I can identify';
        WineDefinition.findById.mockReturnValue(selectChain(publishedSuspect({ producerNote: note })));
        await tool('review_held_profile').handler({ wine_id: oid('7'), decision: 'confirm' }, SOMM_CTX);
        const detail = logAudit.mock.calls.at(-1)[3];
        expect(detail.clearedProducerNote).toBe(note);
      });

      test('confirm on an unknown-only row clears the note too', async () => {
        WineDefinition.findById.mockReturnValue(selectChain(publishedSuspect({
          producerSuspect: false, producerUnknown: true, producerNote: 'cannot place this producer',
        })));
        await tool('review_held_profile').handler({ wine_id: oid('7'), decision: 'confirm' }, SOMM_CTX);
        const [, update] = WineDefinition.updateOne.mock.calls[0];
        expect(update.$set['aiProfile.producerUnknown']).toBe(false);
        expect(update.$set['aiProfile.producerNote']).toBeNull();
      });

      test('UPHOLD keeps the note — the doubt stands, so its explanation must', async () => {
        WineDefinition.findById.mockReturnValue(selectChain(publishedSuspect({ producerNote: 'genuinely unidentifiable' })));
        const body = parse(await tool('review_held_profile').handler({ wine_id: oid('7'), decision: 'uphold' }, SOMM_CTX));
        const [, update] = WineDefinition.updateOne.mock.calls[0];
        expect(update.$set['aiProfile.producerNote']).toBeUndefined();
        expect(body.data.producer_note_cleared).toBeUndefined();
      });

      test('a HELD row keeps the note — confirm keeps it held, so the doubt is unresolved', async () => {
        // heldWine() spreads `over` at the TOP level, not into aiProfile, so
        // the note has to be placed explicitly or this test would assert
        // nothing about the field it is named for.
        const held = heldWine();
        held.aiProfile = { ...held.aiProfile, producerNote: 'unclear' };
        WineDefinition.findById.mockReturnValue(selectChain(held));
        await tool('review_held_profile').handler({ wine_id: oid('7'), decision: 'confirm' }, SOMM_CTX);
        const [, update] = WineDefinition.updateOne.mock.calls[0];
        expect(update.$set['aiProfile.producerNote']).toBeUndefined();
      });

      test('a row with no note is not reported as having cleared one', async () => {
        WineDefinition.findById.mockReturnValue(selectChain(publishedSuspect({ producerNote: null })));
        const body = parse(await tool('review_held_profile').handler({ wine_id: oid('7'), decision: 'confirm' }, SOMM_CTX));
        const [, update] = WineDefinition.updateOne.mock.calls[0];
        expect(update.$set['aiProfile.producerNote']).toBeUndefined();
        expect(body.data.producer_note_cleared).toBeUndefined();
        expect(logAudit.mock.calls.at(-1)[3].clearedProducerNote).toBeUndefined();
      });
    });

    test('a HELD row records no suspect verdict — different question, different queue', async () => {
      WineDefinition.findById.mockReturnValue(selectChain(heldWine()));
      await tool('review_held_profile').handler({ wine_id: oid('7'), decision: 'confirm' }, SOMM_CTX);
      const [, update] = WineDefinition.updateOne.mock.calls[0];
      expect(update.$set.profileReviewedAt).toBeInstanceOf(Date);
      expect(update.$set['aiProfile.suspectDecision']).toBeUndefined();
    });
  });

  test('reject clears the generation entirely (generatedAt null → out of every queue, re-enrichable); published rows refuse it', async () => {
    WineDefinition.findById.mockReturnValue(selectChain(heldWine()));
    let body = parse(await tool('review_held_profile').handler({ wine_id: oid('7'), decision: 'reject' }, SOMM_CTX));
    expect(body.error).toBeUndefined();
    const [, update] = WineDefinition.updateOne.mock.calls[0];
    expect(update.$set.aiProfile.generatedAt).toBeNull();
    expect(update.$set.aiProfile.heldAt).toBeNull();

    WineDefinition.findById.mockReturnValue(selectChain(heldWine({
      aiProfile: { heldAt: null, producerSuspect: true, description: 'x', generatedAt: new Date(), source: 'ai' },
    })));
    body = parse(await tool('review_held_profile').handler({ wine_id: oid('7'), decision: 'reject' }, SOMM_CTX));
    expect(body.error.code).toBe('invalid_input');
  });

  test('a wine with nothing held or flagged is refused', async () => {
    WineDefinition.findById.mockReturnValue(selectChain(heldWine({
      aiProfile: { heldAt: null, producerSuspect: false, description: 'x', generatedAt: new Date(), source: 'ai' },
    })));
    const body = parse(await tool('review_held_profile').handler({ wine_id: oid('7'), decision: 'confirm' }, SOMM_CTX));
    expect(body.error.code).toBe('invalid_input');
  });

  // Somm ticket 6a856e97: the verb that upholds a CORRECT flag. Confirm
  // clears the flag; uphold keeps it — both stamp reviewed, both clear the
  // queue, and only one of them damages the data when the flag is right.
  test('uphold on a published_suspect KEEPS the flag and stamps reviewed — flag survives, queue does not', async () => {
    WineDefinition.findById.mockReturnValue(selectChain(heldWine({
      aiProfile: { heldAt: null, producerSuspect: true, description: 'x', generatedAt: new Date(), source: 'ai' },
    })));
    const body = parse(await tool('review_held_profile').handler({ wine_id: oid('7'), decision: 'uphold' }, SOMM_CTX));
    expect(body.error).toBeUndefined();
    expect(body.data.suspect_kept).toBe(true);
    const [, update] = WineDefinition.updateOne.mock.calls[0];
    expect(update.$set.profileReviewedAt).toBeInstanceOf(Date);
    // The one assertion that IS the ticket: no field write touches the flag.
    expect(update.$set['aiProfile.producerSuspect']).toBeUndefined();
  });

  test('uphold on a HELD row is refused — confirm is the keep-it-held verb', async () => {
    WineDefinition.findById.mockReturnValue(selectChain(heldWine()));
    const body = parse(await tool('review_held_profile').handler({ wine_id: oid('7'), decision: 'uphold' }, SOMM_CTX));
    expect(body.error.code).toBe('invalid_input');
    expect(body.error.message).toMatch(/uphold_is_published_only/);
  });

  test('uphold batches like confirm/reject', async () => {
    WineDefinition.findById.mockReturnValue(selectChain(heldWine({
      aiProfile: { heldAt: null, producerSuspect: true, description: 'x', generatedAt: new Date(), source: 'ai' },
    })));
    const body = parse(await tool('review_held_profile').handler({ wine_ids: [oid('7'), oid('8')], decision: 'uphold' }, SOMM_CTX));
    expect(body.error).toBeUndefined();
    expect(body.summary).toMatch(/2\/2 decided/);
  });
});

// ---------------------------------------------------------------------------
// Somm-owned wine data (Johan, 2026-08-22): automatic AI enrichment is OFF,
// so a new wine arrives with NO profile at all. list_held_profiles is the one
// place the somm can see it — as state "unprofiled" — and add_grape is the
// unblock for the taxonomy gaps that previously needed a support ticket each
// (seven varieties in one week: Norton, St. Pepin, Souzão, Vidal, …).
// ---------------------------------------------------------------------------
describe('the unprofiled intake queue (somm-owned data, 2026-08-22)', () => {
  const heldListChain = (rows) => ({
    select: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    populate: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(rows),
  });
  const noInquiries = () => {
    const WineOwnerInquiry = require('../models/WineOwnerInquiry');
    WineOwnerInquiry.find.mockImplementation(() => ({ select: () => ({ lean: () => Promise.resolve([]) }) }));
  };

  test('the default query asks for all three states — held, suspect (flagged), unprofiled', async () => {
    WineDefinition.find.mockImplementation(() => heldListChain([]));
    noInquiries();
    Bottle.aggregate.mockResolvedValue([]);
    await tool('list_held_profiles').handler({ include_published_suspects: true, limit: 30, offset: 0 }, SOMM_CTX);
    const or = WineDefinition.find.mock.calls[0][0].$or;
    expect(or).toHaveLength(3);
    // The intake branch: never generated AND never written — the 188 curator
    // rows that predate the generatedAt stamp have a description and stay out.
    // body is part of the content test now (6a911643) — the Mongo branch must
    // match hasProfileContent field for field.
    expect(or[2]).toEqual({ 'aiProfile.generatedAt': null, 'aiProfile.description': null, 'aiProfile.body': null });
  });

  test('state:"unprofiled" narrows the query to the intake branch alone', async () => {
    WineDefinition.find.mockImplementation(() => heldListChain([]));
    noInquiries();
    Bottle.aggregate.mockResolvedValue([]);
    await tool('list_held_profiles').handler({ state: 'unprofiled', limit: 30, offset: 0 }, SOMM_CTX);
    const or = WineDefinition.find.mock.calls[0][0].$or;
    expect(or).toEqual([{ 'aiProfile.generatedAt': null, 'aiProfile.description': null, 'aiProfile.body': null }]);
  });

  test('an explicit state:"published_suspect" implies the include flag — no second switch to forget', async () => {
    WineDefinition.find.mockImplementation(() => heldListChain([]));
    noInquiries();
    Bottle.aggregate.mockResolvedValue([]);
    await tool('list_held_profiles').handler({ state: 'published_suspect', limit: 30, offset: 0 }, SOMM_CTX);
    const or = WineDefinition.find.mock.calls[0][0].$or;
    expect(or).toHaveLength(1);
    expect(or[0]).toMatchObject({ 'aiProfile.producerSuspect': true });
  });

  test('an unprofiled row is shaped with state "unprofiled" and sorts after flagged rows of equal impact', async () => {
    WineDefinition.find.mockImplementation(() => heldListChain([
      { _id: oid('1'), name: 'New Arrival', producer: 'Fresh Estate' }, // no aiProfile at all
      { _id: oid('2'), name: 'Doubted', producer: 'P2', aiProfile: { heldAt: new Date(), heldReason: 'low_confidence', confidence: 0.3, generatedAt: new Date() } },
    ]));
    noInquiries();
    Bottle.aggregate.mockResolvedValue([]);
    const body = parse(await tool('list_held_profiles').handler({ limit: 30, offset: 0 }, SOMM_CTX));
    const fresh = body.data.find((r) => String(r.wine_id) === oid('1'));
    expect(fresh).toMatchObject({ state: 'unprofiled', held_reason: null, ai_confidence: null });
    // Equal owner counts: the held 0.3-confidence row outranks the blank one
    // (confidence asc, null coalesces to 1) — doubt already measured beats
    // doubt not yet assessed.
    expect(body.data.map((r) => r.state)).toEqual(['held', 'unprofiled']);
  });

  test('counts_only sizes the three states separately', async () => {
    WineDefinition.find.mockImplementation(() => heldListChain([
      { _id: oid('1'), aiProfile: { heldAt: new Date(), heldReason: 'low_confidence', generatedAt: new Date() } },
      { _id: oid('2') },
      { _id: oid('3') },
    ]));
    Bottle.aggregate.mockResolvedValue([]);
    const body = parse(await tool('list_held_profiles').handler({ counts_only: true, limit: 30, offset: 0 }, SOMM_CTX));
    expect(body.data).toMatchObject({ total: 3, held: 1, published_suspect: 0, unprofiled: 2 });
    expect(body.summary).toMatch(/2 unprofiled/);
  });
});

// ---------------------------------------------------------------------------
// edit_grape (somm ticket 3504c122). add_grape only CREATED, so a variety that
// arrived with a null colour could never acquire one through MCP — and a null
// colour is not a cosmetic gap: findGrapeColourConflict cannot evaluate a wine
// whose grape has no colour, so those wines are skipped by a live check that
// then reports zero and reads as clean.
// ---------------------------------------------------------------------------
describe('edit_grape (2026-08-24)', () => {
  const Grape = require('../models/Grape');
  const Country = require('../models/Country');
  const Region = require('../models/Region');

  const grapeDoc = (over = {}) => ({
    _id: oid('e'), name: 'Tinta Cão', color: null, synonyms: [], regionalNames: [],
    origin: null, description: '', save: jest.fn().mockResolvedValue(true), ...over,
  });

  test('fills a null colour — the case the ticket is about', async () => {
    const doc = grapeDoc();
    Grape.findOne.mockResolvedValueOnce(doc);
    const body = parse(await tool('edit_grape').handler({ grape: 'Tinta Cão', colour: 'Red' }, SOMM_CTX));
    expect(body.error).toBeUndefined();
    expect(doc.color).toBe('Red');
    expect(doc.save).toHaveBeenCalled();
    expect(body.data.note).toMatch(/colour-conflict check/);
    expect(logAudit).toHaveBeenCalledWith(SOMM_CTX.req, 'somm.taxonomy.update',
      expect.objectContaining({ type: 'grape' }), expect.objectContaining({ applied: expect.arrayContaining(['colour Red']) }));
  });

  test('refuses to CHANGE an established colour — that re-judges every wine built on it', async () => {
    const doc = grapeDoc({ color: 'White' });
    Grape.findOne.mockResolvedValueOnce(doc);
    const body = parse(await tool('edit_grape').handler({ grape: 'Tinta Cão', colour: 'Red' }, SOMM_CTX));
    expect(body.error.code).toBe('conflict');
    expect(body.error.message).toMatch(/already White/);
    expect(doc.save).not.toHaveBeenCalled();
  });

  test('setting the SAME colour again is a no-op, not a conflict', async () => {
    const doc = grapeDoc({ color: 'Red' });
    Grape.findOne.mockResolvedValueOnce(doc);
    const body = parse(await tool('edit_grape').handler({ grape: 'Tinta Cão', colour: 'Red' }, SOMM_CTX));
    expect(body.error).toBeUndefined();
    expect(body.summary).toMatch(/Nothing to change/);
  });

  test('a synonym another variety already answers to is refused', async () => {
    const doc = grapeDoc();
    Grape.findOne
      .mockResolvedValueOnce(doc)
      // The claim probe CHAINS .select().lean(), so this call returns a
      // chainable, not a promise — mockReturnValueOnce, not mockResolvedValueOnce.
      .mockReturnValueOnce({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({ name: 'Syrah' }) }) });
    const body = parse(await tool('edit_grape').handler({ grape: 'Tinta Cão', add_synonyms: ['Shiraz'] }, SOMM_CTX));
    expect(body.error.code).toBe('conflict');
    expect(body.error.message).toMatch(/Syrah/);
  });

  test('a regional name needs a country — a label form is only true somewhere', async () => {
    Grape.findOne.mockResolvedValueOnce(grapeDoc());
    const body = parse(await tool('edit_grape').handler({ grape: 'Tinta Cão', regional_name: 'Durif' }, SOMM_CTX));
    expect(body.error.code).toBe('invalid_input');
    expect(body.error.message).toMatch(/needs a country/);
  });

  test('a region-scoped regional name resolves country AND region — the Carignan case', async () => {
    const doc = grapeDoc({ name: 'Carignan' });
    Grape.findOne.mockResolvedValueOnce(doc);
    Country.findOne.mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({ _id: oid('c'), name: 'Spain' }) }) });
    Region.findOne.mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({ _id: oid('r'), name: 'Rioja' }) }) });
    const body = parse(await tool('edit_grape').handler(
      { grape: 'Carignan', regional_name: 'Mazuelo', country: 'Spain', region: 'Rioja' }, SOMM_CTX));
    expect(body.error).toBeUndefined();
    expect(doc.regionalNames).toEqual([{ country: oid('c'), region: oid('r'), name: 'Mazuelo' }]);
  });

  test('an unknown variety is a not_found, pointing at add_grape', async () => {
    Grape.findOne.mockResolvedValueOnce(null);
    const body = parse(await tool('edit_grape').handler({ grape: 'Nonesuch', colour: 'Red' }, SOMM_CTX));
    expect(body.error.code).toBe('not_found');
    expect(body.error.message).toMatch(/add_grape/);
  });

  test('somm role required', async () => {
    const body = parse(await tool('edit_grape').handler({ grape: 'Tinta Cão', colour: 'Red' }, USER_CTX));
    expect(body.error).toBeDefined();
  });
});

describe('add_grape (somm-owned taxonomy, 2026-08-22)', () => {
  const Grape = require('../models/Grape');
  const probeReturns = (doc) => Grape.findOne.mockReturnValue({
    select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(doc) }),
  });

  test('adds a variety with folded synonyms, audited and ledgered', async () => {
    probeReturns(null);
    const body = parse(await tool('add_grape').handler({
      name: 'St. Pepin', colour: 'White', synonyms: ['St-Pepin', 'Saint Pepin'],
      origin: 'United States', description: 'Cold-hardy Swenson hybrid.',
    }, SOMM_CTX));
    expect(body.error).toBeUndefined();
    expect(body.summary).toMatch(/St\. Pepin/);
    const doc = Grape.mock.calls[0][0];
    expect(doc).toMatchObject({ name: 'St. Pepin', color: 'White', normalizedName: expect.any(String) });
    expect(doc.synonyms).toEqual(['St-Pepin', 'Saint Pepin']);
    // The collision probe covers the canonical name AND every synonym.
    const probe = Grape.findOne.mock.calls[0][0];
    expect(probe.$or[0].normalizedName.$in).toHaveLength(3);
    expect(logAudit).toHaveBeenCalledWith(SOMM_CTX.req, 'somm.taxonomy.create',
      expect.objectContaining({ type: 'grape' }), expect.objectContaining({ name: 'St. Pepin' }));
    expect(McpActionLog.create).toHaveBeenCalledWith(expect.objectContaining({ action: 'somm_grape' }));
  });

  test('an already-claimed name creates nothing and names the variety it resolves to', async () => {
    probeReturns({ name: 'Norton', synonyms: ['Cynthiana'] });
    const body = parse(await tool('add_grape').handler({ name: 'Cynthiana', colour: 'Red' }, SOMM_CTX));
    expect(body.error.code).toBe('conflict');
    expect(body.error.message).toMatch(/Norton/);
    expect(Grape).not.toHaveBeenCalled();
  });

  test('a synonym that repeats the canonical name is dropped, not double-claimed', async () => {
    probeReturns(null);
    const body = parse(await tool('add_grape').handler({ name: 'Vidal', colour: 'White', synonyms: ['VIDAL', 'Vidal Blanc'] }, SOMM_CTX));
    expect(body.error).toBeUndefined();
    expect(Grape.mock.calls[0][0].synonyms).toEqual(['Vidal Blanc']);
  });

  test('write scope + somm role are both required', async () => {
    const body = parse(await tool('add_grape').handler({ name: 'Norton', colour: 'Red' }, USER_CTX));
    expect(body.error).toBeDefined();
  });
});

describe('list_unverified_core_wines (curated core — rethink decision 3)', () => {
  test('owner-count sets join against non-curator wines, highest ownership first; verified wines drop out', async () => {
    Bottle.aggregate.mockResolvedValue([
      { _id: oid('1'), ownerCount: 7 },
      { _id: oid('2'), ownerCount: 4 },  // curator-verified → not returned by the wine query
      { _id: oid('3'), ownerCount: 3 },
    ]);
    WineDefinition.find.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      populate: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([
        { _id: oid('1'), name: 'Barolo', producer: 'Vajra', appellation: 'Barolo', type: 'red', aiProfile: { description: 'x', heldAt: null, confidence: 0.6 } },
        { _id: oid('3'), name: 'Rioja', producer: 'X', appellation: 'Rioja', type: 'red', aiProfile: { description: null, heldAt: new Date(), heldReason: 'low_confidence' } },
      ]),
    });
    const body = parse(await tool('list_unverified_core_wines').handler({ min_owners: 3, limit: 30 }, SOMM_CTX));
    expect(body.error).toBeUndefined();
    expect(body.data.map((r) => r.owner_count)).toEqual([7, 3]);
    expect(body.data[0].profile_state).toBe('ai_published');
    expect(body.data[1]).toMatchObject({ profile_state: 'held', held_reason: 'low_confidence' });
    // The wine filter excludes curator-verified rows — the core is DONE there.
    const filter = WineDefinition.find.mock.calls[0][0];
    expect(filter['aiProfile.source']).toEqual({ $ne: 'curator' });
    // Ownership threshold reached the aggregate.
    const match = Bottle.aggregate.mock.calls[0][0].find((s) => s.$match && s.$match.ownerCount);
    expect(match.$match.ownerCount).toEqual({ $gte: 3 });
  });
});

describe('reject_price_request', () => {
  const PriceTrackingRequest = require('../models/PriceTrackingRequest');
  const PriceTrackingSkip = require('../models/PriceTrackingSkip');
  const { createNotification } = require('../services/notifications');

  const REQ_ID = oid('9');
  const WINE_ID = oid('f');
  const mkRequest = (over = {}) => ({
    _id: REQ_ID,
    wineDefinition: WINE_ID,
    vintage: '2019',
    requesters: [
      { user: oid('b'), requestedAt: new Date('2026-07-01'), note: 'please track' },
      { user: oid('c'), requestedAt: new Date('2026-07-02') },
    ],
    firstRequestedAt: new Date('2026-07-01'),
    lastRequestedAt: new Date('2026-07-02'),
    ...over,
  });

  beforeEach(() => {
    WineDefinition.findById.mockReturnValue(chain({ _id: WINE_ID, name: 'Everyday Shiraz', producer: 'Casella' }));
    PriceTrackingSkip.findOneAndUpdate.mockResolvedValue({ lastErrorObject: { updatedExisting: false }, value: null });
    PriceTrackingRequest.deleteOne.mockResolvedValue({ deletedCount: 1 });
  });

  test('requires a real plain-text reason — missing, too-short, and HTML-only all refused before any read', async () => {
    for (const reason of [undefined, 'no', '<b><i></i></b>', '<p>hey</p>']) {
      const res = await tool('reject_price_request').handler({ request_id: REQ_ID, reason }, SOMM_CTX);
      expect(parse(res).error.code).toBe('invalid_input');
    }
    expect(PriceTrackingRequest.findById).not.toHaveBeenCalled();
    expect(PriceTrackingSkip.findOneAndUpdate).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
  });

  test('declines: skip upserted with the stripped reason, request deleted, requesters notified verbatim, undoable ledger row', async () => {
    PriceTrackingRequest.findById.mockReturnValue(chain(mkRequest()));
    const body = parse(await tool('reject_price_request').handler(
      { request_id: REQ_ID, reason: '  <b>No secondary market</b> for this wine.  ' }, SOMM_CTX));
    expect(body.error).toBeUndefined();
    expect(body.data.suppressed).toBe(true);
    expect(body.data.requesters_notified).toBe(2);
    expect(body.data.reason).toBe('No secondary market for this wine.');

    // Suppression: the skip is upserted on the pair with the sanitized reason.
    const [skipFilter, skipUpdate] = PriceTrackingSkip.findOneAndUpdate.mock.calls[0];
    expect(skipFilter).toEqual({ wineDefinition: WINE_ID, vintage: '2019' });
    expect(skipUpdate.$setOnInsert).toMatchObject({ reason: 'No secondary market for this wine.', skippedBy: ME });

    expect(PriceTrackingRequest.deleteOne).toHaveBeenCalledWith({ _id: REQ_ID });

    // Every requester gets the wine label AND the reason, verbatim.
    expect(createNotification).toHaveBeenCalledTimes(2);
    expect(createNotification.mock.calls[0][1]).toBe('price_tracking_declined');
    expect(createNotification.mock.calls[0][3]).toMatch(/Casella — Everyday Shiraz 2019/);
    expect(createNotification.mock.calls[0][3]).toMatch(/Reason: No secondary market for this wine\./);

    // Same audit action string as the REST decline route.
    expect(logAudit).toHaveBeenCalledWith(SOMM_CTX.req, 'somm.price.decline',
      expect.anything(), expect.objectContaining({ reason: 'No secondary market for this wine.', via: 'mcp' }));

    const row = McpActionLog.create.mock.calls[0][0];
    expect(row.action).toBe('somm_price_decline');
    expect(row.tool).toBe('reject_price_request');
    // The request being deleted, prev is ALL the undo has to work from.
    expect(row.prev).toMatchObject({ wineDefinition: WINE_ID, vintage: '2019', skipCreated: true });
    expect(row.prev.requesters).toHaveLength(2);
    expect(row.prev.requesters[0]).toMatchObject({ user: oid('b'), note: 'please track' });
  });

  test('a pre-existing skip is kept as-is and prev.skipCreated records it (undo must not lift it)', async () => {
    PriceTrackingRequest.findById.mockReturnValue(chain(mkRequest()));
    PriceTrackingSkip.findOneAndUpdate.mockResolvedValue({ lastErrorObject: { updatedExisting: true }, value: { _id: 'sk1' } });
    const body = parse(await tool('reject_price_request').handler(
      { request_id: REQ_ID, reason: 'No secondary market.' }, SOMM_CTX));
    expect(body.error).toBeUndefined();
    expect(McpActionLog.create.mock.calls[0][0].prev.skipCreated).toBe(false);
  });

  test('double-decline: the second call is a clean not_found (request already gone), nothing mutated or re-notified', async () => {
    PriceTrackingRequest.findById.mockReturnValue(chain(null));
    const body = parse(await tool('reject_price_request').handler(
      { request_id: REQ_ID, reason: 'No secondary market.' }, SOMM_CTX));
    expect(body.error.code).toBe('not_found');
    expect(PriceTrackingSkip.findOneAndUpdate).not.toHaveBeenCalled();
    expect(PriceTrackingRequest.deleteOne).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
    expect(McpActionLog.create).not.toHaveBeenCalled();
  });

  test('undo restores the request (upsert) and lifts ONLY the suppression this decline created; role re-checked', async () => {
    const prev = {
      wineDefinition: WINE_ID, vintage: '2019',
      requesters: [{ user: oid('b'), requestedAt: '2026-07-01T00:00:00.000Z', note: 'please track' }],
      firstRequestedAt: '2026-07-01T00:00:00.000Z', lastRequestedAt: '2026-07-02T00:00:00.000Z',
      skipCreated: true,
    };
    const row = { _id: 'pd', action: 'somm_price_decline', reversed: false, detail: { requestId: REQ_ID, vintage: '2019' }, prev };
    McpActionLog.findOne.mockReturnValue(chain(row));

    // Role-less caller refused before any claim:
    let res = await tool('undo_last').handler({}, { ...USER_CTX, scopes: ['consume', 'write'] });
    expect(parse(res).error.code).toBe('forbidden_scope');
    expect(McpActionLog.findOneAndUpdate).not.toHaveBeenCalled();

    McpActionLog.findOneAndUpdate.mockResolvedValue(row);
    PriceTrackingRequest.findOneAndUpdate.mockResolvedValue({});
    PriceTrackingSkip.deleteOne.mockResolvedValue({ deletedCount: 1 });
    res = await tool('undo_last').handler({}, { ...SOMM_CTX, scopes: ['consume', 'write'] });
    expect(parse(res).data.undone).toBe('reject_price_request');
    // Upsert, not insert: a re-request may already have brought the pair back.
    expect(PriceTrackingRequest.findOneAndUpdate).toHaveBeenCalledWith(
      { wineDefinition: WINE_ID, vintage: '2019' },
      { $setOnInsert: expect.objectContaining({ requesters: prev.requesters }) },
      { upsert: true }
    );
    // The lift is scoped to the caller's own skip, like the somm_price delete.
    expect(PriceTrackingSkip.deleteOne).toHaveBeenCalledWith({ wineDefinition: WINE_ID, vintage: '2019', skippedBy: ME });
    expect(McpActionLog.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'pd', reversed: false }, { $set: { reversed: true, idempotencyKey: null } });
  });

  test('undo leaves a skip that pre-existed the decline in place (skipCreated false)', async () => {
    const row = {
      _id: 'pd2', action: 'somm_price_decline', reversed: false, detail: { requestId: REQ_ID, vintage: '2019' },
      prev: { wineDefinition: WINE_ID, vintage: '2019', requesters: [], skipCreated: false },
    };
    McpActionLog.findOne.mockReturnValue(chain(row));
    McpActionLog.findOneAndUpdate.mockResolvedValue(row);
    PriceTrackingRequest.findOneAndUpdate.mockResolvedValue({});
    const res = await tool('undo_last').handler({}, { ...SOMM_CTX, scopes: ['consume', 'write'] });
    expect(parse(res).error).toBeUndefined();
    expect(PriceTrackingSkip.deleteOne).not.toHaveBeenCalled();
  });
});

describe('propose_wine_correction', () => {
  const WineCorrectionProposal = require('../models/WineCorrectionProposal');
  const WINE_ID = oid('f');
  const TARGET_ID = oid('e');
  const REASON = 'Producer verified on the estate website — the registry row misspells it.';

  const mkWine = (over = {}) => {
    const w = {
      _id: WINE_ID, name: 'Barolo', producer: 'Pira', appellation: 'Barolo',
      classification: 'DOCG',
      country: { name: 'Italy' }, region: { name: 'Piedmont' },
      ...over,
    };
    WineDefinition.findById.mockReturnValue(chain(w));
    return w;
  };

  // --- self-apply (2026-08-21) ---------------------------------------------
  // The tool's job here is ROUTING: ask the classifier, and either apply
  // through the admin route's own approveProposal or leave the row pending.
  describe('self-apply', () => {
    const { classifyProposal } = require('../services/proposalDirectApply');
    const { approveProposal } = require('../routes/admin/wineProposals');

    test('a blank-fill correction applies on filing and reports it as applied', async () => {
      mkWine({ appellation: null });
      WineCorrectionProposal.create.mockResolvedValue({ _id: 'prop-2' });
      classifyProposal.mockResolvedValueOnce({ direct: true, reason: 'blank, reversible' });
      approveProposal.mockResolvedValueOnce({ status: 200, body: { appliedNote: 'Applied: appellation, region' } });

      const body = parse(await tool('propose_wine_correction').handler({
        wine_id: WINE_ID, kind: 'field_correction',
        proposed_fields: { appellation: 'Barolo', region: 'Piedmont' },
        reason: REASON,
      }, SOMM_CTX));

      expect(body.data.status).toBe('approved');
      expect(body.data.applied_note).toBe('Applied: appellation, region');
      expect(body.summary).toMatch(/^Applied to/);
      // Applied through the ONE write path, with the proposal id — not a
      // second implementation that could drift from canonicalization.
      expect(approveProposal).toHaveBeenCalledWith('prop-2', expect.anything());
      // The row is still written first: review-after, not no-review.
      expect(WineCorrectionProposal.create).toHaveBeenCalled();
    });

    test('a failed apply reports PENDING — never a false success', async () => {
      // If the apply loses a race or 409s, the curator must not be told the
      // registry changed. The row stays pending and an admin picks it up.
      mkWine({ appellation: null });
      WineCorrectionProposal.create.mockResolvedValue({ _id: 'prop-3' });
      classifyProposal.mockResolvedValueOnce({ direct: true, reason: 'blank, reversible' });
      approveProposal.mockResolvedValueOnce({ status: 409, body: { error: 'already decided' } });

      const body = parse(await tool('propose_wine_correction').handler({
        wine_id: WINE_ID, kind: 'field_correction',
        proposed_fields: { appellation: 'Barolo' }, reason: REASON,
      }, SOMM_CTX));

      expect(body.data.status).toBe('pending');
      expect(body.data.applied_note).toBeUndefined();
    });

    test('a THROWN apply also reports pending rather than 500-ing the tool', async () => {
      mkWine({ appellation: null });
      WineCorrectionProposal.create.mockResolvedValue({ _id: 'prop-4' });
      classifyProposal.mockResolvedValueOnce({ direct: true, reason: 'blank, reversible' });
      approveProposal.mockRejectedValueOnce(new Error('mongo went away'));

      const body = parse(await tool('propose_wine_correction').handler({
        wine_id: WINE_ID, kind: 'field_correction',
        proposed_fields: { appellation: 'Barolo' }, reason: REASON,
      }, SOMM_CTX));

      expect(body.error).toBeUndefined();
      expect(body.data.status).toBe('pending');
    });

    test('a gated correction is never applied, and says why it is being reviewed', async () => {
      mkWine();
      WineCorrectionProposal.create.mockResolvedValue({ _id: 'prop-5' });
      classifyProposal.mockResolvedValueOnce({
        direct: false, reason: 'The wine\'s name states "Rosso Veronese" but the proposal says "Veneto IGT"',
      });

      const body = parse(await tool('propose_wine_correction').handler({
        wine_id: WINE_ID, kind: 'field_correction',
        proposed_fields: { appellation: 'Veneto IGT' }, reason: REASON,
      }, SOMM_CTX));

      expect(body.data.status).toBe('pending');
      expect(body.data.why_reviewed).toMatch(/Rosso Veronese/);
      expect(approveProposal).not.toHaveBeenCalled();
    });

    test('merges never reach the classifier at all', async () => {
      mkWine();
      WineDefinition.findById.mockReturnValueOnce(chain(mkWine()))
        .mockReturnValueOnce(chain({ _id: TARGET_ID, name: 'Barolo', producer: 'Pira' }));
      WineCorrectionProposal.create.mockResolvedValue({ _id: 'prop-6' });

      const body = parse(await tool('propose_wine_correction').handler({
        wine_id: WINE_ID, kind: 'merge', merge_target_id: TARGET_ID, reason: REASON,
      }, SOMM_CTX));

      expect(body.data.status).toBe('pending');
      expect(approveProposal).not.toHaveBeenCalled();
    });
  });

  test('files a field_correction: snapshot captured, ledger row + audit written, nothing applied', async () => {
    mkWine();
    WineCorrectionProposal.create.mockResolvedValue({ _id: 'prop-1' });
    const body = parse(await tool('propose_wine_correction').handler({
      wine_id: WINE_ID, kind: 'field_correction',
      proposed_fields: { producer: 'E. Pira e Figli' },
      evidence_url: 'https://pira-barolo.example/estate',
      reason: REASON,
    }, SOMM_CTX));
    expect(body.error).toBeUndefined();
    expect(body.data.status).toBe('pending');
    expect(body.data.proposal_id).toBe('prop-1');
    // The point of the tier: the tool itself never touches the wine.
    expect(body.data.note).toMatch(/until an admin/);

    const created = WineCorrectionProposal.create.mock.calls[0][0];
    expect(created).toMatchObject({
      proposer: ME, wineDefinition: WINE_ID, kind: 'field_correction',
      proposedFields: { producer: 'E. Pira e Figli' },
      evidenceUrl: 'https://pira-barolo.example/estate',
      reason: REASON,
    });
    // The propose-time snapshot is what lets the admin diff show drift.
    expect(created.currentSnapshot).toEqual({
      producer: 'Pira', name: 'Barolo', appellation: 'Barolo',
      region: 'Piedmont', country: 'Italy', classification: 'DOCG',
      // Both proposable since 2026-08-19, so both must ride in the snapshot —
      // the admin drift check compares against it field by field.
      type: null, grapes: null,
    });

    const row = McpActionLog.create.mock.calls[0][0];
    expect(row.action).toBe('somm_proposal');
    expect(row.detail).toEqual({ proposalId: 'prop-1', wineId: WINE_ID, kind: 'field_correction' });
    expect(logAudit).toHaveBeenCalledWith(SOMM_CTX.req, 'somm.wineProposal.create',
      expect.anything(), expect.objectContaining({ kind: 'field_correction', via: 'mcp' }));
  });

  // Somm ticket 6a85ad44: type and grapes were the only identity fields with
  // no route through this pipeline, so a curator who spotted a red stored on
  // nothing but white grapes had to hand it to an admin.
  describe('type and grapes', () => {
    test('files a type correction', async () => {
      mkWine({ type: 'red' });
      WineCorrectionProposal.create.mockResolvedValue({ _id: 'prop-t' });
      const body = parse(await tool('propose_wine_correction').handler({
        wine_id: WINE_ID, kind: 'field_correction',
        proposed_fields: { type: 'white' }, reason: REASON,
      }, SOMM_CTX));
      expect(body.error).toBeUndefined();
      expect(WineCorrectionProposal.create.mock.calls[0][0].proposedFields).toEqual({ type: 'white' });
    });

    test('resolves grape names to CANONICAL ones before storing them', async () => {
      mkWine();
      // "Tinta Roriz" is a synonym; the proposal should record what will
      // actually be written so the admin is not decoding it at review time.
      Grape.findOne.mockReturnValue(chain({ _id: oid('9'), name: 'Tempranillo' }));
      WineCorrectionProposal.create.mockResolvedValue({ _id: 'prop-g' });
      const body = parse(await tool('propose_wine_correction').handler({
        wine_id: WINE_ID, kind: 'field_correction',
        proposed_fields: { grapes: ['Tinta Roriz'] }, reason: REASON,
      }, SOMM_CTX));
      expect(body.error).toBeUndefined();
      expect(WineCorrectionProposal.create.mock.calls[0][0].proposedFields).toEqual({ grapes: ['Tempranillo'] });
    });

    test('refuses a variety that is not in the taxonomy, at FILE time', async () => {
      mkWine();
      Grape.findOne.mockReturnValue(chain(null));
      const body = parse(await tool('propose_wine_correction').handler({
        wine_id: WINE_ID, kind: 'field_correction',
        proposed_fields: { grapes: ['Cabernet Blanc'] }, reason: REASON,
      }, SOMM_CTX));
      expect(body.error.code).toBe('invalid_input');
      expect(body.error.message).toMatch(/not in the taxonomy/);
      expect(body.error.message).toMatch(/cannot create a variety/);
      expect(WineCorrectionProposal.create).not.toHaveBeenCalled();
    });

    test('the snapshot carries the wine\'s current type and grapes', async () => {
      mkWine({ type: 'red', grapes: [{ name: 'Merlot' }, { name: 'Cabernet Sauvignon' }] });
      WineCorrectionProposal.create.mockResolvedValue({ _id: 'prop-s' });
      await tool('propose_wine_correction').handler({
        wine_id: WINE_ID, kind: 'field_correction',
        proposed_fields: { type: 'white' }, reason: REASON,
      }, SOMM_CTX);
      expect(WineCorrectionProposal.create.mock.calls[0][0].currentSnapshot).toMatchObject({
        type: 'red', grapes: 'Merlot, Cabernet Sauvignon',
      });
    });
  });

  test('merge kind: the target must differ from the wine and must exist', async () => {
    let body = parse(await tool('propose_wine_correction').handler({
      wine_id: WINE_ID, kind: 'merge', merge_target_id: WINE_ID, reason: REASON,
    }, SOMM_CTX));
    expect(body.error.code).toBe('invalid_input');
    expect(body.error.message).toMatch(/DIFFERENT wine/);
    expect(WineDefinition.findById).not.toHaveBeenCalled();

    // First findById = the wine (found), second = the merge target (gone).
    const w = { _id: WINE_ID, name: 'Barolo', producer: 'Pira', country: { name: 'Italy' }, region: null };
    WineDefinition.findById.mockReturnValueOnce(chain(w)).mockReturnValueOnce(chain(null));
    body = parse(await tool('propose_wine_correction').handler({
      wine_id: WINE_ID, kind: 'merge', merge_target_id: TARGET_ID, reason: REASON,
    }, SOMM_CTX));
    expect(body.error.code).toBe('not_found');
    expect(body.error.message).toMatch(/merge_target_id/);
    expect(WineCorrectionProposal.create).not.toHaveBeenCalled();
  });

  test('a short reason is refused before any read', async () => {
    const body = parse(await tool('propose_wine_correction').handler({
      wine_id: WINE_ID, kind: 'non_wine', reason: 'too short',
    }, SOMM_CTX));
    expect(body.error.code).toBe('invalid_input');
    expect(body.error.message).toMatch(/at least 10/);
    expect(WineDefinition.findById).not.toHaveBeenCalled();
    expect(WineCorrectionProposal.create).not.toHaveBeenCalled();
  });

  test('field_correction with no non-empty field is refused', async () => {
    const body = parse(await tool('propose_wine_correction').handler({
      wine_id: WINE_ID, kind: 'field_correction', proposed_fields: { producer: '   ' }, reason: REASON,
    }, SOMM_CTX));
    expect(body.error.code).toBe('invalid_input');
    expect(body.error.message).toMatch(/at least one non-empty field/);
  });

  test('a second pending proposal for the same wine+kind is a clean conflict (unique-index violation)', async () => {
    mkWine();
    WineCorrectionProposal.create.mockRejectedValue(Object.assign(new Error('E11000 duplicate key'), { code: 11000 }));
    const body = parse(await tool('propose_wine_correction').handler({
      wine_id: WINE_ID, kind: 'non_wine', reason: REASON,
    }, SOMM_CTX));
    expect(body.error.code).toBe('conflict');
    expect(body.error.message).toMatch(/already exists/);
    expect(McpActionLog.create).not.toHaveBeenCalled();
  });

  test('undo withdraws a STILL-PENDING proposal via a status-gated delete and claims the row', async () => {
    const row = { _id: 'wp', action: 'somm_proposal', reversed: false, detail: { proposalId: 'prop-1', wineId: WINE_ID, kind: 'merge' } };
    McpActionLog.findOne.mockReturnValue(chain(row));
    McpActionLog.findOneAndUpdate.mockResolvedValue(row);
    WineCorrectionProposal.findById.mockReturnValue(chain({ _id: 'prop-1', status: 'pending', kind: 'merge' }));
    WineCorrectionProposal.deleteOne.mockResolvedValue({ deletedCount: 1 });
    const res = await tool('undo_last').handler({}, { ...SOMM_CTX, scopes: ['consume', 'write'] });
    expect(parse(res).data.undone).toBe('propose_wine_correction');
    // Status-gated: a decision landing between the pre-check and the delete wins.
    expect(WineCorrectionProposal.deleteOne).toHaveBeenCalledWith({ _id: 'prop-1', status: 'pending' });
    expect(McpActionLog.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'wp', reversed: false }, { $set: { reversed: true, idempotencyKey: null } });
  });

  test('undo refuses once an admin decided — the decision stands, nothing claimed or deleted', async () => {
    const row = { _id: 'wp', action: 'somm_proposal', reversed: false, detail: { proposalId: 'prop-1', wineId: WINE_ID, kind: 'non_wine' } };
    McpActionLog.findOne.mockReturnValue(chain(row));
    WineCorrectionProposal.findById.mockReturnValue(chain({ _id: 'prop-1', status: 'approved', kind: 'non_wine' }));
    const res = await tool('undo_last').handler({}, { ...SOMM_CTX, scopes: ['consume', 'write'] });
    expect(parse(res).error.code).toBe('conflict');
    expect(parse(res).error.message).toMatch(/approved/);
    expect(McpActionLog.findOneAndUpdate).not.toHaveBeenCalled();
    expect(WineCorrectionProposal.deleteOne).not.toHaveBeenCalled();
  });
});

describe('undo of somm actions', () => {
  test('undo somm_price deletes exactly the snapshot this user created; role re-checked', async () => {
    const row = {
      _id: 'sp', action: 'somm_price', reversed: false,
      detail: { entryId: 'price-1', vintage: '2019' },
    };
    McpActionLog.findOne.mockReturnValue(chain(row));
    // Role-less caller refused before any claim:
    let res = await tool('undo_last').handler({}, { ...USER_CTX, scopes: ['consume', 'write'] });
    expect(parse(res).error.code).toBe('forbidden_scope');
    expect(McpActionLog.findOneAndUpdate).not.toHaveBeenCalled();

    McpActionLog.findOneAndUpdate.mockResolvedValue(row);
    WineVintagePrice.deleteOne.mockResolvedValue({ deletedCount: 1 });
    res = await tool('undo_last').handler({}, { ...SOMM_CTX, scopes: ['consume', 'write'] });
    expect(parse(res).data.undone).toBe('set_vintage_price');
    expect(WineVintagePrice.deleteOne).toHaveBeenCalledWith({ _id: 'price-1', setBy: ME });
  });

  test('the somm undo record is viaUndo:true (excluded from candidacy → no undo-of-undo corruption)', async () => {
    const row = { _id: 'sp', action: 'somm_price', reversed: false, detail: { entryId: 'price-1', vintage: '2019' } };
    McpActionLog.findOne.mockReturnValue(chain(row));
    McpActionLog.findOneAndUpdate.mockResolvedValue(row);
    WineVintagePrice.deleteOne.mockResolvedValue({ deletedCount: 1 });
    await tool('undo_last').handler({}, { ...SOMM_CTX, scopes: ['consume', 'write'] });
    expect(McpActionLog.create.mock.calls.at(-1)[0]).toMatchObject({ action: 'somm_price', viaUndo: true });
  });

  test('undo somm_maturity re-applies the FULL prev snapshot (phases, notes, status, reviewer)', async () => {
    const row = {
      _id: 'sm', action: 'somm_maturity', reversed: false,
      detail: { profileId: oid('1'), vintage: '2019' },
      prev: { earlyFrom: null, earlyUntil: null, peakFrom: 2020, peakUntil: 2030, lateFrom: null, lateUntil: null, sommNotes: null, status: 'pending', relative: false, setBy: null, setAt: null },
    };
    McpActionLog.findOne.mockReturnValue(chain(row));
    McpActionLog.findOneAndUpdate.mockResolvedValue(row);
    const p = { _id: oid('1'), peakFrom: 2026, peakUntil: 2040, status: 'reviewed', save: jest.fn().mockResolvedValue(undefined) };
    WineVintageProfile.findById.mockReturnValue(chain(p));
    const res = await tool('undo_last').handler({}, { ...SOMM_CTX, scopes: ['consume', 'write'] });
    expect(parse(res).data.undone).toBe('set_vintage_maturity');
    expect(p.peakFrom).toBe(2020);
    expect(p.peakUntil).toBe(2030);
    expect(p.status).toBe('pending');
    expect(p.setBy).toBeNull();
    expect(p.save).toHaveBeenCalled();
  });
});

// ── Wine reports ─────────────────────────────────────────────────────────────
//
// A wine report is a real user saying "this record is wrong". These tools ride
// services/wineReportOps (unmocked here) so the shared close path — storage,
// audit and the reporter's notification — is exercised end to end.
describe('list_wine_reports', () => {
  const reportRow = (over = {}) => ({
    _id: oid('1'), reason: 'wrong_tasting_profile', status: 'pending',
    details: 'Zuccardi only just released this — it has 10+ years left.',
    createdAt: new Date('2026-08-06'),
    wineDefinition: { _id: oid('f'), name: 'Tinto de Familia', producer: 'Zuccardi', grapes: [] },
    ...over,
  });

  test('defaults to pending, oldest first, and reports the pending count', async () => {
    WineReport.find.mockReturnValue(chain([reportRow()]));
    WineReport.countDocuments.mockResolvedValueOnce(3).mockResolvedValueOnce(3);

    const res = await tool('list_wine_reports').handler({}, SOMM_CTX);
    const body = parse(res);

    expect(WineReport.find.mock.calls[0][0]).toEqual({ status: 'pending' });
    // Oldest first: the longest-waiting reporter is the one most likely forgotten.
    expect(WineReport.find.mock.results[0].value.sort).toHaveBeenCalledWith({ createdAt: 1 });
    expect(body.summary).toMatch(/3 report/);
    expect(body.data[0].report_id).toBe(oid('1'));
    expect(body.data[0].details).toMatch(/10\+ years/);
  });

  test('the reporter is never identified on this surface', async () => {
    WineReport.find.mockReturnValue(chain([reportRow({ user: { _id: oid('9'), username: 'marcoscl', email: 'marcoscl@example.com' } })]));
    WineReport.countDocuments.mockResolvedValue(1);

    const body = parse(await tool('list_wine_reports').handler({}, SOMM_CTX));
    const serialized = JSON.stringify(body);
    expect(serialized).not.toMatch(/marcoscl/);
    expect(serialized).not.toMatch(/@example\.com/);
  });

  test('a structured suggestion is surfaced as a PROPOSAL, not something to apply here', async () => {
    WineReport.find.mockReturnValue(chain([reportRow({ suggestedField: 'producer', suggestedValue: 'Familia Zuccardi' })]));
    WineReport.countDocuments.mockResolvedValue(1);

    const body = parse(await tool('list_wine_reports').handler({}, SOMM_CTX));
    expect(body.data[0].suggested_correction).toMatchObject({
      field: 'producer', current: 'Zuccardi', proposed: 'Familia Zuccardi',
    });
    expect(body.data[0].suggested_correction.note).toMatch(/propose_wine_correction/);
  });

  test('status "all" drops the filter; an unknown status falls back to pending', async () => {
    WineReport.find.mockReturnValue(chain([]));
    WineReport.countDocuments.mockResolvedValue(0);

    await tool('list_wine_reports').handler({ status: 'all' }, SOMM_CTX);
    expect(WineReport.find.mock.calls[0][0]).toEqual({});

    await tool('list_wine_reports').handler({ status: 'bogus' }, SOMM_CTX);
    expect(WineReport.find.mock.calls[1][0]).toEqual({ status: 'pending' });
  });
});

describe('respond_to_wine_report', () => {
  const pending = (over = {}) => {
    const r = {
      _id: oid('1'), status: 'pending', user: oid('9'), wineDefinition: oid('f'),
      save: jest.fn().mockResolvedValue(undefined),
      ...over,
    };
    r.populate = jest.fn(async (path) => {
      if (path === 'wineDefinition') r.wineDefinition = { name: 'Tinto de Familia', producer: 'Zuccardi' };
    });
    return r;
  };

  test('resolving stores the reply and notifies the reporter, linked to Support', async () => {
    const r = pending();
    WineReport.findById.mockResolvedValue(r);

    const res = await tool('respond_to_wine_report').handler(
      { report_id: oid('1'), outcome: 'resolved', response: 'You were right — window moved to 2036.' },
      SOMM_CTX
    );
    const body = parse(res);

    expect(r.status).toBe('resolved');
    expect(r.adminResponse).toBe('You were right — window moved to 2036.');
    expect(body.data.acknowledgement_only).toBe(false);
    expect(createNotification).toHaveBeenCalledTimes(1);
    const [userId, type, , message, link] = createNotification.mock.calls[0];
    expect(userId).toBe(oid('9'));
    expect(type).toBe('wine_report_resolved');
    expect(message).toMatch(/2036/);
    expect(link).toBe('/support');
  });

  test('closing without a reply still notifies — silence is the bug being fixed', async () => {
    const r = pending();
    WineReport.findById.mockResolvedValue(r);

    const body = parse(await tool('respond_to_wine_report').handler(
      { report_id: oid('1'), outcome: 'dismissed' }, SOMM_CTX
    ));

    expect(body.data.acknowledgement_only).toBe(true);
    expect(createNotification).toHaveBeenCalledTimes(1);
    const [, type, , message] = createNotification.mock.calls[0];
    expect(type).toBe('wine_report_dismissed');
    expect(message).toMatch(/Tinto de Familia/);
  });

  test('an already-closed report is a conflict, and nobody is notified twice', async () => {
    WineReport.findById.mockResolvedValue(pending({ status: 'resolved' }));
    const res = await tool('respond_to_wine_report').handler(
      { report_id: oid('1'), outcome: 'resolved', response: 'again' }, SOMM_CTX
    );
    expect(parse(res).error.code).toBe('conflict');
    expect(createNotification).not.toHaveBeenCalled();
  });

  test('a missing report is not_found and points back at the lister', async () => {
    WineReport.findById.mockResolvedValue(null);
    const res = await tool('respond_to_wine_report').handler(
      { report_id: oid('1'), outcome: 'resolved' }, SOMM_CTX
    );
    const err = parse(res).error;
    expect(err.code).toBe('not_found');
    expect(err.message).toMatch(/list_wine_reports/);
  });

  test('the close is audited as an MCP action with its outcome', async () => {
    WineReport.findById.mockResolvedValue(pending());
    await tool('respond_to_wine_report').handler(
      { report_id: oid('1'), outcome: 'resolved', response: 'fixed' }, SOMM_CTX
    );
    expect(logAudit).toHaveBeenCalledWith(
      expect.anything(), 'wine.report.resolved', expect.anything(),
      expect.objectContaining({ via: 'mcp', responded: true })
    );
    expect(McpActionLog.create.mock.calls.at(-1)[0]).toMatchObject({ action: 'somm_wine_report_close' });
  });
});

// Somm ticket 6a887619: grapes were the ONE identity field the queue row hid,
// so creation-time grapes surfacing on a later get_wine read as "populated by
// an unidentified path during curation" — four instances filed before the
// cause was found. The rule under test: emit names honestly, or omit the key.
describe('wineLite carries grapes honestly (ticket 6a887619)', () => {
  const listQueue = async (wineDefinition) => {
    WineVintageProfile.countDocuments.mockResolvedValueOnce(1).mockResolvedValueOnce(1);
    WineVintageProfile.find.mockReturnValue(chain([{
      _id: oid('1'), vintage: '2020', status: 'pending', relative: false, wineDefinition,
    }]));
    return parse(await tool('list_maturity_queue').handler({}, SOMM_CTX)).data[0].wine;
  };

  test('populated grape docs emit their names', async () => {
    const wine = await listQueue({
      _id: oid('f'), name: 'Shiraz', producer: 'Lights Valley', type: 'red',
      grapes: [{ _id: oid('a'), name: 'Syrah' }],
    });
    expect(wine.grapes).toEqual(['Syrah']);
  });

  test('a genuinely empty list is [], a real "no grapes"', async () => {
    const wine = await listQueue({ _id: oid('f'), name: 'Rosso', producer: 'P', grapes: [] });
    expect(wine.grapes).toEqual([]);
  });

  test('UNPOPULATED ids omit the key — never claim "no grapes" about a wine that has them', async () => {
    const wine = await listQueue({
      _id: oid('f'), name: 'Shiraz', producer: 'P',
      grapes: [oid('a'), oid('b')], // raw ObjectIds: a caller that selected but did not populate
    });
    expect(wine.grapes).toBeUndefined();
    expect('grapes' in wine).toBe(false);
  });

  test('a surface that never selected grapes omits the key too', async () => {
    const wine = await listQueue({ _id: oid('f'), name: 'Barolo', producer: 'P' });
    expect('grapes' in wine).toBe(false);
  });
});
