/**
 * personalData.listForBottles + the data-version bump on personal-data writes.
 *
 * WHY THIS TEST EXISTS:
 * GET /api/inventory hands a Home Assistant install the personal data on
 * every bottle at once. It must show exactly what each bottle's page shows
 * (listForBottle) and nothing more — personal data is attributed and visible
 * only inside a shared cellar — while reading it in a bounded number of
 * queries instead of two per bottle. Both functions run here over the same
 * fixture through one small in-memory query engine, so the rules are compared
 * directly, not restated.
 *
 * And the inventory answers 304 while the user's data version holds, so a
 * personal-data write must move the version of everyone whose view changed:
 * the author, the owner of the bottle's cellar, and for wine-level entries
 * the owners of every cellar the author is a member of.
 */
jest.mock('../models/PersonalDataEntry', () => ({
  find: jest.fn(), findOne: jest.fn(), findOneAndDelete: jest.fn(),
  create: jest.fn(), countDocuments: jest.fn(), distinct: jest.fn(), exists: jest.fn(),
}));
jest.mock('../models/PersonalDataKey', () => ({ findOne: jest.fn(), countDocuments: jest.fn(), create: jest.fn() }));
jest.mock('../models/User', () => ({ findById: jest.fn(), find: jest.fn() }));
jest.mock('../models/Cellar', () => ({ distinct: jest.fn() }));
jest.mock('../models/Bottle', () => ({ distinct: jest.fn() }));
jest.mock('../models/SavedDashboard', () => ({ find: jest.fn() }));
jest.mock('../models/SavedView', () => ({ find: jest.fn() }));

const PersonalDataEntry = require('../models/PersonalDataEntry');
const PersonalDataKey = require('../models/PersonalDataKey');
const User = require('../models/User');
const Cellar = require('../models/Cellar');
const Bottle = require('../models/Bottle');
const { getDataVersion } = require('./dataVersion');
const svc = require('./personalData');

const oid = (c) => c.repeat(24);
// People
const OWNER = oid('1');   // owns C1, member of C2
const MEMBER = oid('2');  // editor in C1
const STRANGER = oid('3'); // in no cellar here
const OTHER = oid('4');   // owns C2
// Wines, cellars, bottles
const W1 = oid('a');
const W2 = oid('b');
const C1 = { _id: oid('c'), user: OWNER, members: [{ user: MEMBER, role: 'editor' }] };
const C2 = { _id: oid('d'), user: { _id: OTHER, username: 'other' }, members: [{ user: { _id: OWNER }, role: 'viewer' }] };
const B1 = { _id: oid('e'), cellar: C1._id, wineDefinition: { _id: W1, name: 'Barolo' }, vintage: '2015' };
const B2 = { _id: oid('f'), cellar: C1._id, wineDefinition: W1, vintage: '2016' };
const B3 = { _id: '5'.repeat(24), cellar: C1._id, wineDefinition: null, vintage: 'NV' };
const B4 = { _id: '6'.repeat(24), cellar: C2._id, wineDefinition: W1, vintage: '2015' };
const BOTTLES = [B1, B2, B3, B4];
const CELLARS = [C1, C2];

const KEYS = {
  k1: { _id: 'k1', name: 'Closure', type: 'enum', unit: null },
  k2: { _id: 'k2', name: 'ABV', type: 'decimal', unit: '%' },
  k3: { _id: 'k3', name: 'Box', type: 'text' },
};
const USERS = [
  { _id: OWNER, username: 'johan' },
  { _id: MEMBER, username: 'maria' },
  { _id: STRANGER, username: 'stranger' },
  { _id: OTHER, username: 'other' },
];

let n = 0;
const entry = (over) => ({ _id: `e${++n}`, createdAt: new Date(2026, 0, n), vintage: null, ...over });
const ENTRIES = [
  entry({ author: MEMBER, key: 'k1', targetType: 'bottle', bottle: B1._id, value: 'cork' }),
  // Bottle-level entries stay with the bottle, whoever wrote them.
  entry({ author: STRANGER, key: 'k3', targetType: 'bottle', bottle: B1._id, value: 'box 3' }),
  // A non-member's wine-level entry is never shown.
  entry({ author: STRANGER, key: 'k2', targetType: 'wine', wineDefinition: W1, value: 99 }),
  // A member's wine-level entry, every vintage: on C1's bottles of W1 only.
  entry({ author: MEMBER, key: 'k2', targetType: 'wine', wineDefinition: W1, value: 14 }),
  // The owner's 2015-only entry: on 2015 bottles of cellars they are in.
  entry({ author: OWNER, key: 'k2', targetType: 'wine', wineDefinition: W1, vintage: '2015', value: 13.5 }),
  // Another wine: nowhere here.
  entry({ author: OWNER, key: 'k1', targetType: 'wine', wineDefinition: W2, value: 'screw' }),
  // A key that is gone: nothing to show.
  entry({ author: MEMBER, key: 'gone', targetType: 'bottle', bottle: B2._id, value: 'x' }),
];

// ── A small query engine over ENTRIES for the shapes both functions send ──
const ids = (v) => (v && v._id ? String(v._id) : v == null ? null : String(v));
function matches(doc, query) {
  return Object.entries(query).every(([field, cond]) => {
    if (field === '$or') return cond.some((arm) => matches(doc, arm));
    if (cond === null) return doc[field] == null;
    if (cond && typeof cond === 'object' && Array.isArray(cond.$in)) {
      return doc[field] != null && cond.$in.map(ids).includes(ids(doc[field]));
    }
    return ids(doc[field]) === ids(cond);
  });
}
function findImpl(query) {
  let rows = ENTRIES.filter((d) => matches(d, query)).map((d) => ({ ...d }));
  const chain = {
    select: () => chain,
    sort: () => chain,
    populate: (path) => {
      if (path === 'key') rows = rows.map((r) => ({ ...r, key: KEYS[r.key] || null }));
      if (path === 'author') rows = rows.map((r) => ({ ...r, author: USERS.find((u) => u._id === r.author) || null }));
      return chain;
    },
    lean: async () => rows,
  };
  return chain;
}

beforeEach(() => {
  jest.clearAllMocks();
  PersonalDataEntry.find.mockImplementation(findImpl);
  User.find.mockImplementation((q) => ({
    select: () => ({ lean: async () => USERS.filter((u) => q._id.$in.map(String).includes(u._id)) }),
  }));
});

describe('listForBottles', () => {
  test('the visibility rules, bottle by bottle', async () => {
    const out = await svc.listForBottles(BOTTLES, CELLARS);
    const view = (b) => out.get(b._id).map((e) => `${e.key}=${e.value}@${e.level}/${e.by}`);

    expect(view(B1)).toEqual([
      'Closure=cork@bottle/maria',  // bottle-level by a member → shown
      'Box=box 3@bottle/stranger',  // bottle-level by anyone → shown (it belongs to the bottle)
      'ABV=14@wine/maria',          // wine-level by a member, every vintage
      'ABV=13.5@wine/johan',        // the owner's 2015 entry on a 2015 bottle
    ]);
    // 2016: the 2015-only entry is hidden; the stranger's wine-level never shows.
    expect(view(B2)).toEqual(['ABV=14@wine/maria']);
    // No wine: bottle-level only, and it has none (the keyless leftover is skipped).
    expect(view(B3)).toEqual([]);
    // C2: the owner of C1 is a member there, maria is not.
    expect(view(B4)).toEqual(['ABV=13.5@wine/johan']);
  });

  test('the full entry shape', async () => {
    const out = await svc.listForBottles([B1], CELLARS);
    expect(out.get(B1._id)[0]).toEqual({ key: 'Closure', type: 'enum', unit: null, value: 'cork', level: 'bottle', by: 'maria' });
    expect(out.get(B1._id)[2]).toEqual({ key: 'ABV', type: 'decimal', unit: '%', value: 14, level: 'wine', by: 'maria' });
  });

  test('exactly what listForBottle shows on each bottle page', async () => {
    const many = await svc.listForBottles(BOTTLES, CELLARS);
    for (const b of BOTTLES) {
      const cellar = CELLARS.find((c) => c._id === b.cellar);
      const plainBottle = { ...b, wineDefinition: ids(b.wineDefinition) };
      const one = await svc.listForBottle(plainBottle, cellar);
      const expected = [...one.bottleEntries, ...one.wineEntries]
        .filter((e) => e.key && e.key.name)
        .map((e) => `${e.key.name}=${e.value}@${e.level}/${e.author.username}`);
      expect(many.get(b._id).map((e) => `${e.key}=${e.value}@${e.level}/${e.by}`)).toEqual(expected);
    }
  });

  test('a bounded number of queries, whatever the bottle count; one wine-level arm per cellar', async () => {
    const lots = Array.from({ length: 300 }, (_, i) => ({ ...B2, _id: String(i).padStart(24, '0') }));
    await svc.listForBottles([...lots, B4], CELLARS);
    expect(PersonalDataEntry.find).toHaveBeenCalledTimes(2);
    expect(User.find).toHaveBeenCalledTimes(1);
    const wineQuery = PersonalDataEntry.find.mock.calls.map((c) => c[0]).find((q) => q.$or);
    expect(wineQuery.$or).toHaveLength(2);
    const arm = (cellarAuthors) => wineQuery.$or.find((a) => a.author.$in.length === cellarAuthors.length
      && cellarAuthors.every((u) => a.author.$in.includes(u)));
    // C1's arm reads C1's people only; C2's arm C2's people only.
    expect(arm([OWNER, MEMBER])).toBeTruthy();
    expect(arm([OTHER, OWNER])).toBeTruthy();
    expect(wineQuery.$or.flatMap((a) => a.author.$in)).not.toContain(STRANGER);
  });

  test('no bottles → no queries; no wines → no wine-level query', async () => {
    expect((await svc.listForBottles([], CELLARS)).size).toBe(0);
    expect(PersonalDataEntry.find).not.toHaveBeenCalled();
    const out = await svc.listForBottles([B3], CELLARS);
    expect(out.get(B3._id)).toEqual([]);
    expect(PersonalDataEntry.find).toHaveBeenCalledTimes(1);
  });

  test('a bottle whose cellar was not passed shows its bottle-level entries only', async () => {
    const out = await svc.listForBottles([B1], [C2]);
    expect(out.get(B1._id).map((e) => e.level)).toEqual(['bottle', 'bottle']);
  });
});

describe('personal-data writes move the data version of everyone who sees them', () => {
  const KEY = { _id: oid('9'), name: 'ABV', nameKey: 'abv', type: 'decimal', unit: '%' };
  const versions = (...users) => users.map((u) => getDataVersion(u));
  const moved = (before, users) => users.map((u, i) => getDataVersion(u) > before[i]);

  beforeEach(() => {
    User.findById.mockReturnValue({ select: jest.fn().mockResolvedValue({ isDiscussionBanned: () => false }) });
    PersonalDataKey.findOne.mockResolvedValue(KEY);
    PersonalDataEntry.countDocuments.mockResolvedValue(0);
    PersonalDataEntry.create.mockImplementation(async (doc) => ({
      ...doc, _id: oid('8'), key: KEY, author: { _id: doc.author }, populate: jest.fn().mockResolvedValue(undefined),
    }));
    Cellar.distinct.mockImplementation(async (field, q) => {
      if (q['members.user']) return q['members.user'] === MEMBER ? [OWNER] : [];
      return q._id.$in.includes(C1._id) ? [OWNER] : [];
    });
    Bottle.distinct.mockResolvedValue([C1._id]);
  });

  test('bottle-level create by a member: the member and the cellar\'s owner', async () => {
    const before = versions(MEMBER, OWNER, STRANGER);
    const res = await svc.createEntry(MEMBER, { ...B1, wineDefinition: W1 }, { level: 'bottle', keyId: KEY._id, value: 13 });
    expect(res.ok).toBe(true);
    expect(moved(before, [MEMBER, OWNER, STRANGER])).toEqual([true, true, false]);
    expect(Cellar.distinct).toHaveBeenCalledWith('user', { _id: { $in: [C1._id] } });
  });

  test('wine-level create: the author and the owners of the cellars they are a member of', async () => {
    const before = versions(MEMBER, OWNER);
    await svc.createEntry(MEMBER, { ...B1, wineDefinition: W1 }, { level: 'wine', keyId: KEY._id, value: 13 });
    expect(moved(before, [MEMBER, OWNER])).toEqual([true, true]);
    expect(Cellar.distinct).toHaveBeenCalledWith('user', { 'members.user': MEMBER, deletedAt: null });
  });

  test('update and delete reach the owner of the entry\'s bottle', async () => {
    const stored = {
      _id: oid('7'), author: MEMBER, key: KEY, targetType: 'bottle', bottle: B1._id, value: 13,
      save: jest.fn().mockResolvedValue(undefined), populate: jest.fn().mockResolvedValue(undefined),
    };
    PersonalDataEntry.findOne.mockReturnValue({ populate: jest.fn().mockResolvedValue(stored) });
    let before = versions(OWNER);
    expect((await svc.updateEntry(MEMBER, oid('7'), 14)).ok).toBe(true);
    expect(moved(before, [OWNER])).toEqual([true]);
    expect(Bottle.distinct).toHaveBeenCalledWith('cellar', { _id: { $in: [B1._id] } });

    PersonalDataEntry.findOneAndDelete.mockReturnValue({ populate: jest.fn().mockResolvedValue({ ...stored }) });
    before = versions(OWNER);
    expect((await svc.deleteEntry(MEMBER, oid('7'))).ok).toBe(true);
    expect(moved(before, [OWNER])).toEqual([true]);
  });

  test('a key rename reaches everyone its entries show to', async () => {
    const key = { ...KEY, user: MEMBER, save: jest.fn().mockResolvedValue(undefined) };
    PersonalDataKey.findOne.mockResolvedValue(key);
    PersonalDataEntry.distinct.mockResolvedValue([B1._id]);
    PersonalDataEntry.exists.mockResolvedValue({ _id: 'x' });
    const before = versions(MEMBER, OWNER);
    expect((await svc.updateKey(MEMBER, KEY._id, { name: 'Alcohol' })).ok).toBe(true);
    expect(moved(before, [MEMBER, OWNER])).toEqual([true, true]);
  });

  test('a failed owner lookup never fails the write; the author still moves', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    Cellar.distinct.mockRejectedValue(new Error('db down'));
    const before = versions(MEMBER);
    const res = await svc.createEntry(MEMBER, { ...B1, wineDefinition: W1 }, { level: 'bottle', keyId: KEY._id, value: 13 });
    expect(res.ok).toBe(true);
    expect(moved(before, [MEMBER])).toEqual([true]);
    spy.mockRestore();
  });
});
