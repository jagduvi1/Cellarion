/**
 * Wine-list MCP tools (plan §3.13) — list/get/add/update + undo.
 *
 * Pins: the read/write scope split; ownership scoping on every query; the
 * custom-vs-auto container rules (section required when ambiguous, created
 * when new); duplicate-entry conflict; the suggested-glass-price rule;
 * idempotent replay; prev snapshots; and both revert branches (entry pulled
 * on winelist_add undo, prices restored on winelist_price undo).
 */

jest.mock('../models/WineList', () => ({ findOne: jest.fn(), find: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../models/WineDefinition', () => ({ findById: jest.fn() }));
jest.mock('../models/McpActionLog', () => ({ create: jest.fn(), findOne: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
// revert.js and tools/write.js top-require bottleOps (which pulls the search/
// meili chain) — mock the full surface they read at load, same as
// sommTools.test.js (write.js joins UPDATABLE_FIELDS into its description).
jest.mock('../services/bottleOps', () => ({
  consumeBottle: jest.fn(), restoreBottle: jest.fn(), removeFromRacks: jest.fn(),
  RESTORE_WINDOW_MS: 2 * 24 * 60 * 60 * 1000,
  addBottle: jest.fn(), updateBottleFields: jest.fn(), removeBottleCascade: jest.fn(),
  UPDATABLE_FIELDS: ['price', 'currency', 'notes', 'occasion', 'rating', 'ratingScale', 'drinkFrom', 'drinkTo'],
}));

const WineList = require('../models/WineList');
const WineDefinition = require('../models/WineDefinition');
const McpActionLog = require('../models/McpActionLog');
const { logAudit } = require('../services/audit');
const { allTools } = require('./registry');
const { revertLedgerRow, WRITE_REVERSIBLE } = require('./revert');
require('./tools');

const oid = (c) => c.repeat(24);
const ME = oid('a');
const LIST = oid('1');
const WINE = oid('e');
const CTX = { user: { id: ME, roles: ['user'] }, scopes: ['read', 'write'], req: { user: { id: ME }, headers: {}, apiToken: { id: 't1' } } };

const tool = (name) => allTools().find((t) => t.name === name);
const parse = (res) => JSON.parse(res.content[0].text);

const chain = (result) => {
  const c = {};
  for (const m of ['populate', 'sort', 'skip', 'limit', 'select']) c[m] = jest.fn(() => c);
  c.lean = jest.fn(() => Promise.resolve(result));
  c.then = (res, rej) => Promise.resolve(result).then(res, rej);
  return c;
};

const makeList = (over = {}) => ({
  _id: LIST,
  user: ME,
  cellar: oid('c'),
  name: 'Chez Marie',
  structureMode: 'auto',
  sections: [],
  autoGroupEntries: [],
  layout: { glassesPerBottle: 5, glassMarkup: 20, glassRounding: '1', currency: 'EUR' },
  save: jest.fn().mockResolvedValue(undefined),
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  McpActionLog.create.mockResolvedValue({});
  McpActionLog.findOne.mockReturnValue({ lean: () => Promise.resolve(null) });
  WineDefinition.findById.mockReturnValue({ populate: jest.fn(() => Promise.resolve({ _id: WINE, name: 'Barolo Riserva', producer: 'Rinaldi' })) });
});

describe('registration + scopes', () => {
  test('reads are read-scoped, writes are write-scoped, undo covers both actions', () => {
    expect(tool('list_wine_lists').scope).toBe('read');
    expect(tool('get_wine_list').scope).toBe('read');
    expect(tool('add_to_list').scope).toBe('write');
    expect(tool('update_list_pricing').scope).toBe('write');
    expect(tool('add_to_list').annotations.readOnlyHint).toBe(false);
    expect(WRITE_REVERSIBLE).toEqual(expect.arrayContaining(['winelist_add', 'winelist_price']));
  });
});

describe('list_wine_lists / get_wine_list', () => {
  test('lists only the caller\'s lists with per-mode entry counts', async () => {
    WineList.countDocuments.mockResolvedValue(2);
    WineList.find.mockReturnValue(chain([
      { _id: LIST, name: 'Custom', structureMode: 'custom', sections: [{ entries: [{}, {}] }, { entries: [{}] }], autoGroupEntries: [{}], isPublished: true, layout: { currency: 'EUR' }, updatedAt: new Date() },
      { _id: oid('2'), name: 'Auto', structureMode: 'auto', sections: [], autoGroupEntries: [{}, {}], isPublished: false, layout: {}, updatedAt: new Date() },
    ]));
    const { data } = parse(await tool('list_wine_lists').handler({}, CTX));
    expect(WineList.find).toHaveBeenCalledWith({ user: ME });
    expect(data[0].entry_count).toBe(3);  // custom mode counts sections only
    expect(data[1].entry_count).toBe(2);  // auto mode counts the flat list
    expect(data[0].is_published).toBe(true);
  });

  test('get_wine_list is ownership-scoped and 404s on a foreign id', async () => {
    WineList.findOne.mockReturnValue(chain(null));
    const res = await tool('get_wine_list').handler({ list_id: LIST }, CTX);
    expect(WineList.findOne).toHaveBeenCalledWith({ _id: LIST, user: ME });
    expect(parse(res).error.code).toBe('not_found');
  });

  test('get_wine_list groups custom-mode entries by section', async () => {
    WineList.findOne.mockReturnValue(chain(makeList({
      structureMode: 'custom',
      sections: [{ title: 'Reds', entries: [{ wine: { _id: WINE, name: 'Barolo' }, vintage: '2019', listPrice: 95, byGlass: false }] }],
    })));
    const { data } = parse(await tool('get_wine_list').handler({ list_id: LIST }, CTX));
    expect(data.sections).toEqual([expect.objectContaining({ section: 'Reds' })]);
    expect(data.sections[0].entries[0]).toMatchObject({ vintage: '2019', list_price: 95, by_glass: false });
    expect(data.glass_pricing_rule).toEqual({ glasses_per_bottle: 5, markup_percent: 20, rounding: '1' });
  });
});

describe('add_to_list', () => {
  test('unknown wine → not_found', async () => {
    WineList.findOne.mockResolvedValue(makeList());
    WineDefinition.findById.mockReturnValue({ populate: jest.fn(() => Promise.resolve(null)) });
    const res = await tool('add_to_list').handler({ list_id: LIST, wine_id: WINE }, CTX);
    expect(parse(res).error.code).toBe('not_found');
  });

  test('duplicate wine+vintage+size → conflict pointing at update_list_pricing', async () => {
    WineList.findOne.mockResolvedValue(makeList({
      autoGroupEntries: [{ wine: WINE, vintage: '2019', bottleSize: '750ml' }],
    }));
    const res = await tool('add_to_list').handler({ list_id: LIST, wine_id: WINE, vintage: '2019' }, CTX);
    const { error } = parse(res);
    expect(error.code).toBe('conflict');
    expect(error.message).toContain('update_list_pricing');
  });

  test('auto mode appends with the SUGGESTED glass price and records the ledger row', async () => {
    const list = makeList();
    WineList.findOne.mockResolvedValue(list);
    const res = await tool('add_to_list').handler(
      { list_id: LIST, wine_id: WINE, vintage: '2019', list_price: 100, by_glass: true, idempotency_key: 'k1' }, CTX
    );
    const { data } = parse(res);
    // 100 / 5 glasses × 1.20 markup = 24
    expect(data.glass_price).toBe(24);
    expect(data.glass_price_suggested).toBe(true);
    expect(list.autoGroupEntries).toHaveLength(1);
    expect(list.autoGroupEntries[0]).toMatchObject({ wine: WINE, vintage: '2019', listPrice: 100, byGlass: true, glassPrice: 24, glassPriceManual: false });
    expect(list.save).toHaveBeenCalled();
    // Keyed ledger writes complete the pending claim (claim-first, M2).
    const [lQuery, lUpdate] = McpActionLog.findOneAndUpdate.mock.calls.at(-1);
    expect(lQuery).toEqual({ user: ME, tool: 'add_to_list', idempotencyKey: 'k1', pending: true });
    expect(lUpdate.$set).toMatchObject({
      tokenId: 't1', tool: 'add_to_list', action: 'winelist_add', idempotencyKey: 'k1', pending: false,
      detail: expect.objectContaining({ listId: LIST, wineId: WINE, vintage: '2019' }),
    });
    expect(logAudit).toHaveBeenCalledWith(CTX.req, 'winelist.entry.add', expect.any(Object), expect.objectContaining({ via: 'mcp' }));
  });

  test('custom mode with several sections demands a section name, creates new ones', async () => {
    const list = makeList({ structureMode: 'custom', sections: [
      { title: 'Reds', sortOrder: 0, entries: [] }, { title: 'Whites', sortOrder: 1, entries: [] },
    ] });
    WineList.findOne.mockResolvedValue(list);

    const noSection = await tool('add_to_list').handler({ list_id: LIST, wine_id: WINE }, CTX);
    expect(parse(noSection).error.code).toBe('invalid_input');
    expect(parse(noSection).error.message).toContain('"Reds"');

    const created = await tool('add_to_list').handler({ list_id: LIST, wine_id: WINE, section: 'Piedmont' }, CTX);
    expect(parse(created).data.section).toBe('Piedmont');
    expect(list.sections).toHaveLength(3);
    expect(list.sections[2].entries).toHaveLength(1);
  });

  test('idempotent replay returns the stored envelope without touching the list', async () => {
    // Claim-first replay (prior-audit M2).
    McpActionLog.findOneAndUpdate.mockResolvedValueOnce({
      lastErrorObject: { updatedExisting: true },
      value: { pending: false, result: { summary: 'done before', data: {} } },
    });
    const res = await tool('add_to_list').handler({ list_id: LIST, wine_id: WINE, idempotency_key: 'k1' }, CTX);
    expect(parse(res).summary).toBe('done before');
    expect(WineList.findOne).not.toHaveBeenCalled();
  });
});

describe('update_list_pricing', () => {
  test('no fields → invalid_input; ambiguous match names the variants', async () => {
    const empty = await tool('update_list_pricing').handler({ list_id: LIST, wine_id: WINE }, CTX);
    expect(parse(empty).error.code).toBe('invalid_input');

    WineList.findOne.mockResolvedValue(makeList({
      autoGroupEntries: [
        { wine: WINE, vintage: '2019', bottleSize: '750ml' },
        { wine: WINE, vintage: '2020', bottleSize: '750ml' },
      ],
    }));
    const ambiguous = await tool('update_list_pricing').handler({ list_id: LIST, wine_id: WINE, list_price: 90 }, CTX);
    const { error } = parse(ambiguous);
    expect(error.code).toBe('invalid_input');
    expect(error.message).toContain('2019');
    expect(error.message).toContain('2020');
  });

  test('applies changes, derives glass price when turned on, snapshots prev for undo', async () => {
    const entry = { wine: WINE, vintage: '2019', bottleSize: '750ml', listPrice: 80, byGlass: false };
    const list = makeList({ autoGroupEntries: [entry] });
    WineList.findOne.mockResolvedValue(list);

    const res = await tool('update_list_pricing').handler({ list_id: LIST, wine_id: WINE, list_price: 100, by_glass: true }, CTX);
    const { data } = parse(res);
    expect(data.list_price).toBe(100);
    expect(data.glass_price).toBe(24); // 100 / 5 × 1.20
    expect(entry.glassPriceManual).toBe(false);
    expect(McpActionLog.create).toHaveBeenCalledWith(expect.objectContaining({
      action: 'winelist_price',
      prev: { listPrice: 80, byGlass: false, glassPrice: null, glassPriceManual: false },
    }));
  });
});

describe('undo (revertLedgerRow branches)', () => {
  const helpers = { ok: (summary, data) => ({ ok: true, summary, data }), fail: (code, message) => ({ ok: false, code, message }) };
  const row = (action, extra = {}) => ({
    _id: oid('f'), action, cellar: oid('c'),
    detail: { listId: LIST, listName: 'Chez Marie', wineId: WINE, vintage: '2019', bottleSize: '750ml' },
    ...extra,
  });

  test('winelist_add undo pulls the entry back out of its section', async () => {
    const list = makeList({ structureMode: 'custom', sections: [
      { title: 'Reds', entries: [{ wine: WINE, vintage: '2019', bottleSize: '750ml' }] },
    ] });
    WineList.findOne.mockResolvedValue(list);
    McpActionLog.findOneAndUpdate.mockResolvedValue({ _id: oid('f') });

    const res = await revertLedgerRow(row('winelist_add'), CTX, helpers);
    expect(res.ok).toBe(true);
    expect(res.data.entry_removed).toBe(true);
    expect(list.sections[0].entries).toHaveLength(0);
    expect(list.save).toHaveBeenCalled();
    expect(McpActionLog.findOneAndUpdate).toHaveBeenCalledWith({ _id: oid('f'), reversed: false }, expect.any(Object));
  });

  test('winelist_add undo with the entry already gone still resolves (already gone)', async () => {
    WineList.findOne.mockResolvedValue(makeList());
    McpActionLog.findOneAndUpdate.mockResolvedValue({ _id: oid('f') });
    const res = await revertLedgerRow(row('winelist_add'), CTX, helpers);
    expect(res.ok).toBe(true);
    expect(res.data.entry_removed).toBe(false);
  });

  test('winelist_price undo restores the prev snapshot, conflicts when the entry is gone', async () => {
    const entry = { wine: WINE, vintage: '2019', bottleSize: '750ml', listPrice: 100, byGlass: true, glassPrice: 24 };
    const list = makeList({ autoGroupEntries: [entry] });
    WineList.findOne.mockResolvedValue(list);
    McpActionLog.findOneAndUpdate.mockResolvedValue({ _id: oid('f') });

    const res = await revertLedgerRow(
      row('winelist_price', { prev: { listPrice: 80, byGlass: false, glassPrice: null, glassPriceManual: false } }),
      CTX, helpers
    );
    expect(res.ok).toBe(true);
    expect(entry.listPrice).toBe(80);
    expect(entry.byGlass).toBe(false);
    expect(entry.glassPrice).toBeUndefined();

    WineList.findOne.mockResolvedValue(makeList()); // entry gone now
    const gone = await revertLedgerRow(row('winelist_price', { prev: {} }), CTX, helpers);
    expect(gone.ok).toBe(false);
    expect(gone.code).toBe('conflict');
  });
});
