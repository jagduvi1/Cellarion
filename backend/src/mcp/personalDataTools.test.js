/**
 * Personal-data MCP tools (#986) — list/add/update/delete + undo.
 *
 * Pins: the read/write scope split; access gating through resolveBottleAccess
 * (foreign bottle → not_found, never forbidden); every handler delegating to
 * the SHARED service (services/personalData — semantics tested there, drift
 * prevented here); the ledger rows carrying what undo needs (create → entryId,
 * update → prev value, delete → full recreate snapshot); and all three
 * personal_data revert branches.
 */

jest.mock('../services/personalData', () => ({
  listForBottle: jest.fn(), createEntry: jest.fn(), updateEntry: jest.fn(),
  deleteEntry: jest.fn(), listKeys: jest.fn(), updateKey: jest.fn(), deleteKey: jest.fn(),
  KEYS_PER_USER: 100, ENTRIES_PER_TARGET: 20,
}));
jest.mock('../models/Bottle', () => ({ findById: jest.fn(), aggregate: jest.fn(), find: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../models/Cellar', () => ({ findById: jest.fn(), find: jest.fn() }));
jest.mock('../models/McpActionLog', () => ({ create: jest.fn(), findOne: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock('../models/PersonalDataEntry', () => ({ findOne: jest.fn(), findOneAndDelete: jest.fn(), create: jest.fn() }));
jest.mock('../models/PersonalDataKey', () => ({ findOne: jest.fn(), create: jest.fn() }));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
// revert.js and tools/write.js top-require bottleOps (which pulls the search/
// meili chain) — mock the full surface they read at load, same as
// wineListTools.test.js.
jest.mock('../services/bottleOps', () => ({
  consumeBottle: jest.fn(), restoreBottle: jest.fn(), removeFromRacks: jest.fn(),
  RESTORE_WINDOW_MS: 2 * 24 * 60 * 60 * 1000,
  addBottle: jest.fn(), updateBottleFields: jest.fn(), removeBottleCascade: jest.fn(),
  UPDATABLE_FIELDS: ['price', 'currency', 'notes', 'occasion', 'rating', 'ratingScale', 'drinkFrom', 'drinkTo'],
}));

const Bottle = require('../models/Bottle');
const Cellar = require('../models/Cellar');
const McpActionLog = require('../models/McpActionLog');
const PersonalDataEntry = require('../models/PersonalDataEntry');
const PersonalDataKey = require('../models/PersonalDataKey');
const svc = require('../services/personalData');
const { logAudit } = require('../services/audit');
const { allTools } = require('./registry');
const { revertLedgerRow, WRITE_REVERSIBLE } = require('./revert');
require('./tools');

const oid = (c) => c.repeat(24);
const ME = oid('a');
const BOTTLE_ID = oid('b');
const CELLAR_ID = oid('c');
const WINE = oid('d');
const ENTRY = oid('e');
const KEY_ID = oid('f');
const CTX = { user: { id: ME, roles: ['user'] }, scopes: ['read', 'write'], req: { user: { id: ME }, headers: {}, apiToken: { id: 't1' } } };

const tool = (name) => allTools().find((t) => t.name === name);
const parse = (res) => JSON.parse(res.content[0].text);
const okHelpers = {
  ok: (summary, data) => ({ content: [{ type: 'text', text: JSON.stringify({ summary, ...data }) }] }),
  fail: (code, message) => ({ isError: true, content: [{ type: 'text', text: JSON.stringify({ error: { code, message } }) }] }),
};

const grantAccess = () => {
  Bottle.findById.mockResolvedValue({ _id: BOTTLE_ID, cellar: CELLAR_ID, wineDefinition: WINE });
  Cellar.findById.mockResolvedValue({ _id: CELLAR_ID, user: ME, members: [], deletedAt: null });
};
const denyAccess = () => {
  Bottle.findById.mockResolvedValue(null);
};

const svcEntry = (over = {}) => ({
  _id: ENTRY,
  level: 'wine',
  key: { _id: KEY_ID, name: 'ABV', type: 'decimal', unit: '%', enumOptions: null },
  value: 13.5,
  author: { _id: ME, username: 'johan', displayName: 'Johan' },
  createdAt: new Date('2026-08-17'),
  updatedAt: new Date('2026-08-17'),
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  McpActionLog.create.mockResolvedValue({});
  McpActionLog.findOne.mockReturnValue({ lean: () => Promise.resolve(null) });
});

describe('registration + scopes', () => {
  test('read tool is read-scoped, writes are write-scoped, undo covers personal_data', () => {
    expect(tool('list_personal_data').scope).toBe('read');
    expect(tool('add_personal_data').scope).toBe('write');
    expect(tool('update_personal_data').scope).toBe('write');
    expect(tool('delete_personal_data').scope).toBe('write');
    expect(tool('update_personal_key').scope).toBe('write');
    expect(tool('delete_personal_key').scope).toBe('write');
    expect(WRITE_REVERSIBLE).toContain('personal_data');
  });
});

describe('update_personal_key / delete_personal_key (ticket 6aa6c95e)', () => {
  const keyRow = { _id: KEY_ID, name: 'Falstaff', type: 'decimal', unit: '/100', enumOptions: null };

  test('rename delegates to the service and logs an undoable key_update row carrying the previous definition', async () => {
    svc.updateKey.mockResolvedValue({ ok: true, key: { ...keyRow, name: 'Falstaff score' }, prev: { name: 'Falstaff', unit: '/100' } });

    const res = await tool('update_personal_key').handler({ key_id: KEY_ID, name: 'Falstaff score' }, CTX);

    expect(svc.updateKey).toHaveBeenCalledWith(ME, KEY_ID, { name: 'Falstaff score', unit: undefined });
    const body = parse(res);
    expect(body.summary).toMatch(/renamed "Falstaff" → "Falstaff score"/);
    expect(body.data.key).toMatchObject({ key_id: KEY_ID, key: 'Falstaff score', unit: '/100' });
    expect(McpActionLog.create).toHaveBeenCalledWith(expect.objectContaining({
      tool: 'update_personal_key',
      action: 'personal_data',
      detail: expect.objectContaining({ op: 'key_update', keyId: KEY_ID }),
      prev: { name: 'Falstaff', unit: '/100' },
    }));
  });

  test('service refusals map to MCP codes: in_use → conflict, not_found → not_found', async () => {
    svc.updateKey.mockResolvedValue({ ok: false, code: 'in_use', message: 'holds entries' });
    expect(parse(await tool('update_personal_key').handler({ key_id: KEY_ID, unit: '/20' }, CTX)).error.code).toBe('conflict');
    svc.deleteKey.mockResolvedValue({ ok: false, code: 'not_found', message: 'Key not found' });
    expect(parse(await tool('delete_personal_key').handler({ key_id: KEY_ID }, CTX)).error.code).toBe('not_found');
    expect(McpActionLog.create).not.toHaveBeenCalled();
  });

  test('delete logs a key_delete row whose prev is the full definition (same id on undo)', async () => {
    const definition = { _id: KEY_ID, name: 'Falstaff', type: 'decimal', unit: '/100', enumOptions: undefined };
    svc.deleteKey.mockResolvedValue({ ok: true, key: keyRow, definition });

    const res = await tool('delete_personal_key').handler({ key_id: KEY_ID }, CTX);

    expect(parse(res).data).toMatchObject({ deleted: true, key_id: KEY_ID });
    expect(McpActionLog.create).toHaveBeenCalledWith(expect.objectContaining({
      tool: 'delete_personal_key',
      detail: expect.objectContaining({ op: 'key_delete', keyId: KEY_ID }),
      prev: definition,
    }));
  });

  test('undo of key_update restores name + unit; undo of key_delete recreates the key under the same id', async () => {
    McpActionLog.findOneAndUpdate.mockResolvedValue({ _id: 'row' });
    const saved = jest.fn().mockResolvedValue(undefined);
    PersonalDataKey.findOne.mockResolvedValue({ _id: KEY_ID, name: 'Falstaff score', nameKey: 'falstaff score', unit: '/20', save: saved });
    const up = await revertLedgerRow({
      _id: 'row', action: 'personal_data', tool: 'update_personal_key',
      detail: { op: 'key_update', keyId: KEY_ID, key: 'Falstaff score' }, prev: { name: 'Falstaff', unit: '/100' },
    }, CTX, okHelpers);
    // okHelpers.ok flattens data into the body (no .data wrapper).
    expect(parse(up)).toMatchObject({ undone: 'update_personal_key', restored: { name: 'Falstaff', unit: '/100' } });
    expect(saved).toHaveBeenCalled();

    PersonalDataKey.create.mockResolvedValue({ _id: KEY_ID, name: 'Falstaff' });
    const del = await revertLedgerRow({
      _id: 'row2', action: 'personal_data', tool: 'delete_personal_key',
      detail: { op: 'key_delete', keyId: KEY_ID, key: 'Falstaff' },
      prev: { _id: KEY_ID, name: 'Falstaff', type: 'decimal', unit: '/100' },
    }, CTX, okHelpers);
    expect(parse(del)).toMatchObject({ undone: 'delete_personal_key', key_id: KEY_ID });
    expect(PersonalDataKey.create).toHaveBeenCalledWith(expect.objectContaining({ _id: KEY_ID, user: ME, name: 'Falstaff', type: 'decimal', unit: '/100' }));
  });
});

describe('list_personal_data', () => {
  test('foreign bottle → not_found, service never called', async () => {
    denyAccess();
    const res = await tool('list_personal_data').handler({ bottle_id: BOTTLE_ID }, CTX);
    expect(res.isError).toBe(true);
    expect(parse(res).error.code).toBe('not_found');
    expect(svc.listForBottle).not.toHaveBeenCalled();
  });

  test('returns bottle + wine entries with attribution', async () => {
    grantAccess();
    svc.listForBottle.mockResolvedValue({
      ok: true,
      bottleEntries: [svcEntry({ level: 'bottle' })],
      wineEntries: [svcEntry({ author: { _id: oid('9'), username: 'kurt', displayName: null } })],
    });
    const res = await tool('list_personal_data').handler({ bottle_id: BOTTLE_ID }, CTX);
    const body = parse(res).data;
    expect(body.bottle_entries[0]).toMatchObject({ key: 'ABV', value: 13.5, unit: '%', author: 'Johan' });
    expect(body.wine_entries[0].author).toBe('kurt');
  });
});

describe('add_personal_data', () => {
  test('delegates to the shared service and logs an undoable create row', async () => {
    grantAccess();
    svc.createEntry.mockResolvedValue({ ok: true, entry: svcEntry(), keyCreated: true });

    const res = await tool('add_personal_data').handler({
      bottle_id: BOTTLE_ID, level: 'wine', key: 'ABV', key_type: 'decimal', unit: '%', value: 13.5,
    }, CTX);

    expect(svc.createEntry).toHaveBeenCalledWith(ME, expect.objectContaining({ _id: BOTTLE_ID }), {
      level: 'wine',
      vintageScoped: false,
      newKey: { name: 'ABV', type: 'decimal', unit: '%', enumOptions: undefined },
      value: 13.5,
    });
    expect(parse(res).data.entry.entry_id).toBe(ENTRY);
    expect(logAudit).toHaveBeenCalledWith(CTX.req, 'personal_data.entry_create',
      expect.objectContaining({ type: 'wine' }), expect.objectContaining({ via: 'mcp' }));
    expect(McpActionLog.create).toHaveBeenCalledWith(expect.objectContaining({
      tool: 'add_personal_data',
      action: 'personal_data',
      detail: expect.objectContaining({ op: 'create', entryId: ENTRY }),
    }));
  });

  test('service type_conflict maps to MCP conflict', async () => {
    grantAccess();
    svc.createEntry.mockResolvedValue({ ok: false, code: 'type_conflict', message: 'one type per key' });
    const res = await tool('add_personal_data').handler({
      bottle_id: BOTTLE_ID, level: 'wine', key: 'ABV', key_type: 'text', value: 'high',
    }, CTX);
    expect(parse(res).error.code).toBe('conflict');
    expect(McpActionLog.create).not.toHaveBeenCalled();
  });

  test('missing key_type on a NEW key gets the guidance suffix', async () => {
    grantAccess();
    svc.createEntry.mockResolvedValue({ ok: false, code: 'invalid', message: 'Key type must be one of: …' });
    const res = await tool('add_personal_data').handler({
      bottle_id: BOTTLE_ID, level: 'wine', key: 'ABV', value: 13.5,
    }, CTX);
    expect(parse(res).error.message).toContain('pass key_type');
  });
});

describe('update_personal_data', () => {
  test('prev value rides the ledger row for undo', async () => {
    svc.updateEntry.mockResolvedValue({ ok: true, entry: svcEntry({ value: 14 }), prevValue: 13.5 });
    const res = await tool('update_personal_data').handler({ entry_id: ENTRY, value: 14 }, CTX);
    expect(svc.updateEntry).toHaveBeenCalledWith(ME, ENTRY, 14);
    expect(parse(res).data.entry.value).toBe(14);
    expect(McpActionLog.create).toHaveBeenCalledWith(expect.objectContaining({
      action: 'personal_data',
      detail: expect.objectContaining({ op: 'update' }),
      prev: { value: 13.5 },
    }));
  });

  test("someone else's entry → not_found", async () => {
    svc.updateEntry.mockResolvedValue({ ok: false, code: 'not_found', message: 'Entry not found' });
    const res = await tool('update_personal_data').handler({ entry_id: ENTRY, value: 14 }, CTX);
    expect(parse(res).error.code).toBe('not_found');
  });
});

describe('delete_personal_data', () => {
  test('ledger prev carries the full recreate snapshot', async () => {
    svc.deleteEntry.mockResolvedValue({
      ok: true,
      entry: svcEntry(),
      target: { wineDefinition: WINE, bottle: null },
    });
    await tool('delete_personal_data').handler({ entry_id: ENTRY }, CTX);
    expect(McpActionLog.create).toHaveBeenCalledWith(expect.objectContaining({
      action: 'personal_data',
      detail: expect.objectContaining({ op: 'delete', entryId: ENTRY }),
      prev: { keyId: KEY_ID, level: 'wine', value: 13.5, wineDefinition: WINE, bottle: null },
    }));
  });
});

describe('revert: personal_data', () => {
  const baseRow = (over = {}) => ({
    _id: oid('7'), action: 'personal_data', bottle: BOTTLE_ID, cellar: CELLAR_ID,
    reversed: false, ...over,
  });

  test('create op → author-scoped delete of the entry', async () => {
    McpActionLog.findOneAndUpdate.mockResolvedValue(baseRow());
    PersonalDataEntry.findOneAndDelete.mockResolvedValue({ _id: ENTRY });

    const res = await revertLedgerRow(
      baseRow({ detail: { op: 'create', entryId: ENTRY, key: 'ABV' } }), CTX, okHelpers
    );
    expect(PersonalDataEntry.findOneAndDelete).toHaveBeenCalledWith({ _id: ENTRY, author: ME });
    expect(parse(res).entry_removed).toBe(true);
  });

  test('update op → restores prev value on the author’s own entry', async () => {
    const doc = { value: 14, save: jest.fn().mockResolvedValue(undefined) };
    PersonalDataEntry.findOne.mockResolvedValue(doc);
    McpActionLog.findOneAndUpdate.mockResolvedValue(baseRow());

    const res = await revertLedgerRow(
      baseRow({ detail: { op: 'update', entryId: ENTRY, key: 'ABV' }, prev: { value: 13.5 } }),
      CTX, okHelpers
    );
    expect(PersonalDataEntry.findOne).toHaveBeenCalledWith({ _id: ENTRY, author: ME });
    expect(doc.value).toBe(13.5);
    expect(doc.save).toHaveBeenCalled();
    expect(parse(res).restored).toBe(13.5);
  });

  test('delete op → recreates the entry from the snapshot (key must still exist)', async () => {
    PersonalDataKey.findOne.mockResolvedValue({ _id: KEY_ID });
    McpActionLog.findOneAndUpdate.mockResolvedValue(baseRow());
    PersonalDataEntry.create.mockResolvedValue({ _id: oid('8') });

    const res = await revertLedgerRow(
      baseRow({
        detail: { op: 'delete', entryId: ENTRY, key: 'ABV' },
        prev: { keyId: KEY_ID, level: 'wine', value: 13.5, wineDefinition: WINE, bottle: null },
      }),
      CTX, okHelpers
    );
    expect(PersonalDataEntry.create).toHaveBeenCalledWith({
      author: ME, key: KEY_ID, targetType: 'wine', wineDefinition: WINE, value: 13.5,
    });
    expect(parse(res).undone).toBe('delete_personal_data');
  });

  test('delete op with a purged key → conflict, nothing recreated', async () => {
    PersonalDataKey.findOne.mockResolvedValue(null);
    const res = await revertLedgerRow(
      baseRow({ detail: { op: 'delete', entryId: ENTRY, key: 'ABV' }, prev: { keyId: KEY_ID } }),
      CTX, okHelpers
    );
    expect(res.isError).toBe(true);
    expect(PersonalDataEntry.create).not.toHaveBeenCalled();
  });
});
