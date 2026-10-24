/**
 * add_grape / edit_grape — grape claims fold through the static alias map.
 *
 * set_wine_profile resolves "Shiraz" to Syrah through utils/normalize's alias
 * map before it looks a variety up. The taxonomy tools fold the same way: a
 * claim probe for "Shiraz" asks for 'syrah', edit_grape finds Syrah by its
 * alias, and add_grape stores an alias under its canonical name and says so.
 *
 * The claim helper (services/grapeClaims) is the real one; only the models
 * under it are mocked.
 */

const chain = (result) => {
  const c = {};
  for (const m of ['populate', 'sort', 'skip', 'limit', 'select']) c[m] = jest.fn(() => c);
  c.lean = jest.fn(() => Promise.resolve(result));
  c.then = (res, rej) => Promise.resolve(result).then(res, rej);
  return c;
};

jest.mock('../models/Grape', () => {
  const ctor = jest.fn(function (doc) {
    Object.assign(this, doc);
    this._id = this._id || 'b'.repeat(24);
    this.save = jest.fn().mockResolvedValue(this);
  });
  ctor.findOne = jest.fn();
  return ctor;
});
jest.mock('../models/Country', () => ({ findOne: jest.fn(), exists: jest.fn() }));
jest.mock('../models/Region', () => ({ findOne: jest.fn(), findById: jest.fn() }));
jest.mock('../models/McpActionLog', () => ({ create: jest.fn(), findOne: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../services/search', () => ({
  fullSync: jest.fn().mockResolvedValue([]),
  indexWine: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../routes/taxonomy', () => ({ clearTaxonomyListCache: jest.fn() }));

const Grape = require('../models/Grape');
const McpActionLog = require('../models/McpActionLog');
const { allTools } = require('./registry');
require('./tools/somm');

const oid = (c) => c.repeat(24);
const ME = oid('a');
const SOMM_CTX = { user: { id: ME, roles: ['somm'] }, scopes: ['read', 'write'], req: { user: { id: ME, roles: ['somm'] }, headers: {}, apiToken: { id: 't1' } } };

const tool = (name) => allTools().find((t) => t.name === name);
const parse = (res) => JSON.parse(res.content[0].text);

// The keys a claim probe asked for: { normalizedName: { $in } } in add_grape's
// and edit_grape's synonym probes.
const probedKeys = (call) => call[0].$or[0].normalizedName.$in;

beforeEach(() => {
  jest.clearAllMocks();
  McpActionLog.create.mockResolvedValue({});
});

describe('add_grape — a static alias is its canonical variety', () => {
  test('the claim probe asks for the canonical key, and an existing Syrah is the conflict', async () => {
    Grape.findOne.mockReturnValue(chain({ name: 'Syrah', synonyms: [] }));

    const body = parse(await tool('add_grape').handler({ name: 'Shiraz', colour: 'Red' }, SOMM_CTX));

    expect(probedKeys(Grape.findOne.mock.calls[0])).toContain('syrah');
    expect(probedKeys(Grape.findOne.mock.calls[0])).not.toContain('shiraz');
    expect(body.error.code).toBe('conflict');
    expect(body.error.message).toMatch(/"Syrah"/);
    expect(Grape).not.toHaveBeenCalled();
  });

  test('with no Syrah yet, the row is stored as Syrah and the reply names the substitution', async () => {
    Grape.findOne.mockReturnValue(chain(null));

    const body = parse(await tool('add_grape').handler({ name: 'Shiraz', colour: 'Red' }, SOMM_CTX));

    expect(body.error).toBeUndefined();
    expect(Grape.mock.calls[0][0]).toMatchObject({ name: 'Syrah', normalizedName: 'syrah' });
    expect(body.data.name).toBe('Syrah');
    expect(body.data.substitution).toBe('Shiraz → Syrah');
    expect(body.summary).toMatch(/"Shiraz".*Syrah/);
  });

  test('a synonym that repeats the canonical name the alias resolves to is dropped', async () => {
    Grape.findOne.mockReturnValue(chain(null));

    const body = parse(await tool('add_grape').handler(
      { name: 'Vidal', colour: 'White', synonyms: ['Vidal Blanc'] }, SOMM_CTX));

    expect(body.error).toBeUndefined();
    expect(Grape.mock.calls[0][0]).toMatchObject({ name: 'Vidal Blanc', normalizedName: 'vidal blanc', synonyms: [] });
    expect(body.data.substitution).toBe('Vidal → Vidal Blanc');
  });

  test('a synonym that is an alias of another variety is claimed under that variety', async () => {
    Grape.findOne.mockReturnValue(chain({ name: 'Zinfandel', synonyms: [] }));

    const body = parse(await tool('add_grape').handler(
      { name: 'Tinta Cão', colour: 'Red', synonyms: ['Primitivo'] }, SOMM_CTX));

    expect(probedKeys(Grape.findOne.mock.calls[0])).toEqual(['tinta cao', 'zinfandel']);
    expect(body.error.code).toBe('conflict');
    expect(body.error.message).toMatch(/Zinfandel/);
  });

  test('a name that is not an alias is stored as typed, with no substitution', async () => {
    Grape.findOne.mockReturnValue(chain(null));

    const body = parse(await tool('add_grape').handler({ name: 'St. Pepin', colour: 'White' }, SOMM_CTX));

    expect(body.error).toBeUndefined();
    expect(Grape.mock.calls[0][0].name).toBe('St. Pepin');
    expect(body.data.substitution).toBeUndefined();
  });
});

describe('edit_grape — the variety and its synonym claims resolve through the alias map', () => {
  const grapeDoc = (over = {}) => ({
    _id: oid('e'), name: 'Syrah', color: null, synonyms: [], regionalNames: [],
    origin: null, description: '', save: jest.fn().mockResolvedValue(true), ...over,
  });

  test('edit_grape("Shiraz") looks up syrah and edits the Syrah row', async () => {
    const doc = grapeDoc();
    Grape.findOne.mockResolvedValueOnce(doc);

    const body = parse(await tool('edit_grape').handler({ grape: 'Shiraz', colour: 'Red' }, SOMM_CTX));

    expect(Grape.findOne).toHaveBeenCalledWith({ $or: [{ normalizedName: 'syrah' }, { normalizedSynonyms: 'syrah' }] });
    expect(body.error).toBeUndefined();
    expect(doc.color).toBe('Red');
    expect(doc.save).toHaveBeenCalled();
  });

  test('add_synonyms ["Primitivo"] on another variety is claim-checked as zinfandel', async () => {
    const doc = grapeDoc({ _id: oid('f'), name: 'Tinta Cão' });
    Grape.findOne
      .mockResolvedValueOnce(doc)
      .mockReturnValueOnce(chain({ name: 'Zinfandel', synonyms: [] }));

    const body = parse(await tool('edit_grape').handler({ grape: 'Tinta Cão', add_synonyms: ['Primitivo'] }, SOMM_CTX));

    const probe = Grape.findOne.mock.calls[1];
    expect(probe[0]._id).toEqual({ $ne: oid('f') });
    expect(probedKeys(probe)).toEqual(['zinfandel']);
    expect(body.error.code).toBe('conflict');
    expect(body.error.message).toMatch(/Zinfandel/);
    expect(doc.save).not.toHaveBeenCalled();
  });
});
