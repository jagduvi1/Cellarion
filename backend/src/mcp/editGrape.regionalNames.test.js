/**
 * edit_grape / add_grape — the regional-name rules and the follow-through
 * the admin grape editor already has.
 *
 * Regional names run through the admin editor's own validator
 * (services/grapeRegionalNames) over the whole list as it will be saved: one
 * display name per (country, region) and at most 20. After a save the public
 * taxonomy list cache is cleared, and a new regional name rebuilds the
 * registry search index, which carries regional names for recall.
 *
 * The validator is the real one; only the models under it are mocked.
 */

const chain = (result) => {
  const c = {};
  for (const m of ['populate', 'sort', 'skip', 'limit', 'select']) c[m] = jest.fn(() => c);
  c.lean = jest.fn(() => Promise.resolve(result));
  c.then = (res, rej) => Promise.resolve(result).then(res, rej);
  return c;
};

jest.mock('../models/Grape', () => {
  // Constructable (add_grape does `new Grape().save()`) with the findOne
  // static edit_grape and the add_grape claim probe use.
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
const Country = require('../models/Country');
const Region = require('../models/Region');
const McpActionLog = require('../models/McpActionLog');
const { fullSync } = require('../services/search');
const { clearTaxonomyListCache } = require('../routes/taxonomy');
const { allTools } = require('./registry');
require('./tools/somm');

const oid = (c) => c.repeat(24);
const ME = oid('a');
const SOMM_CTX = { user: { id: ME, roles: ['somm'] }, scopes: ['read', 'write'], req: { user: { id: ME, roles: ['somm'] }, headers: {}, apiToken: { id: 't1' } } };

const tool = (name) => allTools().find((t) => t.name === name);
const parse = (res) => JSON.parse(res.content[0].text);

const AUSTRALIA = { _id: oid('1'), name: 'Australia' };
const SPAIN = { _id: oid('2'), name: 'Spain' };
const RIOJA = { _id: oid('3'), name: 'Rioja', country: SPAIN._id };

const grapeDoc = (over = {}) => ({
  _id: oid('e'), name: 'Petite Sirah', color: 'Red', synonyms: [], regionalNames: [],
  origin: null, description: '', save: jest.fn().mockResolvedValue(true), ...over,
});

// The lookups edit_grape makes by name, then the ref checks the validator
// makes by id.
const places = ({ country, region = null }) => {
  Country.findOne.mockReturnValue(chain(country));
  Region.findOne.mockReturnValue(chain(region));
  Country.exists.mockResolvedValue({ _id: country._id });
  Region.findById.mockImplementation((id) => chain(String(id) === RIOJA._id ? RIOJA : null));
};

beforeEach(() => {
  jest.clearAllMocks();
  McpActionLog.create.mockResolvedValue({});
});

describe('edit_grape regional names — one display name per place', () => {
  test('a second display name for the same country is refused and nothing is saved', async () => {
    const doc = grapeDoc({ regionalNames: [{ country: AUSTRALIA._id, region: null, name: 'Durif' }] });
    Grape.findOne.mockResolvedValueOnce(doc);
    places({ country: AUSTRALIA });

    const body = parse(await tool('edit_grape').handler(
      { grape: 'Petite Sirah', regional_name: 'Petite Syrah', country: 'Australia' }, SOMM_CTX));

    expect(body.error.code).toBe('conflict');
    expect(body.error.message).toMatch(/one display name/);
    expect(doc.regionalNames).toEqual([{ country: AUSTRALIA._id, region: null, name: 'Durif' }]);
    expect(doc.save).not.toHaveBeenCalled();
    expect(fullSync).not.toHaveBeenCalled();
    expect(clearTaxonomyListCache).not.toHaveBeenCalled();
  });

  test('a second display name for the same region is refused', async () => {
    const doc = grapeDoc({ name: 'Carignan', regionalNames: [{ country: SPAIN._id, region: RIOJA._id, name: 'Mazuelo' }] });
    Grape.findOne.mockResolvedValueOnce(doc);
    places({ country: SPAIN, region: RIOJA });

    const body = parse(await tool('edit_grape').handler(
      { grape: 'Carignan', regional_name: 'Cariñena', country: 'Spain', region: 'Rioja' }, SOMM_CTX));

    expect(body.error.code).toBe('conflict');
    expect(doc.save).not.toHaveBeenCalled();
  });

  test('a country-wide name and a region name are two places — both are kept', async () => {
    const doc = grapeDoc({ name: 'Carignan', regionalNames: [{ country: SPAIN._id, region: null, name: 'Cariñena' }] });
    Grape.findOne.mockResolvedValueOnce(doc);
    places({ country: SPAIN, region: RIOJA });

    const body = parse(await tool('edit_grape').handler(
      { grape: 'Carignan', regional_name: 'Mazuelo', country: 'Spain', region: 'Rioja' }, SOMM_CTX));

    expect(body.error).toBeUndefined();
    // The existing entries ride along to the validator and are saved with the new one.
    expect(doc.regionalNames).toEqual([
      { country: SPAIN._id, region: null, name: 'Cariñena' },
      { country: SPAIN._id, region: RIOJA._id, name: 'Mazuelo' },
    ]);
    expect(doc.save).toHaveBeenCalled();
  });

  test('the same name for the same place again is a no-op, not a conflict', async () => {
    const doc = grapeDoc({ regionalNames: [{ country: AUSTRALIA._id, region: null, name: 'Durif' }] });
    Grape.findOne.mockResolvedValueOnce(doc);
    places({ country: AUSTRALIA });

    const body = parse(await tool('edit_grape').handler(
      { grape: 'Petite Sirah', regional_name: 'durif', country: 'Australia' }, SOMM_CTX));

    expect(body.error).toBeUndefined();
    expect(body.summary).toMatch(/Nothing to change/);
    expect(doc.save).not.toHaveBeenCalled();
    expect(fullSync).not.toHaveBeenCalled();
    expect(clearTaxonomyListCache).not.toHaveBeenCalled();
  });

  test('a 21st regional name is refused — the admin editor caps the list at 20', async () => {
    const full = Array.from({ length: 20 }, (_, i) => ({
      country: (i + 10).toString(16).padStart(24, '0'), region: null, name: `Name ${i}`,
    }));
    const doc = grapeDoc({ regionalNames: full });
    Grape.findOne.mockResolvedValueOnce(doc);
    places({ country: AUSTRALIA });

    const body = parse(await tool('edit_grape').handler(
      { grape: 'Petite Sirah', regional_name: 'Durif', country: 'Australia' }, SOMM_CTX));

    expect(body.error.code).toBe('conflict');
    expect(body.error.message).toMatch(/20/);
    expect(doc.save).not.toHaveBeenCalled();
  });
});

describe('edit_grape / add_grape follow-through after a save', () => {
  test('a new regional name rebuilds the search index and clears the public list cache', async () => {
    const doc = grapeDoc();
    Grape.findOne.mockResolvedValueOnce(doc);
    places({ country: AUSTRALIA });

    const body = parse(await tool('edit_grape').handler(
      { grape: 'Petite Sirah', regional_name: 'Durif', country: 'Australia' }, SOMM_CTX));

    expect(body.error).toBeUndefined();
    expect(doc.save).toHaveBeenCalled();
    expect(fullSync).toHaveBeenCalledTimes(1);
    expect(clearTaxonomyListCache).toHaveBeenCalledTimes(1);
  });

  test('a colour-only edit clears the public list cache but does not rebuild the index', async () => {
    const doc = grapeDoc({ color: null });
    Grape.findOne.mockResolvedValueOnce(doc);

    const body = parse(await tool('edit_grape').handler({ grape: 'Petite Sirah', colour: 'Red' }, SOMM_CTX));

    expect(body.error).toBeUndefined();
    expect(doc.save).toHaveBeenCalled();
    expect(clearTaxonomyListCache).toHaveBeenCalledTimes(1);
    expect(fullSync).not.toHaveBeenCalled();
  });

  test('add_grape clears the public list cache', async () => {
    Grape.findOne.mockReturnValue(chain(null));

    const body = parse(await tool('add_grape').handler({ name: 'Norton', colour: 'Red' }, SOMM_CTX));

    expect(body.error).toBeUndefined();
    expect(clearTaxonomyListCache).toHaveBeenCalledTimes(1);
    expect(fullSync).not.toHaveBeenCalled();
  });

  test('add_grape that creates nothing leaves the cache alone', async () => {
    Grape.findOne.mockReturnValue(chain({ name: 'Norton', synonyms: ['Cynthiana'] }));

    const body = parse(await tool('add_grape').handler({ name: 'Cynthiana', colour: 'Red' }, SOMM_CTX));

    expect(body.error.code).toBe('conflict');
    expect(clearTaxonomyListCache).not.toHaveBeenCalled();
  });
});
