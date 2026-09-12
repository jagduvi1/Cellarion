/**
 * wineProposalOps (#985 Slice A) — the shared user-suggestion engine both the
 * REST route and the MCP tool suggest_wine_correction call.
 *
 * Pins: validation (reason bounds, URL shape, field whitelist, at-least-one),
 * the discussion ban, the per-tier daily budget, wine VISIBILITY (not
 * ownership) gating, the snapshot shape the admin diff depends on, the
 * E11000 → friendly conflict mapping, and the caller-scoped mine listing.
 */

jest.mock('../models/WineCorrectionProposal', () => ({
  create: jest.fn(), countDocuments: jest.fn(), find: jest.fn(), findOne: jest.fn(), findOneAndUpdate: jest.fn(),
}));
// The shared contribution gate counts across ALL suggestion collections.
jest.mock('../models/RegistryDataKey', () => ({ countDocuments: jest.fn() }));
jest.mock('../models/RegistryDataValue', () => ({ countDocuments: jest.fn() }));
jest.mock('../models/User', () => ({ findById: jest.fn() }));
jest.mock('./wineVisibility', () => ({ findVisibleWine: jest.fn() }));
jest.mock('./audit', () => ({ logAudit: jest.fn() }));
jest.mock('./wineProfileOps', () => ({ resolveGrapeIdsStrict: jest.fn() }));

const WineCorrectionProposal = require('../models/WineCorrectionProposal');
const RegistryDataKey = require('../models/RegistryDataKey');
const RegistryDataValue = require('../models/RegistryDataValue');
const User = require('../models/User');
const { findVisibleWine } = require('./wineVisibility');
const { logAudit } = require('./audit');
const { resolveGrapeIdsStrict } = require('./wineProfileOps');
const ops = require('./wineProposalOps');

const oid = (c) => c.repeat(24);
const ME = oid('a');
const WINE = oid('b');

const wineDoc = {
  _id: WINE,
  producer: 'Cloudy Bay',
  name: 'Sauvignon Blanc',
  appellation: null,
  classification: null,
  region: { name: 'Marlborough' },
  country: { name: 'New Zealand' },
};

const mockUser = (tier = 'newcomer', banned = false) =>
  User.findById.mockReturnValue({
    select: jest.fn().mockResolvedValue({
      contribution: { tier },
      isDiscussionBanned: () => banned,
      username: 'johan',
    }),
  });

const GOOD = {
  wineId: WINE,
  fields: { appellation: 'Marlborough GI' },
  reason: 'Printed on the back label of my bottle.',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockUser();
  WineCorrectionProposal.countDocuments.mockResolvedValue(0);
  RegistryDataKey.countDocuments.mockResolvedValue(0);
  RegistryDataValue.countDocuments.mockResolvedValue(0);
  findVisibleWine.mockResolvedValue(wineDoc);
  // No pending row on the wine unless a test says so. The lookup is awaited
  // as a plain document (saveable), not a select/lean chain.
  WineCorrectionProposal.findOne.mockResolvedValue(null);
  WineCorrectionProposal.create.mockResolvedValue({ _id: oid('9'), proposedFields: GOOD.fields, status: 'pending' });
});

/** A pending row as the amend path reads it. */
const pendingRow = (over = {}) => ({
  _id: oid('7'),
  proposer: ME,
  proposedFields: { toObject: () => ({ name: 'Château Martinat' }) },
  reason: 'Name field holds the label boilerplate.',
  evidenceUrl: 'https://old.example/x',
  currentSnapshot: { producer: 'Cloudy Bay', name: 'Sauvignon Blanc', grapes: null },
  status: 'pending',
  ...over,
});
/** What the atomic update hands back once it landed. */
const updatedRow = (over = {}) => ({
  _id: oid('7'),
  proposer: ME,
  proposedFields: { toObject: () => ({ name: 'Château Martinat', grapes: ['Merlot', 'Malbec'] }) },
  amendments: [{ fields: ['grapes'], reason: 'Importer data sheet: 80% Merlot, 20% Malbec.' }],
  status: 'pending',
  ...over,
});

describe('createFieldCorrection validation', () => {
  test('reason too short / too long', async () => {
    expect((await ops.createFieldCorrection(ME, { ...GOOD, reason: 'short' })).code).toBe('invalid');
    expect((await ops.createFieldCorrection(ME, { ...GOOD, reason: 'x'.repeat(1001) })).code).toBe('invalid');
  });

  test('HTML is stripped from the reason before length-checking', async () => {
    const res = await ops.createFieldCorrection(ME, { ...GOOD, reason: '<b></b><i></i>hey' });
    expect(res.code).toBe('invalid'); // 3 chars of real text left
  });

  test('bad evidence URL rejected; unknown field rejected; empty fields rejected', async () => {
    expect((await ops.createFieldCorrection(ME, { ...GOOD, evidenceUrl: 'ftp://x' })).code).toBe('invalid');
    expect((await ops.createFieldCorrection(ME, { ...GOOD, fields: { vintage: '2019' } })).code).toBe('invalid');
    expect((await ops.createFieldCorrection(ME, { ...GOOD, fields: { producer: '   ' } })).code).toBe('invalid');
  });

  test('discussion ban blocks the write before any query', async () => {
    mockUser('newcomer', true);
    const res = await ops.createFieldCorrection(ME, GOOD);
    expect(res.code).toBe('banned');
    expect(WineCorrectionProposal.create).not.toHaveBeenCalled();
  });
});

describe('tier budget (shared across ALL suggestion families)', () => {
  test('newcomer stops at 3/day; ambassador at 30/day', async () => {
    WineCorrectionProposal.countDocuments.mockResolvedValue(3);
    expect((await ops.createFieldCorrection(ME, GOOD)).code).toBe('limit');

    mockUser('ambassador');
    WineCorrectionProposal.countDocuments.mockResolvedValue(29);
    expect((await ops.createFieldCorrection(ME, GOOD)).ok).toBe(true);
    WineCorrectionProposal.countDocuments.mockResolvedValue(30);
    expect((await ops.createFieldCorrection(ME, GOOD)).code).toBe('limit');
  });

  test('registry key/value suggestions consume the SAME pool as corrections', async () => {
    WineCorrectionProposal.countDocuments.mockResolvedValue(1);
    RegistryDataKey.countDocuments.mockResolvedValue(1);
    RegistryDataValue.countDocuments.mockResolvedValue(1); // 1+1+1 = newcomer cap 3
    expect((await ops.createFieldCorrection(ME, GOOD)).code).toBe('limit');
  });

  test('the budget window is the last 24h of the proposer, any wine', async () => {
    await ops.createFieldCorrection(ME, GOOD);
    const q = WineCorrectionProposal.countDocuments.mock.calls[0][0];
    expect(String(q.proposer)).toBe(ME);
    expect(q.createdAt.$gt).toBeInstanceOf(Date);
  });
});

describe('creation', () => {
  test('invisible wine is not_found (visibility, not ownership)', async () => {
    findVisibleWine.mockResolvedValue(null);
    expect((await ops.createFieldCorrection(ME, GOOD)).code).toBe('not_found');
  });

  test('creates with snapshot, stripped values and audit trail', async () => {
    const res = await ops.createFieldCorrection(ME, {
      ...GOOD,
      fields: { appellation: ' <b>Marlborough GI</b> ' },
      evidenceUrl: 'https://cloudybay.example/wine',
    }, { via: 'web' });

    expect(res.ok).toBe(true);
    expect(WineCorrectionProposal.create).toHaveBeenCalledWith(expect.objectContaining({
      proposer: ME,
      wineDefinition: WINE,
      kind: 'field_correction',
      proposedFields: { appellation: 'Marlborough GI' },
      evidenceUrl: 'https://cloudybay.example/wine',
      currentSnapshot: {
        producer: 'Cloudy Bay',
        name: 'Sauvignon Blanc',
        appellation: null,
        region: 'Marlborough',
        country: 'New Zealand',
        classification: null,
        type: null,
        grapes: null,
      },
    }));
    expect(logAudit).toHaveBeenCalledWith(null, 'wine_proposal.user_create',
      expect.objectContaining({ type: 'wine' }),
      expect.objectContaining({ via: 'web', tier: 'newcomer', fields: ['appellation'] }));
  });

  // Support ticket 2026-09-06: type and grapes are correctable by any user,
  // exactly as through the sommelier tool — resolved at filing, canonical names stored.
  test('grapes are resolved against the taxonomy at filing and stored as canonical names', async () => {
    resolveGrapeIdsStrict.mockResolvedValue({ ok: true, ids: ['g1', 'g2'], names: ['Pinot Noir', 'Müller-Thurgau'], substitutions: [{ from: 'Riesling-Sylvaner', to: 'Müller-Thurgau' }] });
    const res = await ops.createFieldCorrection(ME, { ...GOOD, fields: { grapes: [' Pinot Noir ', 'Riesling-Sylvaner'], type: 'White' } });
    expect(res.ok).toBe(true);
    expect(resolveGrapeIdsStrict).toHaveBeenCalledWith(['Pinot Noir', 'Riesling-Sylvaner']);
    expect(WineCorrectionProposal.create).toHaveBeenCalledWith(expect.objectContaining({
      proposedFields: { type: 'white', grapes: ['Pinot Noir', 'Müller-Thurgau'] },
    }));
  });

  test('an unknown grape name is refused at filing, naming it', async () => {
    resolveGrapeIdsStrict.mockResolvedValue({ ok: false, unmatched: ['Muskat Olivierx'] });
    const res = await ops.createFieldCorrection(ME, { ...GOOD, fields: { grapes: ['Pinot Noir', 'Muskat Olivierx'] } });
    expect(res).toMatchObject({ ok: false, code: 'invalid' });
    expect(res.message).toMatch(/Muskat Olivierx/);
    expect(WineCorrectionProposal.create).not.toHaveBeenCalled();
  });

  test('a bad type, an empty grape list and an oversized list are refused', async () => {
    expect((await ops.createFieldCorrection(ME, { ...GOOD, fields: { type: 'orange' } })).message).toMatch(/type must be one of/);
    expect((await ops.createFieldCorrection(ME, { ...GOOD, fields: { grapes: [] } })).message).toMatch(/1 to 12/);
    expect((await ops.createFieldCorrection(ME, { ...GOOD, fields: { grapes: Array(13).fill('Syrah') } })).message).toMatch(/1 to 12/);
    expect(resolveGrapeIdsStrict).not.toHaveBeenCalled();
  });

  // Joined, not an array: the admin modal compares the snapshot against its
  // liveIdentity (joined names) to flag drift — an array read as permanent drift
  // (audit 2026-09-12 L-2).
  test('the snapshot records the live type and JOINED grape names, the shape the admin diff compares', async () => {
    findVisibleWine.mockResolvedValue({ ...wineDoc, type: 'white', grapes: [{ name: 'Chardonnay' }, { name: 'Pinot Blanc' }] });
    await ops.createFieldCorrection(ME, GOOD);
    expect(WineCorrectionProposal.create).toHaveBeenCalledWith(expect.objectContaining({
      currentSnapshot: expect.objectContaining({ type: 'white', grapes: 'Chardonnay, Pinot Blanc' }),
    }));
  });

  test('E11000 (one pending per wine) from another user\'s racing row becomes a friendly conflict', async () => {
    WineCorrectionProposal.create.mockRejectedValue(Object.assign(new Error('dup'), { code: 11000 }));
    WineCorrectionProposal.findOne
      .mockResolvedValueOnce(null)                          // before the insert: nothing
      .mockResolvedValueOnce(pendingRow({ proposer: oid('c') })); // after E11000: somebody else's
    const res = await ops.createFieldCorrection(ME, GOOD);
    expect(res).toMatchObject({ ok: false, code: 'conflict' });
    expect(res.message).toMatch(/another user/);
  });

  test('E11000 that keeps vanishing gives up after two rounds with a retry-able conflict', async () => {
    WineCorrectionProposal.create.mockRejectedValue(Object.assign(new Error('dup'), { code: 11000 }));
    WineCorrectionProposal.findOne.mockResolvedValue(null);
    const res = await ops.createFieldCorrection(ME, GOOD);
    expect(res).toMatchObject({ ok: false, code: 'conflict' });
    expect(res.message).toMatch(/try again/);
    expect(WineCorrectionProposal.create).toHaveBeenCalledTimes(2);
  });

  test('a fresh filing reports amended: false', async () => {
    expect(await ops.createFieldCorrection(ME, GOOD)).toMatchObject({ ok: true, amended: false });
  });
});

// Support ticket 2026-09-12: the one-pending rule is per WINE, and the user's
// own suggestion was what blocked their follow-up. Own pending → amend; someone
// else's → conflict that says so. Audit 2026-09-12 H-1: the amendment is ONE
// atomic update pinned to the pending row, never a hydrated save().
describe('amending the caller\'s own pending suggestion', () => {
  const dup = () => Object.assign(new Error('dup'), { code: 11000 });

  test('own pending row: one findOneAndUpdate pinned to {pending, proposer}, per-field $set, $push amendment — no insert', async () => {
    WineCorrectionProposal.findOne.mockResolvedValue(pendingRow());
    WineCorrectionProposal.findOneAndUpdate.mockResolvedValue(updatedRow());
    resolveGrapeIdsStrict.mockResolvedValue({ ok: true, ids: ['1', '2'], names: ['Merlot', 'Malbec'], substitutions: [] });

    const res = await ops.createFieldCorrection(ME, {
      wineId: WINE,
      fields: { grapes: ['Merlot', 'Malbec'] },
      reason: 'Importer data sheet: 80% Merlot, 20% Malbec.',
      evidenceUrl: 'https://new.example/sheet',
    }, { via: 'mcp' });

    expect(res).toMatchObject({ ok: true, amended: true, amendedFields: ['grapes'] });
    expect(WineCorrectionProposal.findOneAndUpdate).toHaveBeenCalledTimes(1);
    const [filter, update, opts] = WineCorrectionProposal.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ _id: oid('7'), status: 'pending', proposer: ME, kind: 'field_correction' });
    // Per-field paths, so a parallel amendment of another field also lands;
    // the snapshot is refreshed for the added field only; the original
    // reason and evidenceUrl are NOT touched.
    expect(update.$set).toEqual({ 'proposedFields.grapes': ['Merlot', 'Malbec'], 'currentSnapshot.grapes': null });
    expect(update.$set).not.toHaveProperty('reason');
    expect(update.$set).not.toHaveProperty('evidenceUrl');
    expect(update.$set).not.toHaveProperty('proposedFields');
    expect(update.$push.amendments).toEqual(expect.objectContaining({
      fields: ['grapes'], reason: 'Importer data sheet: 80% Merlot, 20% Malbec.', evidenceUrl: 'https://new.example/sheet',
    }));
    expect(update.$push.amendments.at).toBeInstanceOf(Date);
    expect(opts).toEqual({ new: true, runValidators: true, context: 'query' });
    expect(WineCorrectionProposal.create).not.toHaveBeenCalled();
    expect(logAudit).toHaveBeenCalledWith(null, 'wine_proposal.user_amend',
      expect.objectContaining({ type: 'wine' }),
      expect.objectContaining({ via: 'mcp', fields: ['grapes'], allFields: ['name', 'grapes'], amendments: 1 }));
  });

  test('an amendment without evidence pushes no evidenceUrl key; a null snapshot is set whole', async () => {
    WineCorrectionProposal.findOne.mockResolvedValue(pendingRow({ currentSnapshot: null }));
    WineCorrectionProposal.findOneAndUpdate.mockResolvedValue(updatedRow());
    await ops.createFieldCorrection(ME, GOOD);
    const [, update] = WineCorrectionProposal.findOneAndUpdate.mock.calls[0];
    expect(update.$push.amendments).not.toHaveProperty('evidenceUrl');
    expect(update.$set.currentSnapshot).toEqual(expect.objectContaining({ producer: 'Cloudy Bay' }));
  });

  test('an amendment does NOT spend the daily budget (the ban still applies)', async () => {
    WineCorrectionProposal.findOne.mockResolvedValue(pendingRow());
    WineCorrectionProposal.findOneAndUpdate.mockResolvedValue(updatedRow());
    WineCorrectionProposal.countDocuments.mockResolvedValue(3); // newcomer limit reached
    expect((await ops.createFieldCorrection(ME, GOOD)).amended).toBe(true);

    mockUser('newcomer', true);
    expect((await ops.createFieldCorrection(ME, GOOD)).code).toBe('banned');
  });

  test('the bypass is capped: the 11th amendment is a limit, without a write', async () => {
    WineCorrectionProposal.findOne.mockResolvedValue(pendingRow({ amendments: Array(ops.AMENDMENTS_MAX).fill({ fields: ['name'], reason: 'x'.repeat(10) }) }));
    const res = await ops.createFieldCorrection(ME, GOOD);
    expect(res).toMatchObject({ ok: false, code: 'limit' });
    expect(WineCorrectionProposal.findOneAndUpdate).not.toHaveBeenCalled();
    expect(WineCorrectionProposal.create).not.toHaveBeenCalled();
  });

  test('row decided while composing: the pinned update misses, the filing is fresh and BUDGETED', async () => {
    WineCorrectionProposal.findOne.mockResolvedValue(pendingRow());
    WineCorrectionProposal.findOneAndUpdate.mockResolvedValue(null); // no longer pending
    WineCorrectionProposal.countDocuments.mockResolvedValue(3);     // and the budget is spent
    const res = await ops.createFieldCorrection(ME, GOOD);
    expect(res).toMatchObject({ ok: false, code: 'limit' });
    expect(WineCorrectionProposal.create).not.toHaveBeenCalled();

    WineCorrectionProposal.countDocuments.mockResolvedValue(0);
    const res2 = await ops.createFieldCorrection(ME, GOOD);
    expect(res2).toMatchObject({ ok: true, amended: false });
    expect(WineCorrectionProposal.create).toHaveBeenCalledTimes(1);
  });

  test('E11000 from the caller\'s OWN racing row is amended, never reported as "in the queue" (audit M-1)', async () => {
    WineCorrectionProposal.create.mockRejectedValue(dup());
    WineCorrectionProposal.findOne
      .mockResolvedValueOnce(null)          // before the insert: nothing
      .mockResolvedValueOnce(pendingRow()); // after E11000: the caller's parallel filing
    WineCorrectionProposal.findOneAndUpdate.mockResolvedValue(updatedRow());
    const res = await ops.createFieldCorrection(ME, GOOD);
    expect(res).toMatchObject({ ok: true, amended: true, amendedFields: ['appellation'] });
    expect(WineCorrectionProposal.findOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  test('somebody else\'s pending row is a transport-neutral conflict that says the limit is per wine', async () => {
    WineCorrectionProposal.findOne.mockResolvedValue(pendingRow({ proposer: oid('c') }));
    const res = await ops.createFieldCorrection(ME, GOOD);
    expect(res).toMatchObject({ ok: false, code: 'conflict' });
    expect(res.message).toMatch(/another user/);
    expect(res.message).toMatch(/per wine/);
    expect(res.message).not.toMatch(/get_wine/); // the web bottle page shows this text too
    expect(WineCorrectionProposal.create).not.toHaveBeenCalled();
    expect(WineCorrectionProposal.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test.each([
    ['somebody else\'s', oid('c')],
    ['the caller\'s own', ME],
  ])('a hidden wine answers not_found even when its queue row is %s — no leak, no write', async (_label, proposer) => {
    WineCorrectionProposal.findOne.mockResolvedValue(pendingRow({ proposer }));
    findVisibleWine.mockResolvedValue(null);
    expect((await ops.createFieldCorrection(ME, GOOD)).code).toBe('not_found');
    expect(WineCorrectionProposal.findOneAndUpdate).not.toHaveBeenCalled();
    expect(WineCorrectionProposal.create).not.toHaveBeenCalled();
  });
});

describe('pendingForWine', () => {
  const chain = (doc) => ({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(doc) }) });

  test('null when nothing is pending or the id is malformed', async () => {
    WineCorrectionProposal.findOne.mockReturnValue(chain(null));
    expect(await ops.pendingForWine(WINE, ME)).toBeNull();
    expect(await ops.pendingForWine('nope', ME)).toBeNull();
  });

  test('field names and mine — filing time only on the caller\'s own row, never the proposer or the values', async () => {
    const filed = new Date('2026-09-11T19:14:12.715Z');
    WineCorrectionProposal.findOne.mockReturnValue(chain({
      proposer: ME, createdAt: filed,
      proposedFields: { producer: 'Château Martinat', name: 'Château Martinat', appellation: null, grapes: undefined },
    }));
    expect(await ops.pendingForWine(WINE, ME)).toEqual({ fields: ['producer', 'name'], filed_at: filed, mine: true });
    expect(await ops.pendingForWine(WINE, oid('c'))).toEqual({ fields: ['producer', 'name'], mine: false });
    expect(await ops.pendingForWine(WINE, null)).toEqual({ fields: ['producer', 'name'], mine: false });
    expect(WineCorrectionProposal.findOne).toHaveBeenCalledWith({
      wineDefinition: { $eq: WINE }, kind: 'field_correction', status: 'pending',
    });
  });
});
