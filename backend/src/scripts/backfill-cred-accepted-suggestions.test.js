/**
 * scripts/backfill-cred-accepted-suggestions — Cellar Cred for the corrections
 * and values accepted before they earned any, through the live paths' helper
 * (services/suggestionCred) and its marker. The models are an in-memory store
 * answering the helper's query shapes, so a second run sees the first one's
 * markers exactly as MongoDB would; the points write itself is mocked.
 */
jest.mock('../models/User', () => ({ find: jest.fn() }));
jest.mock('../models/WineCorrectionProposal', () => ({ find: jest.fn(), updateOne: jest.fn() }));
jest.mock('../models/RegistryDataValue', () => ({ find: jest.fn(), updateOne: jest.fn() }));
jest.mock('../models/WineDefinition', () => ({ find: jest.fn() }));
jest.mock('../utils/cellarCred', () => ({
  ...jest.requireActual('../utils/cellarCred'),
  incrementCred: jest.fn(),
  decrementCred: jest.fn(),
}));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));

const User = require('../models/User');
const WineCorrectionProposal = require('../models/WineCorrectionProposal');
const RegistryDataValue = require('../models/RegistryDataValue');
const WineDefinition = require('../models/WineDefinition');
const { incrementCred } = require('../utils/cellarCred');
const { logAudit } = require('../services/audit');
const { SUPERSEDED_REASON } = require('../services/suggestionCred');
const { backfill, printReport } = require('./backfill-cred-accepted-suggestions');

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

// Ids sort in creation order, like ObjectIds: the scan pages by them.
const id = (prefix, n) => `${prefix}${String(n).padStart(23, '0')}`;
const ANNA = id('1', 1);
const BRUNO = id('1', 2);
const ADMIN = id('2', 1);
const SOMM = id('2', 2);
const WINE = id('e', 1);

let db;
const correction = (n, over = {}) => ({
  _id: id('a', n), proposer: ANNA, decidedBy: ADMIN, kind: 'field_correction', wineDefinition: WINE,
  status: 'approved', appliedNote: 'Applied: producer', ...over,
});
const value = (n, over = {}) => ({
  _id: id('b', n), suggestedBy: BRUNO, decidedBy: SOMM, status: 'published', ...over,
});
// Every write to a suggestion row (the claims), across both collections.
const markerWrites = () => [...WineCorrectionProposal.updateOne.mock.calls, ...RegistryDataValue.updateOne.mock.calls];

beforeEach(() => {
  jest.clearAllMocks();
  db = {
    users: [
      { _id: ANNA, username: 'anna', roles: ['user'], contribution: { totalScore: 10, tier: 'newcomer' } },
      { _id: BRUNO, username: 'bruno', roles: ['user'], contribution: { totalScore: 98, tier: 'contributor' } },
      { _id: ADMIN, username: 'admin', roles: ['user', 'admin'] },
      { _id: SOMM, username: 'somm', roles: ['user', 'somm'], contribution: { totalScore: 0, tier: 'newcomer' } },
    ],
    proposals: [
      ...Array.from({ length: 5 }, (_, i) => correction(i + 1)),             // 5 × anna
      correction(6, { kind: 'merge', proposer: BRUNO }),                      // bruno
      correction(7, { proposer: SOMM }),                                      // staff
      correction(8, { decidedBy: ANNA }),                                     // self-applied
      correction(9, { status: 'rejected', appliedNote: undefined }),          // not accepted
      correction(10, { proposer: id('1', 9) }),                               // account gone
    ],
    values: [
      value(1),
      value(2, { status: 'rejected', rejectReason: SUPERSEDED_REASON }),       // superseded: still stood
      value(3, { status: 'rejected', rejectReason: 'No source.' }),            // rejected: never earns
      value(4, { suggestedBy: SOMM, decidedBy: ADMIN }),                      // staff
    ],
    wines: [{ _id: WINE, nonWine: false }],
  };
  wire(User, () => db.users);
  wire(WineCorrectionProposal, () => db.proposals);
  wire(RegistryDataValue, () => db.values);
  wire(WineDefinition, () => db.wines);
  incrementCred.mockResolvedValue(undefined);
});

test('a dry run reports per member and in total, and writes nothing', async () => {
  const result = await backfill({ apply: false, batchSize: 3 });

  expect(result.members).toEqual([
    expect.objectContaining({ username: 'anna', corrections: 5, values: 0, points: 25, scoreBefore: 10, scoreAfter: 35, tierBefore: 'newcomer', tierAfter: 'contributor' }),
    expect.objectContaining({ username: 'bruno', corrections: 1, values: 2, points: 9, scoreBefore: 98, scoreAfter: 107, tierBefore: 'contributor', tierAfter: 'enthusiast' }),
  ]);
  expect(result.totals).toEqual({ members: 2, corrections: 6, values: 2, points: 34, tierChanges: 2 });
  expect(result.skipped).toEqual({ self: 1, staff: 2, gone: 1, restored: 0 });

  expect(markerWrites()).toEqual([]);
  expect(incrementCred).not.toHaveBeenCalled();
  expect(logAudit).not.toHaveBeenCalled();
  expect(db.proposals.every((p) => !p.credAwardedAt)).toBe(true);
});

test('--apply awards through the helper\'s marker; a second run awards nothing', async () => {
  const first = await backfill({ apply: true, batchSize: 3 });
  expect(first.totals).toEqual({ members: 2, corrections: 6, values: 2, points: 34, tierChanges: 2 });
  expect(incrementCred).toHaveBeenCalledTimes(8);
  expect(incrementCred.mock.calls.filter((c) => c[0] === ANNA)).toEqual(Array(5).fill([ANNA, 'wine_correction_accepted']));
  expect(incrementCred.mock.calls.filter((c) => c[0] === BRUNO).map((c) => c[1]).sort())
    .toEqual(['registry_value_published', 'registry_value_published', 'wine_correction_accepted']);
  // Exactly the earning rows carry the marker; the excluded ones stay open.
  const marked = [...db.proposals, ...db.values].filter((r) => r.credAwardedAt instanceof Date).map((r) => r._id).sort();
  expect(marked).toEqual([1, 2, 3, 4, 5, 6].map((n) => id('a', n)).concat([id('b', 1), id('b', 2)]).sort());
  // One audit row per member whose score moved.
  expect(logAudit.mock.calls.map((c) => [c[1], c[2], c[3].points])).toEqual([
    ['cred.accepted_suggestions.backfill', { type: 'user', id: ANNA }, 25],
    ['cred.accepted_suggestions.backfill', { type: 'user', id: BRUNO }, 9],
  ]);

  incrementCred.mockClear();
  logAudit.mockClear();
  const second = await backfill({ apply: true, batchSize: 3 });
  expect(second.members).toEqual([]);
  expect(second.totals.points).toBe(0);
  expect(incrementCred).not.toHaveBeenCalled();
  expect(logAudit).not.toHaveBeenCalled();
});

test('a row the live path already awarded is passed over', async () => {
  db.proposals[0].credAwardedAt = new Date('2026-01-01T00:00:00Z');
  const result = await backfill({ apply: true });
  expect(result.members.find((m) => m.username === 'anna').corrections).toBe(4);
  expect(incrementCred.mock.calls.filter((c) => c[0] === ANNA)).toHaveLength(4);
});

test('a non-wine flag whose wine was restored earns nothing; one still in quarantine does', async () => {
  db.proposals = [
    correction(1, { kind: 'non_wine', wineDefinition: id('e', 2) }),
    correction(2, { kind: 'non_wine', wineDefinition: id('e', 3) }),
  ];
  db.values = [];
  db.wines = [{ _id: id('e', 2), nonWine: false }, { _id: id('e', 3), nonWine: true }];
  const result = await backfill({ apply: true });
  expect(result.totals.corrections).toBe(1);
  expect(result.skipped.restored).toBe(1);
  expect(db.proposals.map((p) => Boolean(p.credAwardedAt))).toEqual([false, true]);
});

test('the report names each member with score and tier before → after, then the totals', async () => {
  const lines = [];
  printReport(await backfill({ apply: false }), { apply: false, log: (l) => lines.push(l) });
  const text = lines.join('\n');
  expect(text).toMatch(/anna\s+5\s+0\s+\+25\s+10 → 35\s+newcomer → contributor/);
  expect(text).toMatch(/bruno\s+1\s+2\s+\+9\s+98 → 107\s+contributor → enthusiast/);
  expect(text).toMatch(/Would award: 2 member\(s\); 6 accepted correction\(s\) \(\+30\), 2 published value\(s\) \(\+4\) = \+34 points; 2 tier change\(s\)/);
  expect(text).toMatch(/Not earning: 2 by staff accounts, 1 decided by their own suggester, 1 from accounts that are gone, 0 non-wine/);

  lines.length = 0;
  await backfill({ apply: true });
  printReport(await backfill({ apply: true }), { apply: true, log: (l) => lines.push(l) });
  expect(lines[0]).toMatch(/^Nothing to award/);
});
