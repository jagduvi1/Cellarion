/**
 * registryDataOps.updateKey / removeKey — an admin changing the public
 * vocabulary itself.
 *
 * WHY THIS TEST EXISTS:
 * A self-hoster created "ABV" as a text field by mistake (discussion #1778)
 * and found no way to change its type or remove it: a key's definition was
 * fixed by its proposal. Changing it must never leave a stored value outside
 * its key's definition — every value is read again under the new type and
 * either all are stored in the new form or nothing changes — and removing a
 * key must never delete data: the key and its values are kept as history.
 */

jest.mock('../models/RegistryDataKey', () => ({ findOne: jest.fn() }));
jest.mock('../models/RegistryDataValue', () => ({
  find: jest.fn(), countDocuments: jest.fn(), distinct: jest.fn(), bulkWrite: jest.fn(), updateMany: jest.fn(),
}));
jest.mock('../models/WineDefinition', () => ({ find: jest.fn() }));
jest.mock('./audit', () => ({ logAudit: jest.fn() }));
jest.mock('./notifications', () => ({ createNotification: jest.fn(() => Promise.resolve()) }));

const RegistryDataKey = require('../models/RegistryDataKey');
const RegistryDataValue = require('../models/RegistryDataValue');
const WineDefinition = require('../models/WineDefinition');
const { logAudit } = require('./audit');
const { createNotification } = require('./notifications');
const ops = require('./registryDataOps');

const oid = (c) => c.repeat(24);
const KEY = oid('c');
const ADMIN = oid('d');
const MEMBER = oid('e');
const WINE = oid('b');

const keyDoc = (over = {}) => ({
  _id: KEY, name: 'ABV', nameKey: 'abv', type: 'text', unit: undefined, enumOptions: undefined, status: 'accepted',
  save: jest.fn().mockResolvedValue(undefined),
  ...over,
});
const chain = (result) => {
  const c = {};
  for (const m of ['select', 'sort', 'limit']) c[m] = jest.fn(() => c);
  c.lean = jest.fn(() => Promise.resolve(result));
  return c;
};

beforeEach(() => {
  jest.clearAllMocks();
  RegistryDataValue.bulkWrite.mockResolvedValue({});
  RegistryDataValue.updateMany.mockResolvedValue({});
});

describe('updateKey', () => {
  test('ABV made as text becomes decimal %: every value is stored as the number it says, the key keeps its id and name', async () => {
    const key = keyDoc();
    RegistryDataKey.findOne.mockResolvedValue(key);
    RegistryDataValue.find.mockReturnValue(chain([
      { _id: 'v1', value: '13.5', wineDefinition: WINE },
      { _id: 'v2', value: '12,5 %', wineDefinition: WINE, vintage: '2019' },
      { _id: 'v3', value: 14, wineDefinition: WINE }, // relayed over the Bridge as a number
    ]));

    const res = await ops.updateKey(ADMIN, KEY, { type: 'decimal', unit: '%' }, { req: { user: { id: ADMIN } } });

    expect(res).toMatchObject({ ok: true, converted: 2, prev: { type: 'text', unit: null, enumOptions: null } });
    expect(res.key).toMatchObject({ _id: KEY, name: 'ABV', type: 'decimal', unit: '%' });
    // Only what changed form is written; 14 already is the number it should be.
    const ops0 = RegistryDataValue.bulkWrite.mock.calls[0][0];
    expect(ops0.map((o) => [o.updateOne.filter._id, o.updateOne.update.$set.value])).toEqual([['v1', 13.5], ['v2', 12.5]]);
    // Only live rows are read again; a rejected one is history.
    expect(RegistryDataValue.find).toHaveBeenCalledWith({ key: KEY, status: { $in: ['suggested', 'published'] } });
    expect(key.save).toHaveBeenCalled();
    expect(logAudit).toHaveBeenCalledWith({ user: { id: ADMIN } }, 'registry_data.key_update', { type: 'registry_key', id: KEY },
      expect.objectContaining({ name: 'ABV', before: expect.objectContaining({ type: 'text' }), after: { type: 'decimal', unit: '%', enumOptions: null }, converted: 2 }));
  });

  test('a value that does not fit: nothing is written, and the answer names it with its wine', async () => {
    const key = keyDoc();
    RegistryDataKey.findOne.mockResolvedValue(key);
    RegistryDataValue.find.mockReturnValue(chain([
      { _id: 'v1', value: '13.5', wineDefinition: WINE },
      { _id: 'v2', value: 'about 13', wineDefinition: WINE, vintage: '2019' },
    ]));
    WineDefinition.find.mockReturnValue(chain([{ _id: WINE, producer: 'Cloudy Bay', name: 'Te Koko' }]));

    const res = await ops.updateKey(ADMIN, KEY, { type: 'decimal', unit: '%' });

    expect(res).toMatchObject({ ok: false, code: 'in_use' });
    expect(res.message).toContain('"about 13" on Cloudy Bay — Te Koko 2019');
    expect(res.message).toContain('Correct it on the wine first');
    expect(RegistryDataValue.bulkWrite).not.toHaveBeenCalled();
    expect(key.save).not.toHaveBeenCalled();
  });

  test('a list keeps every value its wines hold: dropping a used option is refused', async () => {
    const key = keyDoc({ name: 'Closure', type: 'enum', enumOptions: ['Cork', 'Screw cap'] });
    RegistryDataKey.findOne.mockResolvedValue(key);
    RegistryDataValue.find.mockReturnValue(chain([{ _id: 'v1', value: 'Screw cap', wineDefinition: WINE }]));
    WineDefinition.find.mockReturnValue(chain([]));
    expect((await ops.updateKey(ADMIN, KEY, { enumOptions: ['Cork', 'Glass stopper'] })).code).toBe('in_use');

    RegistryDataValue.find.mockReturnValue(chain([{ _id: 'v1', value: 'Screw cap', wineDefinition: WINE }]));
    const res = await ops.updateKey(ADMIN, KEY, { enumOptions: ['Cork', 'Screw cap', 'Glass stopper'] });
    expect(res).toMatchObject({ ok: true, converted: 0 });
    expect(key.enumOptions).toEqual(['Cork', 'Screw cap', 'Glass stopper']);
    expect(RegistryDataValue.bulkWrite).not.toHaveBeenCalled();
  });

  test('a proposed key can be put right before it is accepted', async () => {
    const key = keyDoc({ status: 'proposed' });
    RegistryDataKey.findOne.mockResolvedValue(key);
    RegistryDataValue.find.mockReturnValue(chain([]));
    expect((await ops.updateKey(ADMIN, KEY, { type: 'decimal', unit: '%' })).ok).toBe(true);
    expect(RegistryDataKey.findOne).toHaveBeenCalledWith({ _id: { $eq: KEY }, status: { $in: ['proposed', 'accepted'] } });
  });

  test('refused: nothing to change, the same definition, a bad definition, no live key, a bad id', async () => {
    expect((await ops.updateKey(ADMIN, KEY, {})).code).toBe('invalid');
    RegistryDataKey.findOne.mockResolvedValue(keyDoc({ type: 'decimal', unit: '%' }));
    expect((await ops.updateKey(ADMIN, KEY, { type: 'decimal', unit: '%' })).message).toContain('already defined');
    RegistryDataKey.findOne.mockResolvedValue(keyDoc());
    expect((await ops.updateKey(ADMIN, KEY, { type: 'percentage' })).code).toBe('invalid');
    expect((await ops.updateKey(ADMIN, KEY, { type: 'enum', enumOptions: ['Only one'] })).code).toBe('invalid');
    RegistryDataKey.findOne.mockResolvedValue(null);
    expect((await ops.updateKey(ADMIN, KEY, { type: 'decimal' })).code).toBe('not_found');
    expect((await ops.updateKey(ADMIN, 'nope', { type: 'decimal' })).code).toBe('invalid');
  });
});

describe('removeKey', () => {
  test('an empty key leaves the vocabulary as a tombstone, nothing else touched', async () => {
    const key = keyDoc();
    RegistryDataKey.findOne.mockResolvedValue(key);
    RegistryDataValue.countDocuments.mockResolvedValue(0);

    const res = await ops.removeKey(ADMIN, KEY);

    expect(res).toMatchObject({ ok: true, removed: { published: 0, suggested: 0 } });
    expect(key).toMatchObject({ status: 'rejected', rejectReason: 'Removed from the vocabulary by an admin', decidedBy: ADMIN });
    expect(key.save).toHaveBeenCalled();
    expect(RegistryDataValue.updateMany).not.toHaveBeenCalled();
    expect(logAudit).toHaveBeenCalledWith(null, 'registry_data.key_remove', { type: 'registry_key', id: KEY },
      { name: 'ABV', published: 0, suggested: 0 });
  });

  test('a key holding values is refused with how many, unless its values go with it', async () => {
    const key = keyDoc();
    RegistryDataKey.findOne.mockResolvedValue(key);
    RegistryDataValue.countDocuments.mockImplementation(async (q) => (q.status === 'published' ? 3 : 1));

    const refused = await ops.removeKey(ADMIN, KEY);
    expect(refused).toMatchObject({ ok: false, code: 'in_use' });
    expect(refused.message).toBe('"ABV" holds 3 published values and 1 waiting suggestion. Removing the field takes them off the wine records too.');
    expect(key.save).not.toHaveBeenCalled();

    RegistryDataValue.distinct.mockResolvedValue([MEMBER, ADMIN]);
    const res = await ops.removeKey(ADMIN, KEY, { removeValues: true });
    expect(res).toMatchObject({ ok: true, removed: { published: 3, suggested: 1 } });
    // Demoted, never deleted.
    expect(RegistryDataValue.updateMany).toHaveBeenCalledWith(
      { key: KEY, status: { $in: ['suggested', 'published'] } },
      { $set: expect.objectContaining({ status: 'rejected', rejectReason: 'Removed together with its field', decidedBy: ADMIN }) }
    );
    expect(key.status).toBe('rejected');
    // Whoever still waited is told — not the admin who removed it.
    expect(createNotification).toHaveBeenCalledTimes(1);
    expect(createNotification).toHaveBeenCalledWith(MEMBER, 'registry_value_decided', 'Suggested value not published',
      'Your suggested ABV was not published: the field was removed from the registry.', null);
  });

  test('only an accepted key is removed (a proposed one is rejected instead)', async () => {
    RegistryDataKey.findOne.mockResolvedValue(null);
    expect((await ops.removeKey(ADMIN, KEY)).code).toBe('not_found');
    expect(RegistryDataKey.findOne).toHaveBeenCalledWith({ _id: { $eq: KEY }, status: 'accepted' });
  });
});
