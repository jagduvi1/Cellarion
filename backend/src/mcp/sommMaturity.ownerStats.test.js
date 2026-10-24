/**
 * MCP drink-window writes that change what a wine's owners see in their
 * statistics: withdrawing a window (reset_maturity_row) and undoing a
 * maturity write (undo_last on a somm_maturity row). Both move the data
 * version of every owner of the wine (bumpWineOwners) once the profile is
 * saved, like set_vintage_maturity does — otherwise the stats overview and
 * token polls keep the old maturity counts until their cache ages out.
 *
 * The models and side-effect services are mocked so no MongoDB is needed.
 */

jest.mock('../models/WineVintageProfile', () => ({ findById: jest.fn() }));
jest.mock('../models/McpActionLog', () => ({ create: jest.fn(), findOneAndUpdate: jest.fn(), updateOne: jest.fn() }));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../services/dataVersion', () => ({ bumpWineOwners: jest.fn() }));

const WineVintageProfile = require('../models/WineVintageProfile');
const McpActionLog = require('../models/McpActionLog');
const { bumpWineOwners } = require('../services/dataVersion');
const { allTools } = require('./registry');
const { revertLedgerRow } = require('./revert');
require('./tools/somm');

const oid = (c) => c.repeat(24);
const ME = oid('a');
const WINE_ID = oid('f');
const SOMM_CTX = { user: { id: ME, roles: ['somm'] }, scopes: ['read', 'write'], req: { user: { id: ME, roles: ['somm'] }, headers: {} } };

const tool = (name) => allTools().find((t) => t.name === name);
const parse = (res) => JSON.parse(res.content[0].text);
const H = {
  ok: (summary, data) => ({ ok: true, summary, data }),
  fail: (code, message) => ({ ok: false, code, message }),
};

beforeEach(() => {
  jest.clearAllMocks();
  McpActionLog.create.mockResolvedValue({});
  McpActionLog.findOneAndUpdate.mockResolvedValue({ _id: 'claimed' });
  McpActionLog.updateOne.mockResolvedValue({});
});

describe('reset_maturity_row', () => {
  const reviewed = (over = {}) => ({
    _id: oid('a1'), vintage: '2018', status: 'reviewed', relative: false,
    earlyFrom: 2022, earlyUntil: 2025, peakFrom: 2026, peakUntil: 2032, lateFrom: 2033, lateUntil: 2040,
    sommNotes: 'Firm tannins; give it time.', setBy: oid('99'), setAt: new Date('2026-09-01'),
    wineDefinition: { _id: WINE_ID, name: 'Test Wine', producer: 'Test Producer' },
    save: jest.fn().mockResolvedValue(undefined),
    ...over,
  });
  const populated = (doc) => ({ populate: jest.fn(() => Promise.resolve(doc)) });

  test('withdrawing a window moves the wine owners\' data version', async () => {
    const doc = reviewed();
    WineVintageProfile.findById.mockReturnValue(populated(doc));

    const body = parse(await tool('reset_maturity_row').handler({ profile_id: oid('a1') }, SOMM_CTX));

    expect(body.data.status).toBe('pending');
    expect(doc.save).toHaveBeenCalledTimes(1);
    expect(bumpWineOwners).toHaveBeenCalledTimes(1);
    expect(bumpWineOwners).toHaveBeenCalledWith([WINE_ID]);
  });

  test('no bump when the save fails', async () => {
    const doc = reviewed({ save: jest.fn().mockRejectedValue(new Error('write failed')) });
    WineVintageProfile.findById.mockReturnValue(populated(doc));

    await expect(tool('reset_maturity_row').handler({ profile_id: oid('a1') }, SOMM_CTX)).rejects.toThrow('write failed');
    expect(bumpWineOwners).not.toHaveBeenCalled();
  });

  test('a refused reset (row already pending) does not bump', async () => {
    const doc = reviewed({ status: 'pending' });
    WineVintageProfile.findById.mockReturnValue(populated(doc));

    const body = parse(await tool('reset_maturity_row').handler({ profile_id: oid('a1') }, SOMM_CTX));

    expect(body.error.code).toBe('conflict');
    expect(bumpWineOwners).not.toHaveBeenCalled();
  });
});

describe('undo of a somm_maturity row', () => {
  const ledgerRow = (prev) => ({ _id: 'r1', action: 'somm_maturity', detail: { profileId: 'p1', vintage: '2018' }, prev });

  test('restoring a withdrawn window moves the wine owners\' data version', async () => {
    const profile = { _id: 'p1', wineDefinition: WINE_ID, vintage: '2018', status: 'pending', save: jest.fn().mockResolvedValue(undefined) };
    WineVintageProfile.findById.mockResolvedValue(profile);

    const res = await revertLedgerRow(ledgerRow({
      earlyFrom: 2022, earlyUntil: 2025, peakFrom: 2026, peakUntil: 2032, lateFrom: 2033, lateUntil: 2040,
      sommNotes: 'Firm tannins; give it time.', status: 'reviewed', relative: false, setBy: oid('99'), setAt: new Date('2026-09-01'),
    }), SOMM_CTX, H);

    expect(res.ok).toBe(true);
    expect(profile.status).toBe('reviewed');
    expect(profile.peakFrom).toBe(2026);
    expect(profile.save).toHaveBeenCalledTimes(1);
    expect(bumpWineOwners).toHaveBeenCalledTimes(1);
    expect(bumpWineOwners).toHaveBeenCalledWith([WINE_ID]);
  });

  test('no bump when the restore does not save', async () => {
    const err = Object.assign(new Error('stale'), { name: 'VersionError' });
    const profile = { _id: 'p1', wineDefinition: WINE_ID, vintage: '2018', status: 'pending', save: jest.fn().mockRejectedValue(err) };
    WineVintageProfile.findById.mockResolvedValue(profile);

    const res = await revertLedgerRow(ledgerRow({ status: 'reviewed', peakFrom: 2026, relative: false, setBy: null, setAt: null }), SOMM_CTX, H);

    expect(res).toMatchObject({ ok: false, code: 'conflict' });
    expect(bumpWineOwners).not.toHaveBeenCalled();
  });
});
