/**
 * services/wineDraftOps — the private-draft lifecycle (support ticket
 * 2026-09-12). Mocked models; the resolver, the promotion follow-through and
 * the visibility rule are mocked at their module boundary so each assertion
 * is about THIS module's decisions:
 *   - edits stay in the draft key namespace and restart the clock
 *   - publish: identity gates (interactive refuse / auto downgrade), the
 *     duplicate check with the draft's own id excluded, similar vs confirm,
 *     the key leaving the namespace, the follow-through exactly once, E11000
 *     answered as a duplicate with the holder
 *   - attach re-points bottles + their photos (never label scans) and
 *     dissolves the draft; delete refuses while bottles remain
 */

jest.mock('../models/WineDefinition', () => ({ findOne: jest.fn(), find: jest.fn(), updateOne: jest.fn(), deleteOne: jest.fn() }));
jest.mock('../models/Bottle', () => ({ exists: jest.fn(), distinct: jest.fn(), updateMany: jest.fn(), aggregate: jest.fn() }));
jest.mock('../models/BottleImage', () => ({ find: jest.fn(), updateMany: jest.fn(), deleteMany: jest.fn() }));
jest.mock('../models/WineVintageProfile', () => ({ deleteMany: jest.fn() }));
jest.mock('../models/Country', () => ({ findOne: jest.fn(), findById: jest.fn(), exists: jest.fn() }));
jest.mock('../models/Region', () => ({ findById: jest.fn(), exists: jest.fn() }));
jest.mock('../models/Grape', () => ({ find: jest.fn() }));
jest.mock('../models/Appellation', () => ({ exists: jest.fn() }));
jest.mock('./audit', () => ({ logAudit: jest.fn() }));
jest.mock('./appellationResolve', () => ({ resolveCanonicalAppellation: jest.fn(async (s) => s) }));
jest.mock('./wineProfileOps', () => ({ resolveGrapeIdsStrict: jest.fn() }));
jest.mock('./pendingWineOps', () => ({
  validatePendingFix: jest.fn((p) => ({ ok: true, clean: { ...p } })),
  runPromotionFollowThrough: jest.fn(async () => {}),
}));
jest.mock('./wineVisibility', () => ({ findVisibleWine: jest.fn() }));
jest.mock('./findOrCreateWine', () => ({ findOrCreateWine: jest.fn(), findOrCreateRegion: jest.fn() }));
jest.mock('./crossFieldScan', () => ({ detectBlockingProducerIssue: jest.fn(async () => null) }));
jest.mock('./search', () => ({ removeWine: jest.fn(), bulkIndexBottles: jest.fn(() => Promise.resolve()) }));
jest.mock('./imageProcessor', () => ({ unlinkImageFiles: jest.fn(async () => {}) }));
jest.mock('../utils/vintageProfile', () => ({ ensurePendingVintageProfile: jest.fn(async () => {}) }));

const WineDefinition = require('../models/WineDefinition');
const Bottle = require('../models/Bottle');
const BottleImage = require('../models/BottleImage');
const WineVintageProfile = require('../models/WineVintageProfile');
const Country = require('../models/Country');
const Region = require('../models/Region');
const Grape = require('../models/Grape');
const Appellation = require('../models/Appellation');
const { logAudit } = require('./audit');
const { resolveGrapeIdsStrict } = require('./wineProfileOps');
const { validatePendingFix, runPromotionFollowThrough } = require('./pendingWineOps');
const { findVisibleWine } = require('./wineVisibility');
const { findOrCreateWine } = require('./findOrCreateWine');
const { detectBlockingProducerIssue } = require('./crossFieldScan');
const { ensurePendingVintageProfile } = require('../utils/vintageProfile');
const ops = require('./wineDraftOps');

const ME = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const WINE = 'cccccccccccccccccccccccc';
const TARGET = 'dddddddddddddddddddddddd';

// A saveable draft document whose save() emulates the model hook: a row that
// is no longer a draft and has a real producer promotes.
const draft = (o = {}) => {
  const d = {
    _id: WINE, name: 'Kaefferkopf', producer: 'Cave de Kaysersberg', appellation: 'Alsace',
    country: 'c1', region: null, grapes: [], type: 'white', classification: null,
    draft: true, pendingIdentity: true, createdBy: ME, createdAt: new Date('2026-09-12T00:00:00Z'),
    draftExpiresAt: new Date('2026-09-19T00:00:00Z'), draftExpiryWarnedAt: null, normalizedKey: 'draft~x',
    populate: jest.fn(async function () { return this; }),
    ...o,
  };
  d.save = jest.fn(async function () {
    if (this.draft !== true && this.producer) this.pendingIdentity = false;
    return this;
  });
  return d;
};

const leanChain = (result) => {
  const q = { select: jest.fn(), populate: jest.fn(), lean: jest.fn(), sort: jest.fn(), limit: jest.fn() };
  for (const k of ['select', 'populate', 'lean', 'sort', 'limit']) q[k].mockReturnValue(q);
  q.then = (res, rej) => Promise.resolve(result).then(res, rej);
  return q;
};

beforeEach(() => {
  jest.clearAllMocks();
  Country.exists.mockResolvedValue(null);
  Region.exists.mockResolvedValue(null);
  Appellation.exists.mockResolvedValue(null);
  Country.findById.mockReturnValue(leanChain({ name: 'France' }));
  Region.findById.mockReturnValue(leanChain(null));
  Grape.find.mockReturnValue(leanChain([]));
  Bottle.exists.mockResolvedValue(null);
  Bottle.distinct.mockResolvedValue([]);
  Bottle.updateMany.mockResolvedValue({});
  BottleImage.find.mockResolvedValue([]);
  BottleImage.updateMany.mockResolvedValue({});
  BottleImage.deleteMany.mockResolvedValue({});
  WineVintageProfile.deleteMany.mockResolvedValue({});
  WineDefinition.deleteOne.mockResolvedValue({});
  WineDefinition.updateOne.mockResolvedValue({});
});

describe('validateDraftPatch', () => {
  test('a draft producer MAY be emptied (the curation queue refuses that)', () => {
    const v = ops.validateDraftPatch({ producer: '   ' });
    expect(v).toEqual({ ok: true, clean: { producer: '' } });
    expect(validatePendingFix).not.toHaveBeenCalled();
  });

  test('curation-only knobs are stripped before the shared validator sees them', () => {
    ops.validateDraftPatch({ name: 'X', identityUnavailable: true, crossFieldOverride: true });
    expect(validatePendingFix).toHaveBeenCalledWith({ name: 'X' });
  });

  test('classification is trimmed and capped; nothing-to-change is refused', () => {
    expect(ops.validateDraftPatch({ classification: '  Grand  Cru ' })).toEqual({ ok: true, clean: { classification: 'Grand Cru' } });
    expect(ops.validateDraftPatch({ classification: 'x'.repeat(201) }).ok).toBe(false);
    expect(ops.validateDraftPatch({})).toMatchObject({ ok: false });
    expect(ops.validateDraftPatch({ identityUnavailable: true })).toMatchObject({ ok: false });
  });

  test('a shared-validator refusal propagates', () => {
    validatePendingFix.mockReturnValueOnce({ ok: false, error: 'type must be one of: red' });
    expect(ops.validateDraftPatch({ type: 'blue' })).toEqual({ ok: false, error: 'type must be one of: red' });
  });
});

describe('loadOwnDraft / touchDraft', () => {
  test('a draft is loaded by id AND creator AND draft:true — a stranger gets not_found', async () => {
    WineDefinition.findOne.mockResolvedValue(null);
    expect(await ops.loadOwnDraft(WINE, ME)).toMatchObject({ ok: false, code: 'not_found' });
    expect(WineDefinition.findOne).toHaveBeenCalledWith({ _id: WINE, draft: true, createdBy: ME });
    expect(await ops.loadOwnDraft('nope', ME)).toMatchObject({ ok: false, code: 'invalid_input' });
  });

  test('touch restarts the clock and clears the warning, on a row that is still a draft', async () => {
    await ops.touchDraft(WINE);
    const [filter, update] = WineDefinition.updateOne.mock.calls[0];
    expect(filter).toEqual({ _id: WINE, draft: true });
    expect(update.$set.draftExpiresAt).toBeInstanceOf(Date);
    expect(update.$set.draftExpiryWarnedAt).toBeNull();
    expect(update.$set.draftExpiresAt.getTime()).toBeGreaterThan(Date.now() + 6 * 24 * 3600e3);
  });
});

describe('updateDraft', () => {
  test('an identity edit keeps the key in the per-creator draft namespace and restarts the clock', async () => {
    const w = draft();
    const r = await ops.updateDraft(w, { name: 'Kaefferkopf Grand Cru', producer: '' }, ME);
    expect(r.ok).toBe(true);
    expect(w.normalizedKey).toBe(`draft~${ME}::kaefferkopf grand cru:alsace`);
    expect(w.pendingIdentity).toBe(true);
    expect(w.draft).toBe(true);
    expect(w.draftExpiryWarnedAt).toBeNull();
    expect(w.draftExpiresAt.getTime()).toBeGreaterThan(Date.now() + 6 * 24 * 3600e3);
    expect(r.diff).toMatchObject({ name: { to: 'Kaefferkopf Grand Cru' }, producer: { to: '' } });
  });

  test('an unknown country is refused, never minted; an unknown grape is refused', async () => {
    Country.findOne.mockResolvedValue(null);
    expect(await ops.updateDraft(draft(), { countryName: 'Atlantis' }, ME)).toMatchObject({ ok: false, code: 'invalid_input' });
    resolveGrapeIdsStrict.mockResolvedValue({ ok: false, unmatched: ['Blaufränkischx'] });
    expect(await ops.updateDraft(draft(), { grapeNames: ['Blaufränkischx'] }, ME)).toMatchObject({ ok: false, code: 'invalid_input' });
  });

  test('E11000 → conflict ("you already have a draft of this wine")', async () => {
    const w = draft();
    w.save = jest.fn().mockRejectedValue(Object.assign(new Error('dup'), { code: 11000 }));
    expect(await ops.updateDraft(w, { name: 'Other' }, ME)).toMatchObject({ ok: false, code: 'conflict' });
  });
});

describe('checkPublishIdentity — the mint gates the draft skipped', () => {
  test('a missing producer is not a refusal: the draft publishes as a pending row', async () => {
    expect(await ops.checkPublishIdentity(draft({ producer: '' }))).toEqual({ ok: true, producerMissing: true });
    expect(await ops.checkPublishIdentity(draft({ producer: 'Unknown' }))).toEqual({ ok: true, producerMissing: true });
  });

  test('a place, house words only, or a cross-field hit refuses with the curation message', async () => {
    Region.exists.mockResolvedValueOnce({ _id: 'r' });
    expect(await ops.checkPublishIdentity(draft({ producer: 'Bordeaux' }))).toMatchObject({ ok: false, message: expect.stringMatching(/wine region, not a producer/) });
    expect(await ops.checkPublishIdentity(draft({ producer: 'Domaine' }))).toMatchObject({ ok: false, message: expect.stringMatching(/house words/) });
    detectBlockingProducerIssue.mockResolvedValueOnce({ check: 'producer-is-grape.v1', detail: 'Syrah' });
    expect(await ops.checkPublishIdentity(draft({ producer: 'Syrah Estate' }))).toMatchObject({ ok: false, message: expect.stringMatching(/cross-field rule/) });
  });

  test('a real producer passes', async () => {
    expect(await ops.checkPublishIdentity(draft())).toEqual({ ok: true, producerMissing: false });
  });
});

describe('publishDraft', () => {
  test('not a draft → conflict, nothing touched', async () => {
    const w = draft({ draft: false });
    expect(await ops.publishDraft(w, { userId: ME })).toMatchObject({ ok: false, code: 'conflict' });
    expect(findOrCreateWine).not.toHaveBeenCalled();
  });

  test('an unusable producer is refused interactively, but the AUTO path publishes as a pending row instead', async () => {
    Region.exists.mockResolvedValue({ _id: 'r' });
    findOrCreateWine.mockResolvedValue({ wine: null, noMatch: true });
    expect(await ops.publishDraft(draft({ producer: 'Bordeaux' }), { userId: ME })).toMatchObject({ ok: false, code: 'invalid_identity' });

    const w = draft({ producer: 'Bordeaux' });
    const r = await ops.publishDraft(w, { userId: ME, auto: true });
    expect(r).toMatchObject({ ok: true, promoted: false, pendingCuration: true });
    expect(w.producer).toBe('');
    expect(w.draft).toBe(false);
    expect(w.normalizedKey).toBe(`pending~${ME}:kaefferkopf:alsace`);
    expect(runPromotionFollowThrough).not.toHaveBeenCalled();
    expect(logAudit).toHaveBeenCalledWith(null, 'wine.draft_auto_publish', expect.anything(), expect.objectContaining({ pendingCuration: true }));
  });

  test('the duplicate check runs match-only with the draft\'s OWN id excluded; a confident match is `duplicate` and the draft is untouched', async () => {
    const match = { _id: TARGET, name: 'Kaefferkopf', producer: 'Cave de Kaysersberg', appellation: 'Alsace', country: { name: 'France' } };
    findOrCreateWine.mockResolvedValue({ wine: match, created: false });
    const w = draft();
    const r = await ops.publishDraft(w, { userId: ME });
    expect(r).toMatchObject({ ok: false, code: 'duplicate', match: { wine_id: TARGET, name: 'Kaefferkopf', country: 'France' } });
    expect(findOrCreateWine).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Kaefferkopf', producer: 'Cave de Kaysersberg', country: 'France', appellation: 'Alsace' }),
      ME,
      expect.objectContaining({ matchOnly: true, allowPending: true, excludeId: WINE, confirmCreate: false, skipSiblingMatch: false })
    );
    expect(w.save).not.toHaveBeenCalled();
    expect(w.draft).toBe(true);
  });

  test('soft-zone candidates are `similar` unless confirmed; confirmCreate publishes and records the near miss', async () => {
    const cand = { wine: { _id: TARGET, name: 'Kaefferkopf Vieilles Vignes', producer: 'Cave de Kaysersberg' }, score: 0.9 };
    findOrCreateWine.mockResolvedValue({ candidates: [cand] });
    const r1 = await ops.publishDraft(draft(), { userId: ME });
    expect(r1).toMatchObject({ ok: false, code: 'similar', candidates: [{ wine_id: TARGET, score: 0.9 }] });

    const w = draft();
    const r2 = await ops.publishDraft(w, { userId: ME, confirmCreate: true });
    expect(r2).toMatchObject({ ok: true, promoted: true });
    expect(findOrCreateWine).toHaveBeenLastCalledWith(expect.anything(), ME, expect.objectContaining({ confirmCreate: true, skipSiblingMatch: true }));
    expect(logAudit).toHaveBeenCalledWith(null, 'wine.draft_publish', expect.anything(), expect.objectContaining({ nearMiss: [{ wine_id: TARGET, score: 0.9 }] }));
  });

  test('success: the key leaves the draft namespace, draft clears, the hook promotes, the follow-through runs ONCE', async () => {
    findOrCreateWine.mockResolvedValue({ wine: null, noMatch: true });
    const w = draft();
    const r = await ops.publishDraft(w, { userId: ME });
    expect(r).toMatchObject({ ok: true, promoted: true, pendingCuration: false });
    expect(w.normalizedKey).toBe('cave de kaysersberg:kaefferkopf:alsace');
    expect(w.draft).toBe(false);
    expect(w.draftExpiresAt).toBeNull();
    expect(w.pendingIdentity).toBe(false);
    expect(runPromotionFollowThrough).toHaveBeenCalledTimes(1);
    expect(runPromotionFollowThrough).toHaveBeenCalledWith(w);
  });

  test('E11000 on the publish save is a duplicate found by the unique index — answered with the holder', async () => {
    findOrCreateWine.mockResolvedValue({ wine: null, noMatch: true });
    const w = draft();
    w.save = jest.fn().mockRejectedValue(Object.assign(new Error('dup'), { code: 11000 }));
    WineDefinition.findOne.mockReturnValue(leanChain({ _id: TARGET, name: 'Kaefferkopf', producer: 'Cave de Kaysersberg' }));
    const r = await ops.publishDraft(w, { userId: ME });
    expect(r).toMatchObject({ ok: false, code: 'duplicate', match: { wine_id: TARGET } });
    expect(WineDefinition.findOne).toHaveBeenCalledWith({ normalizedKey: 'cave de kaysersberg:kaefferkopf:alsace', _id: { $ne: WINE } });
    expect(runPromotionFollowThrough).not.toHaveBeenCalled();
  });
});

describe('publishDrafts (batch)', () => {
  test('caps the batch and reports per id, a not_found never stopping the rest', async () => {
    expect(await ops.publishDrafts(new Array(25).fill(WINE), ME)).toMatchObject({ ok: false, code: 'invalid_input' });
    findOrCreateWine.mockResolvedValue({ wine: null, noMatch: true });
    WineDefinition.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(draft());
    const r = await ops.publishDrafts([TARGET, WINE], ME);
    expect(r.results).toEqual([
      { id: TARGET, status: 'not_found', error: expect.any(String) },
      { id: WINE, status: 'published' },
    ]);
  });
});

describe('attachDraftBottles', () => {
  test('re-points bottles and their photos (never label scans), seeds the target\'s maturity rows, dissolves the draft', async () => {
    const target = { _id: TARGET, name: 'Kaefferkopf', producer: 'Cave de Kaysersberg' };
    findVisibleWine.mockResolvedValue(target);
    Bottle.distinct.mockResolvedValueOnce(['b1', 'b2']).mockResolvedValueOnce(['2019', '2020']);
    const w = draft();
    const r = await ops.attachDraftBottles(w, TARGET, { userId: ME, roles: ['user'] });
    expect(r).toMatchObject({ ok: true, bottlesMoved: 2, wine: target });
    expect(findVisibleWine).toHaveBeenCalledWith(TARGET, expect.objectContaining({ userId: ME, noDrafts: true }));
    expect(Bottle.updateMany).toHaveBeenCalledWith({ wineDefinition: WINE }, { $set: { wineDefinition: TARGET } });
    expect(BottleImage.updateMany).toHaveBeenCalledWith({ wineDefinition: WINE, kind: { $ne: 'label-scan' } }, { $set: { wineDefinition: TARGET } });
    expect(ensurePendingVintageProfile).toHaveBeenCalledTimes(2);
    expect(WineDefinition.deleteOne).toHaveBeenCalledWith({ _id: WINE, draft: true });
    expect(logAudit).toHaveBeenCalledWith(null, 'wine.draft_attach', expect.anything(), expect.objectContaining({ targetId: TARGET, bottlesMoved: 2 }));
  });

  test('an invisible target is not_found; attaching to itself is refused', async () => {
    findVisibleWine.mockResolvedValue(null);
    expect(await ops.attachDraftBottles(draft(), TARGET, { userId: ME })).toMatchObject({ ok: false, code: 'not_found' });
    findVisibleWine.mockResolvedValue({ _id: WINE });
    expect(await ops.attachDraftBottles(draft(), WINE, { userId: ME })).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(Bottle.updateMany).not.toHaveBeenCalled();
  });
});

describe('deleteDraft', () => {
  test('refuses while bottles remain', async () => {
    Bottle.exists.mockResolvedValue({ _id: 'b1' });
    expect(await ops.deleteDraft(draft(), null)).toMatchObject({ ok: false, code: 'conflict' });
    expect(WineDefinition.deleteOne).not.toHaveBeenCalled();
  });

  test('an empty draft goes with its scan frames and pending maturity rows; the action can be the expiry one', async () => {
    BottleImage.find.mockResolvedValue([{ _id: 'i1' }]);
    const r = await ops.deleteDraft(draft(), null, { action: 'wine.draft_expire' });
    expect(r).toEqual({ ok: true });
    expect(require('./imageProcessor').unlinkImageFiles).toHaveBeenCalledWith({ _id: 'i1' });
    expect(BottleImage.deleteMany).toHaveBeenCalledWith({ wineDefinition: WINE });
    expect(WineVintageProfile.deleteMany).toHaveBeenCalledWith({ wineDefinition: WINE, status: 'pending' });
    expect(WineDefinition.deleteOne).toHaveBeenCalledWith({ _id: WINE, draft: true });
    expect(logAudit).toHaveBeenCalledWith(null, 'wine.draft_expire', { type: 'wine', id: WINE }, expect.objectContaining({ name: 'Kaefferkopf' }));
  });
});
