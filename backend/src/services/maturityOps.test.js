/**
 * services/maturityOps — the drink-window body shared by the REST somm routes
 * and the MCP somm tools. The doors' own suites (routes/somm/maturity.*.test.js,
 * mcp/sommTools.test.js, mcp/revert.test.js) pin their responses; this file
 * pins the shared rules: the window ranges, the merged validation, the undo
 * snapshot, and what each write saves, bumps and audits.
 */

jest.mock('../models/WineVintageProfile', () => ({ deleteOne: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock('./audit', () => ({ logAudit: jest.fn() }));
jest.mock('./dataVersion', () => ({ bumpWineOwners: jest.fn() }));

const WineVintageProfile = require('../models/WineVintageProfile');
const { logAudit } = require('./audit');
const { bumpWineOwners } = require('./dataVersion');
const ops = require('./maturityOps');

const row = (over = {}) => ({
  _id: 'p1', wineDefinition: { _id: 'w1', name: 'Barolo' }, vintage: '2019', status: 'pending', relative: false,
  save: jest.fn().mockResolvedValue(undefined),
  ...over,
});

beforeEach(() => jest.clearAllMocks());

describe('canonicalVintage and windowRange', () => {
  test('"nv " in any case is NV, other values are trimmed; NV rows take offsets, year rows take years', () => {
    expect(ops.canonicalVintage('nv ')).toBe('NV');
    expect(ops.canonicalVintage(' 2019')).toBe('2019');
    expect(ops.windowRange({ vintage: 'NV' })).toEqual({ relative: true, min: 0, max: 100 });
    expect(ops.windowRange({ vintage: '2019' })).toEqual({ relative: false, min: 1900, max: 2200 });
  });
});

describe('mergeWindow', () => {
  test('keeps stored values for fields not sent, clears on null, refuses a value outside the range', () => {
    const p = row({ peakFrom: 2024, peakUntil: 2030, lateFrom: 2031 });
    expect(ops.mergeWindow(p, { peakUntil: 2032, lateFrom: null })).toEqual({
      ok: true, next: { earlyFrom: null, earlyUntil: null, peakFrom: 2024, peakUntil: 2032, lateFrom: null, lateUntil: null },
    });
    expect(ops.mergeWindow(p, { peakFrom: 1500 })).toEqual({ ok: false, code: 'invalid_input', message: 'peakFrom: 1500 out of range (years 1900–2200)' });
    expect(ops.mergeWindow(row({ vintage: 'NV' }), { peakFrom: 1990 })).toMatchObject({ ok: false, message: expect.stringMatching(/NV uses relative offsets 0–100/) });
  });

  test('a retained value in the other unit is a conflict until the whole window is rewritten', () => {
    const legacy = row({ vintage: 'NV', peakFrom: 2024, peakUntil: 2029 });
    expect(ops.mergeWindow(legacy, {})).toMatchObject({ ok: false, code: 'conflict', message: expect.stringMatching(/retained from the stored profile/) });
    expect(ops.mergeWindow(legacy, { earlyFrom: 0, earlyUntil: 1, peakFrom: 2, peakUntil: 4, lateFrom: null, lateUntil: null })).toMatchObject({ ok: true });
  });

  test('ordering is checked on the merged window with the tool\'s wording', () => {
    expect(ops.mergeWindow(row({ peakFrom: 2030 }), { peakUntil: 2025 })).toEqual({ ok: false, code: 'invalid_input', message: 'peakUntil cannot be before peakFrom' });
    expect(ops.mergeWindow(row(), { earlyFrom: 2030, peakFrom: 2025 })).toEqual({ ok: false, code: 'invalid_input', message: 'peak_from cannot be before early_from' });
    expect(ops.mergeWindow(row(), { peakFrom: 2030, lateFrom: 2025 })).toEqual({ ok: false, code: 'invalid_input', message: 'late_from cannot be before peak_from' });
    expect(ops.mergeWindow(row({ vintage: 'NV' }), { earlyFrom: 0, earlyUntil: 0 })).toMatchObject({ ok: true });
  });
});

describe('checkWindow', () => {
  test('answers the merged window, or what was refused for the caller to word', () => {
    const p = row({ peakFrom: 2024, peakUntil: 2030 });
    expect(ops.checkWindow(p, { peakUntil: 2032 })).toEqual({
      ok: true, next: { earlyFrom: null, earlyUntil: null, peakFrom: 2024, peakUntil: 2032, lateFrom: null, lateUntil: null },
    });
    expect(ops.checkWindow(p, { peakFrom: 1500 })).toEqual({ ok: false, code: 'invalid_input', rule: 'range', relative: false, field: 'peakFrom', value: 1500 });
    expect(ops.checkWindow(p, { peakUntil: 2020 })).toEqual({ ok: false, code: 'invalid_input', rule: 'order', relative: false, field: 'peakUntil', after: 'peakFrom' });
    expect(ops.checkWindow(p, { earlyFrom: 2026 })).toEqual({ ok: false, code: 'invalid_input', rule: 'order', relative: false, field: 'peakFrom', after: 'earlyFrom' });
    expect(ops.checkWindow(p, { lateFrom: 2020 })).toEqual({ ok: false, code: 'invalid_input', rule: 'order', relative: false, field: 'lateFrom', after: 'peakFrom' });
    expect(ops.checkWindow(row({ vintage: 'NV', peakFrom: 2024 }), { earlyFrom: 0 }))
      .toEqual({ ok: false, code: 'conflict', rule: 'retained', relative: true, field: 'peakFrom', value: 2024 });
  });
});

describe('windowSnapshot', () => {
  test('records the six phases (null when unset), the note and the review state', () => {
    const setAt = new Date('2026-01-01');
    expect(ops.windowSnapshot(row({ peakFrom: 2020, peakUntil: 2030, status: 'reviewed', setBy: 'u9', setAt, sommNotes: 'n' }))).toEqual({
      earlyFrom: null, earlyUntil: null, peakFrom: 2020, peakUntil: 2030, lateFrom: null, lateUntil: null,
      sommNotes: 'n', status: 'reviewed', relative: false, setBy: 'u9', setAt,
    });
    expect(ops.windowSnapshot(row())).toMatchObject({ sommNotes: null, setBy: null, setAt: null, relative: false });
  });
});

describe('applyWindow', () => {
  test('writes the phases (null clears), the note, the review stamp and the relative flag; bumps after the save; audits with the door', async () => {
    const p = row({ vintage: 'NV', lateFrom: 50 });
    const relative = await ops.applyWindow(p, { earlyFrom: 0, earlyUntil: 2, peakFrom: 2, peakUntil: 6, lateFrom: null, lateUntil: null },
      { sommNotes: 'Drink young.', actorId: 'somm1', req: { id: 'req' }, via: 'mcp' });
    expect(relative).toBe(true);
    expect(p).toMatchObject({ earlyFrom: 0, earlyUntil: 2, peakFrom: 2, peakUntil: 6, sommNotes: 'Drink young.', relative: true, status: 'reviewed', setBy: 'somm1' });
    expect(p.lateFrom).toBeUndefined();
    expect(p.setAt).toBeInstanceOf(Date);
    expect(p.save).toHaveBeenCalledTimes(1);
    expect(bumpWineOwners).toHaveBeenCalledWith(['w1']);
    expect(bumpWineOwners.mock.invocationCallOrder[0]).toBeGreaterThan(p.save.mock.invocationCallOrder[0]);
    expect(logAudit).toHaveBeenCalledWith({ id: 'req' }, 'somm.maturity.review', { type: 'wine', id: 'w1' }, { vintage: 'NV', relative: true, via: 'mcp' });
  });

  test('a note not given is left alone, and the web door audits without a via key', async () => {
    const p = row({ sommNotes: 'keep', wineDefinition: 'w2' });
    await ops.applyWindow(p, { earlyFrom: null, earlyUntil: null, peakFrom: 2026, peakUntil: 2030, lateFrom: null, lateUntil: null }, { actorId: 's', req: {} });
    expect(p.sommNotes).toBe('keep');
    expect(p.relative).toBe(false);
    expect(logAudit.mock.calls[0][2]).toEqual({ type: 'wine', id: 'w2' });
    expect(logAudit.mock.calls[0][3]).toEqual({ vintage: '2019', relative: false });
  });

  test('a phase the patch does not name keeps its stored value', async () => {
    const p = row({ lateFrom: 2040, lateUntil: 2050 });
    await ops.applyWindow(p, { peakFrom: 2026, peakUntil: 2030 }, { actorId: 's', req: {} });
    expect(p).toMatchObject({ peakFrom: 2026, peakUntil: 2030, lateFrom: 2040, lateUntil: 2050 });
  });
});

describe('resetWindow and removePendingRow', () => {
  test('reset clears every phase and the note, drops the stamp, bumps and audits with the optional reason and door', async () => {
    const p = row({ status: 'reviewed', peakFrom: 2024, peakUntil: 2030, sommNotes: 'n', setBy: 'u9', setAt: new Date() });
    await ops.resetWindow(p, { reason: 'not bottled yet', req: { id: 'req' }, via: 'mcp' });
    for (const f of ops.PHASE_FIELDS) expect(p[f]).toBeUndefined();
    expect(p).toMatchObject({ sommNotes: '', status: 'pending', setBy: null, setAt: null });
    expect(p.save).toHaveBeenCalledTimes(1);
    expect(bumpWineOwners).toHaveBeenCalledWith(['w1']);
    expect(logAudit).toHaveBeenCalledWith({ id: 'req' }, 'somm.maturity.reset', { type: 'wine', id: 'w1' }, { vintage: '2019', reason: 'not bottled yet', via: 'mcp' });
  });

  test('reset from the web audits the vintage alone', async () => {
    await ops.resetWindow(row({ status: 'reviewed' }), { req: {} });
    expect(logAudit.mock.calls[0][3]).toEqual({ vintage: '2019' });
  });

  test('remove deletes the row only while it is not reviewed, audits, and bumps nothing (nothing is left to read)', async () => {
    WineVintageProfile.deleteOne.mockResolvedValueOnce({ deletedCount: 1 });
    const removed = await ops.removePendingRow(row({ _id: 'p7' }), { reason: 'never released', req: { id: 'req' }, via: 'mcp' });
    expect(removed).toBe(true);
    expect(WineVintageProfile.deleteOne).toHaveBeenCalledWith({ _id: 'p7', status: { $ne: 'reviewed' } });
    expect(bumpWineOwners).not.toHaveBeenCalled();
    expect(logAudit).toHaveBeenCalledWith({ id: 'req' }, 'somm.maturity.remove', { type: 'wine', id: 'w1' }, { vintage: '2019', reason: 'never released', via: 'mcp' });
  });

  test('a row reviewed or removed since it was loaded is left alone: nothing deleted, nothing audited', async () => {
    WineVintageProfile.deleteOne.mockResolvedValueOnce({ deletedCount: 0 });
    expect(await ops.removePendingRow(row({ _id: 'p7' }), { req: {} })).toBe(false);
    expect(logAudit).not.toHaveBeenCalled();
  });
});

describe('the undo inverses', () => {
  test('restoreWindow re-applies the snapshot field for field, saves and bumps; a failed save propagates before the bump', async () => {
    const p = row({ peakFrom: 2026, peakUntil: 2040, status: 'reviewed', setBy: 'somm1' });
    const prev = { earlyFrom: null, peakFrom: 2020, peakUntil: 2030, lateFrom: null, lateUntil: null, sommNotes: null, status: 'pending', relative: false, setBy: null, setAt: null };
    await ops.restoreWindow(p, prev);
    expect(p).toMatchObject({ peakFrom: 2020, peakUntil: 2030, status: 'pending', relative: false, setBy: null, setAt: null });
    expect(p.earlyFrom).toBeUndefined();
    expect(p.sommNotes).toBeUndefined();
    expect(bumpWineOwners).toHaveBeenCalledWith(['w1']);

    jest.clearAllMocks();
    const failing = row({ save: jest.fn().mockRejectedValue(Object.assign(new Error('v'), { name: 'VersionError' })) });
    await expect(ops.restoreWindow(failing, prev)).rejects.toMatchObject({ name: 'VersionError' });
    expect(bumpWineOwners).not.toHaveBeenCalled();
  });

  test('reseedPendingRow upserts the pending stub on the unique pair, relative for an NV pair as the seeding writes it', async () => {
    await ops.reseedPendingRow({ wineDefinition: 'w1', vintage: '2027' });
    expect(WineVintageProfile.findOneAndUpdate).toHaveBeenCalledWith(
      { wineDefinition: 'w1', vintage: '2027' },
      { $setOnInsert: { wineDefinition: 'w1', vintage: '2027', status: 'pending', relative: false } },
      { upsert: true });

    jest.clearAllMocks();
    await ops.reseedPendingRow({ wineDefinition: 'w1', vintage: 'NV' });
    expect(WineVintageProfile.findOneAndUpdate.mock.calls[0][1].$setOnInsert)
      .toEqual({ wineDefinition: 'w1', vintage: 'NV', status: 'pending', relative: true });
  });

  test('a removed row that carried an imported suggestion is snapshotted whole and comes back whole; a plain stub records the pair alone', async () => {
    const suggested = row({ _id: 'p8', vintage: 'NV', relative: true, peakFrom: 2, peakUntil: 6, sommNotes: 'from my cellar book', setBy: 'member1' });
    expect(ops.hasWindowContent(suggested)).toBe(true);
    const prev = ops.removalSnapshot(suggested);
    expect(prev).toMatchObject({
      wineDefinition: 'w1', vintage: 'NV', status: 'pending', relative: true,
      earlyFrom: null, peakFrom: 2, peakUntil: 6, sommNotes: 'from my cellar book', setBy: 'member1',
    });
    await ops.reseedPendingRow(prev);
    expect(WineVintageProfile.findOneAndUpdate.mock.calls[0][1].$setOnInsert).toEqual({
      wineDefinition: 'w1', vintage: 'NV', status: 'pending', relative: true,
      peakFrom: 2, peakUntil: 6, sommNotes: 'from my cellar book', setBy: 'member1',
    });

    expect(ops.hasWindowContent(row())).toBe(false);
    expect(ops.removalSnapshot(row())).toEqual({ wineDefinition: 'w1', vintage: '2019' });
  });
});
