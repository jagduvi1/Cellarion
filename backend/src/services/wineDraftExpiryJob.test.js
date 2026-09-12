/**
 * services/wineDraftExpiryJob — the private-draft clock (support ticket
 * 2026-09-12):
 *   - EMPTY drafts lapsing within 24 h are warned once (a touch clears the
 *     mark, so a revived draft is warned again); drafts holding bottles are
 *     never warned — they are never deleted;
 *   - a lapsed empty draft is deleted with the expiry action;
 *   - a lapsed draft holding bottles auto-publishes; when publish finds the
 *     wine already in the registry the bottles are attached to it instead;
 *   - the creator is told either way, and one failing row never stops the sweep.
 */
jest.mock('../models/WineDefinition', () => ({ find: jest.fn(), updateOne: jest.fn() }));
jest.mock('../models/Bottle', () => ({ exists: jest.fn(), distinct: jest.fn(async () => []) }));
jest.mock('./notifications', () => ({ createNotification: jest.fn(async () => {}) }));
jest.mock('./wineDraftOps', () => ({
  DRAFT_TTL_DAYS: 7,
  DRAFT_WARN_HOURS: 24,
  deleteDraft: jest.fn(),
  publishDraft: jest.fn(),
  attachDraftBottles: jest.fn(),
}));

const WineDefinition = require('../models/WineDefinition');
const Bottle = require('../models/Bottle');
const { createNotification } = require('./notifications');
const ops = require('./wineDraftOps');
const { runWineDraftExpirySweep } = require('./wineDraftExpiryJob');

const NOW = new Date('2026-09-19T12:00:00.000Z');
const ME = 'aaaaaaaaaaaaaaaaaaaaaaaa';

const leanChain = (rows) => {
  const q = { select: jest.fn(), limit: jest.fn(), lean: jest.fn(), sort: jest.fn() };
  for (const k of ['select', 'limit', 'lean', 'sort']) q[k].mockReturnValue(q);
  q.then = (res, rej) => Promise.resolve(rows).then(res, rej);
  return q;
};

// The warn pass runs two finds — the ids in the window, then the empty ones
// to warn (after Bottle.distinct says which hold bottles) — and the lapsed
// pass a third. `held` = ids Bottle.distinct reports as holding bottles.
function setup({ warn = [], held = [], lapsed = [] } = {}) {
  Bottle.distinct.mockResolvedValue(held);
  const emptyWarn = warn.filter((w) => !held.includes(w._id));
  WineDefinition.find.mockReturnValueOnce(leanChain(warn.map((w) => ({ _id: w._id }))));
  // The job skips the re-read when nothing in the window is empty.
  if (emptyWarn.length) WineDefinition.find.mockReturnValueOnce(leanChain(emptyWarn));
  WineDefinition.find.mockReturnValueOnce(leanChain(lapsed));
  WineDefinition.updateOne.mockResolvedValue({});
}

let warnSpy;
beforeAll(() => { warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
afterAll(() => warnSpy.mockRestore());
beforeEach(() => jest.clearAllMocks());

describe('warn pass', () => {
  test('queries empty-clock drafts lapsing within 24 h that were not warned, and marks them warned', async () => {
    setup({ warn: [{ _id: 'w1', name: 'Kaefferkopf', producer: 'Cave', createdBy: ME }] });
    Bottle.exists.mockResolvedValue(null);
    const r = await runWineDraftExpirySweep(NOW);

    const filter = WineDefinition.find.mock.calls[0][0];
    expect(filter).toEqual({
      draft: true,
      draftExpiresAt: { $lte: new Date(NOW.getTime() + 24 * 3600e3), $gt: NOW },
      draftExpiryWarnedAt: null,
    });
    // The drafts holding bottles are found in ONE distinct, not per row, and
    // the empty ones are re-read (still a draft, still unwarned) before the write.
    expect(Bottle.distinct).toHaveBeenCalledWith('wineDefinition', { wineDefinition: { $in: ['w1'] } });
    expect(WineDefinition.find.mock.calls[1][0]).toEqual({ _id: { $in: ['w1'] }, draft: true, draftExpiryWarnedAt: null });
    expect(createNotification).toHaveBeenCalledWith(ME, 'wine_draft_expiring', expect.any(String), expect.stringMatching(/Cave — Kaefferkopf/), '/wine-drafts');
    expect(WineDefinition.updateOne).toHaveBeenCalledWith({ _id: 'w1', draft: true, draftExpiryWarnedAt: null }, { $set: { draftExpiryWarnedAt: NOW } });
    expect(r).toMatchObject({ warned: 1, deleted: 0, published: 0, merged: 0, errors: 0 });
  });

  test('a draft holding bottles is never warned — and never occupies the warn window (audit 2026-09-12)', async () => {
    setup({ warn: [{ _id: 'w1', name: 'X', createdBy: ME }, { _id: 'w2', name: 'Y', createdBy: ME }], held: ['w1'] });
    Bottle.exists.mockResolvedValue(null);
    const r = await runWineDraftExpirySweep(NOW);
    // Only the empty draft is re-read and warned; the bottle-holder never reaches the loop.
    expect(WineDefinition.find.mock.calls[1][0]).toEqual({ _id: { $in: ['w2'] }, draft: true, draftExpiryWarnedAt: null });
    expect(createNotification).toHaveBeenCalledTimes(1);
    expect(WineDefinition.updateOne).toHaveBeenCalledWith(expect.objectContaining({ _id: 'w2' }), expect.anything());
    expect(r.warned).toBe(1);
  });
});

describe('expire pass', () => {
  const lapsedDraft = (o = {}) => ({ _id: 'w2', name: 'Kaefferkopf', producer: 'Cave', createdBy: ME, draft: true, ...o });

  test('an empty lapsed draft is deleted with the expiry action', async () => {
    setup({ lapsed: [lapsedDraft()] });
    Bottle.exists.mockResolvedValue(null);
    ops.deleteDraft.mockResolvedValue({ ok: true });
    const r = await runWineDraftExpirySweep(NOW);
    expect(WineDefinition.find.mock.calls.at(-1)[0]).toEqual({ draft: true, draftExpiresAt: { $lte: NOW } });
    expect(ops.deleteDraft).toHaveBeenCalledWith(expect.objectContaining({ _id: 'w2' }), null, { action: 'wine.draft_expire' });
    expect(ops.publishDraft).not.toHaveBeenCalled();
    expect(r).toMatchObject({ deleted: 1 });
  });

  test('a lapsed draft holding bottles auto-publishes and the creator is told', async () => {
    setup({ lapsed: [lapsedDraft()] });
    Bottle.exists.mockResolvedValue({ _id: 'b' });
    ops.publishDraft.mockResolvedValue({ ok: true, promoted: true, pendingCuration: false });
    const r = await runWineDraftExpirySweep(NOW);
    expect(ops.publishDraft).toHaveBeenCalledWith(expect.objectContaining({ _id: 'w2' }), { userId: ME, req: null, auto: true, reason: 'expiry' });
    expect(createNotification).toHaveBeenCalledWith(ME, 'wine_draft_published', expect.any(String), expect.stringMatching(/7 days/), '/wine-drafts');
    expect(ops.deleteDraft).not.toHaveBeenCalled();
    expect(r).toMatchObject({ published: 1 });
  });

  test('when publish finds the wine already in the registry, the bottles are attached to it and the creator is told', async () => {
    setup({ lapsed: [lapsedDraft()] });
    Bottle.exists.mockResolvedValue({ _id: 'b' });
    ops.publishDraft.mockResolvedValue({ ok: false, code: 'duplicate', match: { wine_id: 'tgt', name: 'Kaefferkopf', producer: 'Cave' } });
    ops.attachDraftBottles.mockResolvedValue({ ok: true, bottlesMoved: 3 });
    const r = await runWineDraftExpirySweep(NOW);
    expect(ops.attachDraftBottles).toHaveBeenCalledWith(expect.objectContaining({ _id: 'w2' }), 'tgt', { userId: ME, roles: [], req: null, auto: true, reason: 'expiry' });
    expect(createNotification).toHaveBeenCalledWith(ME, 'wine_draft_merged', expect.any(String), expect.stringMatching(/3 bottle/), '/wine-drafts');
    expect(r).toMatchObject({ merged: 1 });
  });

  test('one failing row is counted and the sweep continues', async () => {
    setup({ lapsed: [lapsedDraft({ _id: 'bad' }), lapsedDraft({ _id: 'good' })] });
    Bottle.exists.mockResolvedValue(null);
    ops.deleteDraft.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({ ok: true });
    const r = await runWineDraftExpirySweep(NOW);
    expect(r).toMatchObject({ deleted: 1, errors: 1 });
  });
});
