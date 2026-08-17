/**
 * personalData service (#986) — the shared engine both the REST routes and
 * the MCP tools call.
 *
 * Pins: wine-level visibility scoped to CURRENT cellar members (departed
 * members' entries vanish, non-members' never appear); key match-or-create
 * with the one-type-per-key conflict; both caps; typed validation before any
 * write; the discussion ban on writes; author-only update/delete with
 * not-found (never forbidden — no existence oracle); and the prevValue /
 * target snapshots the MCP undo path depends on.
 */

jest.mock('../models/PersonalDataKey', () => ({
  findOne: jest.fn(), find: jest.fn(), create: jest.fn(), countDocuments: jest.fn(),
}));
jest.mock('../models/PersonalDataEntry', () => ({
  find: jest.fn(), findOne: jest.fn(), findOneAndDelete: jest.fn(),
  create: jest.fn(), countDocuments: jest.fn(),
}));
jest.mock('../models/User', () => ({ findById: jest.fn() }));

const PersonalDataKey = require('../models/PersonalDataKey');
const PersonalDataEntry = require('../models/PersonalDataEntry');
const User = require('../models/User');
const svc = require('./personalData');

const oid = (c) => c.repeat(24);
const ME = oid('a');
const OTHER = oid('b');
const WINE = oid('c');
const BOTTLE_ID = oid('d');
const KEY_ID = oid('e');

const bottle = { _id: BOTTLE_ID, wineDefinition: WINE };
const cellar = { user: ME, members: [{ user: OTHER, role: 'editor' }] };

const abvKey = { _id: KEY_ID, name: 'ABV', nameKey: 'abv', type: 'decimal', unit: '%' };

// find() chain used by listForBottle / listKeys
const chain = (result) => {
  const c = {};
  for (const m of ['sort', 'populate', 'limit']) c[m] = jest.fn(() => c);
  c.lean = jest.fn(() => Promise.resolve(result));
  return c;
};

const notBanned = () => User.findById.mockReturnValue({
  select: jest.fn().mockResolvedValue({ isDiscussionBanned: () => false }),
});
const banned = () => User.findById.mockReturnValue({
  select: jest.fn().mockResolvedValue({ isDiscussionBanned: () => true }),
});

// An entry doc as the service sees it after create/findOne (populated).
const entryDoc = (over = {}) => ({
  _id: oid('f'),
  author: { _id: ME, username: 'johan', displayName: 'Johan' },
  key: abvKey,
  targetType: 'wine',
  wineDefinition: WINE,
  value: 13.5,
  createdAt: new Date('2026-08-17'),
  updatedAt: new Date('2026-08-17'),
  populate: jest.fn().mockResolvedValue(undefined),
  save: jest.fn().mockResolvedValue(undefined),
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  notBanned();
  PersonalDataEntry.countDocuments.mockResolvedValue(0);
  PersonalDataKey.countDocuments.mockResolvedValue(0);
});

describe('listForBottle', () => {
  test('bottle entries by bottle id; wine entries scoped to current cellar members only', async () => {
    PersonalDataEntry.find.mockReturnValue(chain([]));
    await svc.listForBottle(bottle, cellar);

    expect(PersonalDataEntry.find).toHaveBeenCalledWith({ bottle: BOTTLE_ID });
    expect(PersonalDataEntry.find).toHaveBeenCalledWith({
      wineDefinition: WINE,
      author: { $in: [ME, OTHER] },
    });
  });

  test('no wine query at all when the bottle has no wineDefinition', async () => {
    PersonalDataEntry.find.mockReturnValue(chain([]));
    const res = await svc.listForBottle({ _id: BOTTLE_ID, wineDefinition: null }, cellar);
    expect(res.wineEntries).toEqual([]);
    expect(PersonalDataEntry.find).toHaveBeenCalledTimes(1);
  });
});

describe('cellarMemberIds', () => {
  test('owner + members, handling populated and raw refs', () => {
    const ids = svc.cellarMemberIds({ user: { _id: ME }, members: [{ user: OTHER }] });
    expect(ids).toEqual([ME, OTHER]);
  });
});

describe('createEntry', () => {
  test('rejects a bad level and wine-level on a wineless bottle', async () => {
    expect((await svc.createEntry(ME, bottle, { level: 'rack' })).code).toBe('invalid');
    const res = await svc.createEntry(ME, { _id: BOTTLE_ID, wineDefinition: null }, { level: 'wine' });
    expect(res.code).toBe('invalid');
  });

  test('discussion ban blocks the write', async () => {
    banned();
    const res = await svc.createEntry(ME, bottle, {
      level: 'wine', newKey: { name: 'ABV', type: 'decimal' }, value: '13.5',
    });
    expect(res).toMatchObject({ ok: false, code: 'banned' });
    expect(PersonalDataEntry.create).not.toHaveBeenCalled();
  });

  test('reuses an existing same-type key (stored definition wins) and creates the entry', async () => {
    PersonalDataKey.findOne.mockResolvedValue(abvKey);
    PersonalDataEntry.create.mockResolvedValue(entryDoc());

    const res = await svc.createEntry(ME, bottle, {
      level: 'wine', newKey: { name: 'abv', type: 'decimal' }, value: '13,5',
    });

    expect(res.ok).toBe(true);
    expect(res.keyCreated).toBe(false);
    expect(PersonalDataKey.create).not.toHaveBeenCalled();
    expect(PersonalDataEntry.create).toHaveBeenCalledWith({
      author: ME, key: KEY_ID, targetType: 'wine', wineDefinition: WINE, value: 13.5,
    });
  });

  test('same name with a DIFFERENT type is a conflict, never a second key', async () => {
    PersonalDataKey.findOne.mockResolvedValue(abvKey);
    const res = await svc.createEntry(ME, bottle, {
      level: 'wine', newKey: { name: 'ABV', type: 'text' }, value: 'high',
    });
    expect(res).toMatchObject({ ok: false, code: 'type_conflict' });
    expect(PersonalDataKey.create).not.toHaveBeenCalled();
  });

  test('new key is created; key cap enforced', async () => {
    PersonalDataKey.findOne.mockResolvedValue(null);
    PersonalDataKey.create.mockResolvedValue(abvKey);
    PersonalDataEntry.create.mockResolvedValue(entryDoc());

    const ok = await svc.createEntry(ME, bottle, {
      level: 'bottle', newKey: { name: 'ABV', type: 'decimal', unit: '%' }, value: 13.5,
    });
    expect(ok.ok).toBe(true);
    expect(ok.keyCreated).toBe(true);
    expect(PersonalDataKey.create).toHaveBeenCalledWith({ user: ME, name: 'ABV', type: 'decimal', unit: '%' });
    // Bottle-level target
    expect(PersonalDataEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({ targetType: 'bottle', bottle: BOTTLE_ID })
    );

    PersonalDataKey.countDocuments.mockResolvedValue(svc.KEYS_PER_USER);
    const capped = await svc.createEntry(ME, bottle, {
      level: 'bottle', newKey: { name: 'New key', type: 'text' }, value: 'x',
    });
    expect(capped).toMatchObject({ ok: false, code: 'limit' });
  });

  test('value failing the key type is rejected before any write', async () => {
    PersonalDataKey.findOne.mockResolvedValue(abvKey);
    const res = await svc.createEntry(ME, bottle, {
      level: 'wine', newKey: { name: 'ABV', type: 'decimal' }, value: 'strong',
    });
    expect(res).toMatchObject({ ok: false, code: 'invalid' });
    expect(PersonalDataEntry.create).not.toHaveBeenCalled();
  });

  test('per-target entry cap enforced', async () => {
    PersonalDataKey.findOne.mockResolvedValue(abvKey);
    PersonalDataEntry.countDocuments.mockResolvedValue(svc.ENTRIES_PER_TARGET);
    const res = await svc.createEntry(ME, bottle, {
      level: 'wine', newKey: { name: 'ABV', type: 'decimal' }, value: 13.5,
    });
    expect(res).toMatchObject({ ok: false, code: 'limit' });
  });

  test('existing keyId must belong to the caller', async () => {
    PersonalDataKey.findOne.mockResolvedValue(null);
    const res = await svc.createEntry(ME, bottle, { level: 'wine', keyId: KEY_ID, value: 13.5 });
    expect(res).toMatchObject({ ok: false, code: 'not_found' });
    expect(PersonalDataKey.findOne).toHaveBeenCalledWith({ _id: KEY_ID, user: ME });
  });
});

describe('updateEntry', () => {
  test('author-scoped query; returns prevValue for undo; validates against the key type', async () => {
    const doc = entryDoc({ value: 13.5 });
    PersonalDataEntry.findOne.mockReturnValue({ populate: jest.fn().mockResolvedValue(doc) });

    const res = await svc.updateEntry(ME, doc._id, '14,0');
    expect(PersonalDataEntry.findOne).toHaveBeenCalledWith({ _id: doc._id, author: ME });
    expect(res.ok).toBe(true);
    expect(res.prevValue).toBe(13.5);
    expect(doc.value).toBe(14);
    expect(doc.save).toHaveBeenCalled();
  });

  test("someone else's entry is not_found, and a bad value never saves", async () => {
    PersonalDataEntry.findOne.mockReturnValue({ populate: jest.fn().mockResolvedValue(null) });
    expect((await svc.updateEntry(OTHER, oid('f'), 14)).code).toBe('not_found');

    const doc = entryDoc();
    PersonalDataEntry.findOne.mockReturnValue({ populate: jest.fn().mockResolvedValue(doc) });
    const res = await svc.updateEntry(ME, doc._id, 'not-a-number');
    expect(res.code).toBe('invalid');
    expect(doc.save).not.toHaveBeenCalled();
  });

  test('discussion ban blocks the update too', async () => {
    banned();
    const doc = entryDoc();
    PersonalDataEntry.findOne.mockReturnValue({ populate: jest.fn().mockResolvedValue(doc) });
    const res = await svc.updateEntry(ME, doc._id, 14);
    expect(res.code).toBe('banned');
    expect(doc.save).not.toHaveBeenCalled();
  });
});

describe('deleteEntry', () => {
  test('author-scoped delete returns the target snapshot for undo', async () => {
    const doc = entryDoc({ targetType: 'wine', wineDefinition: WINE, bottle: undefined });
    PersonalDataEntry.findOneAndDelete.mockReturnValue({ populate: jest.fn().mockResolvedValue(doc) });

    const res = await svc.deleteEntry(ME, doc._id);
    expect(PersonalDataEntry.findOneAndDelete).toHaveBeenCalledWith({ _id: doc._id, author: ME });
    expect(res.ok).toBe(true);
    expect(res.target).toEqual({ wineDefinition: WINE, bottle: null });
  });

  test("someone else's entry is not_found", async () => {
    PersonalDataEntry.findOneAndDelete.mockReturnValue({ populate: jest.fn().mockResolvedValue(null) });
    expect((await svc.deleteEntry(OTHER, oid('f'))).code).toBe('not_found');
  });
});

describe('listKeys', () => {
  test('only the caller’s keys, sorted by name', async () => {
    PersonalDataKey.find.mockReturnValue(chain([abvKey]));
    const res = await svc.listKeys(ME);
    expect(PersonalDataKey.find).toHaveBeenCalledWith({ user: ME });
    expect(res.keys).toEqual([{ _id: KEY_ID, name: 'ABV', type: 'decimal', unit: '%', enumOptions: null }]);
  });
});
