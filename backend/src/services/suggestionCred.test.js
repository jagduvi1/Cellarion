/**
 * services/suggestionCred — Cellar Cred for accepted wine corrections and
 * published registry values. The models are an in-memory store that answers
 * exactly the query shapes the helper sends, so the marker (credAwardedAt)
 * behaves as it does in MongoDB: claimed once, released on a reversal.
 */
jest.mock('../models/User', () => ({ find: jest.fn() }));
jest.mock('../models/WineCorrectionProposal', () => ({ find: jest.fn(), updateOne: jest.fn() }));
jest.mock('../models/RegistryDataValue', () => ({ find: jest.fn(), updateOne: jest.fn() }));
jest.mock('../models/WineDefinition', () => ({ find: jest.fn() }));
jest.mock('../utils/cellarCred', () => ({ incrementCred: jest.fn(), decrementCred: jest.fn() }));

const User = require('../models/User');
const WineCorrectionProposal = require('../models/WineCorrectionProposal');
const RegistryDataValue = require('../models/RegistryDataValue');
const WineDefinition = require('../models/WineDefinition');
const { incrementCred, decrementCred } = require('../utils/cellarCred');
const cred = require('./suggestionCred');

// ── In-memory store: equality, null, $in, $nin, $ne, $gt, $or ──────────────
const same = (a, b) => ((a instanceof Date || b instanceof Date)
  ? a instanceof Date && b instanceof Date && a.getTime() === b.getTime()
  : String(a) === String(b));
function matches(doc, filter) {
  return Object.entries(filter).every(([field, cond]) => {
    if (field === '$or') return cond.some((f) => matches(doc, f));
    const v = doc[field];
    if (cond === null) return v == null;
    if (cond instanceof Date || typeof cond !== 'object') return v != null && same(v, cond);
    return Object.entries(cond).every(([op, arg]) => {
      if (op === '$in') return arg.some((a) => v != null && same(v, a));
      if (op === '$nin') return !arg.some((a) => (a === null ? v == null : v != null && same(v, a)));
      if (op === '$ne') return arg === null ? v != null : !(v != null && same(v, arg));
      if (op === '$gt') return String(v) > String(arg);
      throw new Error(`store: unsupported ${op}`);
    });
  });
}
function wire(Model, rowsOf) {
  if (Model.find) {
    Model.find.mockImplementation((filter) => {
      let out = rowsOf().filter((d) => matches(d, filter));
      const q = {
        sort: () => { out = [...out].sort((a, b) => String(a._id).localeCompare(String(b._id))); return q; },
        limit: (n) => { out = out.slice(0, n); return q; },
        select: () => q,
        lean: async () => out.map((d) => ({ ...d })),
      };
      return q;
    });
  }
  if (Model.updateOne) {
    Model.updateOne.mockImplementation(async (filter, update) => {
      const doc = rowsOf().find((d) => matches(d, filter));
      if (!doc) return { matchedCount: 0, modifiedCount: 0 };
      Object.assign(doc, update.$set);
      return { matchedCount: 1, modifiedCount: 1 };
    });
  }
}

const oid = (c) => c.repeat(24);
const MEMBER = oid('1');
const ADMIN = oid('2');
const SOMM = oid('3');
const SENTINEL = oid('4');
const WINE = oid('e');

let db;
const proposal = (over = {}) => ({
  _id: oid('a'), proposer: MEMBER, decidedBy: ADMIN, kind: 'field_correction', wineDefinition: WINE,
  status: 'approved', appliedNote: 'Applied: producer', credAwardedAt: null, ...over,
});
const value = (over = {}) => ({
  _id: oid('b'), suggestedBy: MEMBER, decidedBy: SOMM, status: 'published', credAwardedAt: null, ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  db = {
    users: [
      { _id: MEMBER, username: 'member', roles: ['user'], contribution: { totalScore: 20, tier: 'newcomer' } },
      { _id: ADMIN, username: 'admin', roles: ['user', 'admin'] },
      { _id: SOMM, username: 'somm', roles: ['user', 'somm'] },
      { _id: SENTINEL, username: '__deleted__', roles: ['user'] },
    ],
    proposals: [],
    values: [],
    wines: [],
  };
  wire(User, () => db.users);
  wire(WineCorrectionProposal, () => db.proposals);
  wire(RegistryDataValue, () => db.values);
  wire(WineDefinition, () => db.wines);
  incrementCred.mockResolvedValue(undefined);
  decrementCred.mockResolvedValue(undefined);
});

describe('an accepted wine correction', () => {
  test('earns its proposer the correction points once, and marks the row', async () => {
    db.proposals.push(proposal());

    expect(await cred.awardProposal(proposal())).toBe(true);
    expect(incrementCred).toHaveBeenCalledTimes(1);
    expect(incrementCred).toHaveBeenCalledWith(MEMBER, 'wine_correction_accepted');
    expect(db.proposals[0].credAwardedAt).toBeInstanceOf(Date);

    // The same row again — a retried request, the backfill — earns nothing more.
    expect(await cred.awardProposal(proposal())).toBe(false);
    expect(incrementCred).toHaveBeenCalledTimes(1);
  });

  test('the claim is atomic on "accepted and not yet awarded", and does not touch updatedAt', async () => {
    db.proposals.push(proposal());
    await cred.awardProposal(proposal());
    const [filter, update, options] = WineCorrectionProposal.updateOne.mock.calls[0];
    expect(filter).toEqual({ _id: oid('a'), credAwardedAt: null, status: 'approved', appliedNote: { $nin: [null, ''] } });
    expect(update.$set.credAwardedAt).toBeInstanceOf(Date);
    expect(options).toEqual({ timestamps: false });
  });

  test('every kind earns the same — a merge and a non-wine flag too', async () => {
    db.wines.push({ _id: WINE, nonWine: true });
    db.proposals.push(proposal({ _id: oid('a'), kind: 'merge' }), proposal({ _id: oid('c'), kind: 'non_wine' }));
    expect(await cred.awardProposal(db.proposals[0])).toBe(true);
    expect(await cred.awardProposal(db.proposals[1])).toBe(true);
    expect(incrementCred.mock.calls).toEqual([[MEMBER, 'wine_correction_accepted'], [MEMBER, 'wine_correction_accepted']]);
  });

  test('an approval that never applied (no receipt) earns nothing', async () => {
    db.proposals.push(proposal({ appliedNote: undefined }));
    expect(await cred.awardProposal(proposal({ appliedNote: undefined }))).toBe(false);
    expect(incrementCred).not.toHaveBeenCalled();
  });

  test('deciding one\'s own proposal earns nothing — the self-apply door included', async () => {
    db.proposals.push(proposal({ decidedBy: MEMBER }));
    expect(await cred.awardProposal(proposal({ decidedBy: MEMBER }))).toBe(false);
    expect(incrementCred).not.toHaveBeenCalled();
    expect(WineCorrectionProposal.updateOne).not.toHaveBeenCalled();
    expect(db.proposals[0].credAwardedAt).toBeNull();
  });

  test('staff accounts (admin, somm) earn nothing for curation', async () => {
    db.proposals.push(proposal({ proposer: SOMM, decidedBy: ADMIN }), proposal({ _id: oid('c'), proposer: ADMIN, decidedBy: SOMM }));
    expect(await cred.awardProposal(db.proposals[0])).toBe(false);
    expect(await cred.awardProposal(db.proposals[1])).toBe(false);
    expect(incrementCred).not.toHaveBeenCalled();
  });

  test('an account that is gone earns nothing: deleted, the erasure sentinel, or no proposer at all', async () => {
    for (const proposer of [oid('9'), SENTINEL, null]) {
      expect(await cred.awardProposal(proposal({ proposer }))).toBe(false);
    }
    expect(incrementCred).not.toHaveBeenCalled();
  });

  test('a failed points write keeps the claim: the points may already have landed, and a row is never paid twice', async () => {
    db.proposals.push(proposal());
    incrementCred.mockRejectedValueOnce(new Error('primary stepped down'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    expect(await cred.awardProposal(proposal())).toBe(false);
    expect(db.proposals[0].credAwardedAt).toBeInstanceOf(Date);

    // A second attempt (the live path again, or the backfill) pays nothing.
    expect(await cred.awardProposal(proposal())).toBe(false);
    expect(incrementCred).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  test('never throws: a failed read is logged and the decision stands', async () => {
    User.find.mockImplementation(() => { throw new Error('db down'); });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(cred.awardProposal(proposal())).resolves.toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('a published registry value', () => {
  test('earns its suggester the value points once', async () => {
    db.values.push(value());
    expect(await cred.awardValue(value())).toBe(true);
    expect(await cred.awardValue(value())).toBe(false);
    expect(incrementCred.mock.calls).toEqual([[MEMBER, 'registry_value_published']]);
    expect(db.values[0].credAwardedAt).toBeInstanceOf(Date);
  });

  test('a curator publishing their own value, or a staff suggestion, earns nothing', async () => {
    db.values.push(value({ suggestedBy: SOMM, decidedBy: SOMM }), value({ _id: oid('c'), suggestedBy: ADMIN }));
    expect(await cred.awardValue(db.values[0])).toBe(false);
    expect(await cred.awardValue(db.values[1])).toBe(false);
    expect(incrementCred).not.toHaveBeenCalled();
  });

  test('a superseded publication still counts as accepted; a rejection or a waiting suggestion does not', async () => {
    db.values.push(
      value({ _id: oid('b'), status: 'published' }),
      value({ _id: oid('c'), status: 'rejected', rejectReason: cred.SUPERSEDED_REASON }),
      value({ _id: oid('d'), status: 'rejected', rejectReason: 'No source.' }),
      value({ _id: oid('f'), status: 'suggested' }),
    );
    const rows = await cred.unawardedBatch('value', { limit: 10 });
    expect(rows.map((r) => r._id)).toEqual([oid('b'), oid('c')]);
  });
});

describe('the non-wine quarantine', () => {
  const flag = (over = {}) => proposal({ kind: 'non_wine', appliedNote: 'Quarantined as non-wine', ...over });

  test('restoring the wine takes the flag\'s points back; quarantining it again gives them back', async () => {
    db.wines.push({ _id: WINE, nonWine: true });
    db.proposals.push(flag());
    await cred.awardProposal(flag());
    expect(incrementCred).toHaveBeenCalledTimes(1);

    db.wines[0].nonWine = false;
    expect(await cred.settleNonWineProposals(WINE, false)).toEqual({ awarded: 0, reversed: 1 });
    expect(decrementCred).toHaveBeenCalledWith(MEMBER, 'wine_correction_accepted');
    expect(db.proposals[0].credAwardedAt).toBeNull();
    // A second restore has nothing left to take back.
    expect(await cred.settleNonWineProposals(WINE, false)).toEqual({ awarded: 0, reversed: 0 });
    expect(decrementCred).toHaveBeenCalledTimes(1);

    db.wines[0].nonWine = true;
    expect(await cred.settleNonWineProposals(WINE, true)).toEqual({ awarded: 1, reversed: 0 });
    expect(incrementCred).toHaveBeenCalledTimes(2);
    expect(db.proposals[0].credAwardedAt).toBeInstanceOf(Date);
  });

  test('a restore takes back only what was awarded — a self-applied flag earned nothing', async () => {
    db.wines.push({ _id: WINE, nonWine: false });
    db.proposals.push(flag({ decidedBy: MEMBER }));
    expect(await cred.settleNonWineProposals(WINE, false)).toEqual({ awarded: 0, reversed: 0 });
    expect(decrementCred).not.toHaveBeenCalled();
  });

  test('the backfill passes over a flag whose wine was restored, and pays one whose wine is gone', async () => {
    db.wines.push({ _id: WINE, nonWine: false });
    const restored = flag({ _id: oid('a') });
    const merged = flag({ _id: oid('c'), wineDefinition: oid('f') }); // wine merged away / deleted
    const plan = await cred.planAwards('proposal', [restored, merged]);
    expect(plan.earning.map((e) => e.row._id)).toEqual([oid('c')]);
    expect(plan.skipped).toEqual({ self: 0, staff: 0, gone: 0, restored: 1 });
  });
});

describe('planAwards', () => {
  test('sorts a batch into earners and the reasons the rest do not earn, reading users once', async () => {
    const plan = await cred.planAwards('proposal', [
      proposal({ _id: oid('a') }),
      proposal({ _id: oid('b'), decidedBy: MEMBER }),
      proposal({ _id: oid('c'), proposer: SOMM }),
      proposal({ _id: oid('d'), proposer: SENTINEL }),
    ]);
    expect(plan.earning).toEqual([{ row: expect.objectContaining({ _id: oid('a') }), userId: MEMBER }]);
    expect(plan.skipped).toEqual({ self: 1, staff: 1, gone: 1, restored: 0 });
    expect(plan.users.get(MEMBER).contribution.totalScore).toBe(20);
    expect(User.find).toHaveBeenCalledTimes(1);
    // Planning writes nothing.
    expect(WineCorrectionProposal.updateOne).not.toHaveBeenCalled();
    expect(incrementCred).not.toHaveBeenCalled();
  });
});
