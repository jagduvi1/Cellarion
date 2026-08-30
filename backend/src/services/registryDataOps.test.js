/**
 * registryDataOps (#985 Slice B) — the public vocabulary + values engine
 * shared by REST (user + admin) and MCP. Updated for the 2026-08-17 audit
 * fixes: wine-visibility gate on the read path, the shared contribution
 * gate, key-by-name resolution, any-pending exposure, bounded queues, and
 * history-preserving supersede.
 */

jest.mock('../models/RegistryDataKey', () => ({
  findOne: jest.fn(), find: jest.fn(), create: jest.fn(),
  countDocuments: jest.fn(), findOneAndUpdate: jest.fn(),
}));
jest.mock('../models/RegistryDataValue', () => ({
  findOne: jest.fn(), find: jest.fn(), create: jest.fn(),
  countDocuments: jest.fn(), deleteOne: jest.fn(), updateOne: jest.fn(),
}));
jest.mock('./contributionGate', () => ({
  TIER_DAILY: { newcomer: 3, contributor: 5, enthusiast: 10, connoisseur: 20, ambassador: 30 },
  checkContributionGate: jest.fn(),
}));
jest.mock('./wineVisibility', () => ({ findVisibleWine: jest.fn() }));
jest.mock('./audit', () => ({ logAudit: jest.fn() }));
jest.mock('./notifications', () => ({ createNotification: jest.fn(() => Promise.resolve()) }));

const RegistryDataKey = require('../models/RegistryDataKey');
const RegistryDataValue = require('../models/RegistryDataValue');
const { checkContributionGate } = require('./contributionGate');
const { findVisibleWine } = require('./wineVisibility');
const { createNotification } = require('./notifications');
const ops = require('./registryDataOps');

const oid = (c) => c.repeat(24);
const ME = oid('a');
const WINE = oid('b');
const KEY = oid('c');
const ADMIN = oid('d');

const acceptedKey = { _id: KEY, name: 'ABV', nameKey: 'abv', type: 'decimal', unit: '%', status: 'accepted' };

const chain = (result) => {
  const c = {};
  for (const m of ['sort', 'populate', 'select', 'limit']) c[m] = jest.fn(() => c);
  c.lean = jest.fn(() => Promise.resolve(result));
  return c;
};

beforeEach(() => {
  jest.clearAllMocks();
  ops.invalidateVocabCache();
  checkContributionGate.mockResolvedValue({ ok: true, user: { contribution: { tier: 'newcomer' } } });
  findVisibleWine.mockResolvedValue({ _id: WINE, producer: 'Cloudy Bay', name: 'Sauvignon Blanc' });
});

describe('proposeKey', () => {
  const GOOD = { name: 'ABV', type: 'decimal', unit: '%', rationale: 'Alcohol strength matters to every drinker.' };

  test('type-system validation and rationale bounds apply', async () => {
    expect((await ops.proposeKey(ME, { ...GOOD, type: 'percentage' })).code).toBe('invalid');
    expect((await ops.proposeKey(ME, { ...GOOD, rationale: 'short' })).code).toBe('invalid');
    expect((await ops.proposeKey(ME, { name: 'Closure', type: 'enum', enumOptions: ['cork'], rationale: GOOD.rationale })).code).toBe('invalid');
  });

  test('reserved names cannot shadow first-class fields', async () => {
    for (const name of ['producer', 'Region', 'FLAVORS']) {
      const res = await ops.proposeKey(ME, { ...GOOD, name });
      expect(res).toMatchObject({ ok: false, code: 'conflict' });
    }
    expect(RegistryDataKey.create).not.toHaveBeenCalled();
  });

  test('live-name collision: accepted → "suggest a value instead", proposed → "awaiting review"', async () => {
    RegistryDataKey.findOne.mockResolvedValue({ ...acceptedKey, status: 'accepted' });
    expect((await ops.proposeKey(ME, GOOD)).message).toContain('suggest a value');
    RegistryDataKey.findOne.mockResolvedValue({ ...acceptedKey, status: 'proposed' });
    expect((await ops.proposeKey(ME, GOOD)).message).toContain('awaiting review');
  });

  test('the shared contribution gate is consulted and its failure passes through', async () => {
    checkContributionGate.mockResolvedValue({ ok: false, code: 'limit', message: 'cap' });
    const res = await ops.proposeKey(ME, GOOD);
    expect(res).toMatchObject({ ok: false, code: 'limit' });
    expect(RegistryDataKey.create).not.toHaveBeenCalled();
  });

  test('happy path creates the proposed key', async () => {
    RegistryDataKey.findOne.mockResolvedValue(null);
    RegistryDataKey.create.mockResolvedValue({ ...acceptedKey, status: 'proposed' });
    const res = await ops.proposeKey(ME, GOOD);
    expect(res.ok).toBe(true);
    expect(RegistryDataKey.create).toHaveBeenCalledWith(expect.objectContaining({
      name: 'ABV', type: 'decimal', unit: '%', proposedBy: ME,
    }));
  });
});

describe('suggestValue', () => {
  const GOOD = { wineId: WINE, keyId: KEY, value: '13,5' };

  test('only ACCEPTED keys accept values; keyName resolves via nameKey', async () => {
    RegistryDataKey.findOne.mockResolvedValue(null);
    expect((await ops.suggestValue(ME, GOOD)).code).toBe('not_found');
    expect(RegistryDataKey.findOne).toHaveBeenCalledWith({ _id: { $eq: KEY }, status: 'accepted' });

    RegistryDataKey.findOne.mockClear();
    RegistryDataKey.findOne.mockResolvedValue(acceptedKey);
    RegistryDataValue.findOne.mockResolvedValue(null);
    RegistryDataValue.create.mockResolvedValue({ _id: oid('9'), value: 13.5, status: 'suggested' });
    const res = await ops.suggestValue(ME, { wineId: WINE, keyName: '  ABV ', value: 13.5 });
    expect(res.ok).toBe(true);
    expect(RegistryDataKey.findOne).toHaveBeenCalledWith({ nameKey: { $eq: 'abv' }, status: 'accepted' });

    expect((await ops.suggestValue(ME, { wineId: WINE, value: 1 })).code).toBe('invalid');
  });

  test('value validated against the key type before any write', async () => {
    RegistryDataKey.findOne.mockResolvedValue(acceptedKey);
    const res = await ops.suggestValue(ME, { ...GOOD, value: 'strong' });
    expect(res.code).toBe('invalid');
    expect(RegistryDataValue.create).not.toHaveBeenCalled();
  });

  test('same-as-published is a no-op conflict; invisible wine is not_found', async () => {
    RegistryDataKey.findOne.mockResolvedValue(acceptedKey);
    RegistryDataValue.findOne.mockResolvedValue({ value: 13.5, status: 'published' });
    const res = await ops.suggestValue(ME, GOOD);
    expect(res).toMatchObject({ ok: false, code: 'conflict' });

    findVisibleWine.mockResolvedValue(null);
    RegistryDataValue.findOne.mockResolvedValue(null);
    expect((await ops.suggestValue(ME, GOOD)).code).toBe('not_found');
  });

  test('creates the suggestion with the CAST value; E11000 → friendly conflict', async () => {
    RegistryDataKey.findOne.mockResolvedValue(acceptedKey);
    RegistryDataValue.findOne.mockResolvedValue(null);
    RegistryDataValue.create.mockResolvedValue({ _id: oid('9'), value: 13.5, status: 'suggested' });

    const res = await ops.suggestValue(ME, GOOD);
    expect(res.ok).toBe(true);
    expect(RegistryDataValue.create).toHaveBeenCalledWith(expect.objectContaining({
      wineDefinition: WINE, key: KEY, value: 13.5, suggestedBy: ME,
    }));

    RegistryDataValue.create.mockRejectedValue(Object.assign(new Error('dup'), { code: 11000 }));
    expect((await ops.suggestValue(ME, GOOD)).code).toBe('conflict');
  });
});

describe('dataForWine', () => {
  test('gated on wine visibility: hidden or missing wine → not_found, no value query', async () => {
    findVisibleWine.mockResolvedValue(null);
    const res = await ops.dataForWine(WINE, ME, { roles: [] });
    expect(res).toMatchObject({ ok: false, code: 'not_found' });
    expect(RegistryDataValue.find).not.toHaveBeenCalled();
  });

  test('empty vocabulary short-circuits without value queries', async () => {
    RegistryDataKey.find.mockReturnValue(chain([]));
    const res = await ops.dataForWine(WINE, ME);
    expect(res).toEqual({ ok: true, fields: [] });
    expect(RegistryDataValue.find).not.toHaveBeenCalled();
  });

  test('blanks included; any pending suggestion exposed without attribution; mine flagged', async () => {
    RegistryDataKey.find.mockReturnValue(chain([
      acceptedKey,
      { _id: oid('e'), name: 'Organic', nameKey: 'organic', type: 'boolean', status: 'accepted' },
    ]));
    RegistryDataValue.find
      .mockReturnValueOnce(chain([{ key: KEY, value: 13.5, suggestedBy: { username: 'kurt' } }]))
      .mockReturnValueOnce(chain([{ key: oid('e'), value: true, status: 'suggested', suggestedBy: oid('9') }]));

    const res = await ops.dataForWine(WINE, ME);
    expect(res.fields[0]).toMatchObject({ value: 13.5, contributedBy: 'kurt', hasPendingSuggestion: false, mySuggestion: null });
    // Someone ELSE's pending suggestion: slot shown occupied, value not mine
    expect(res.fields[1]).toMatchObject({ value: null, hasPendingSuggestion: true, mySuggestion: null });
  });

  test('the vocabulary is cached between calls and invalidated on a key decision', async () => {
    RegistryDataKey.find.mockReturnValue(chain([acceptedKey]));
    RegistryDataValue.find.mockReturnValue(chain([]));
    await ops.dataForWine(WINE, ME);
    await ops.dataForWine(WINE, ME);
    expect(RegistryDataKey.find).toHaveBeenCalledTimes(1);

    RegistryDataKey.findOneAndUpdate.mockResolvedValue({ ...acceptedKey, status: 'accepted' });
    await ops.decideKey(ADMIN, KEY, 'accept');
    await ops.dataForWine(WINE, ME);
    expect(RegistryDataKey.find).toHaveBeenCalledTimes(2);
  });
});

describe('admin decisions', () => {
  test('decideKey accepts only a still-proposed row', async () => {
    RegistryDataKey.findOneAndUpdate.mockResolvedValue({ ...acceptedKey, status: 'accepted' });
    const res = await ops.decideKey(ADMIN, KEY, 'accept');
    expect(res.ok).toBe(true);
    expect(RegistryDataKey.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: { $eq: KEY }, status: 'proposed' },
      expect.objectContaining({ $set: expect.objectContaining({ status: 'accepted', decidedBy: ADMIN }) }),
      { new: true }
    );

    RegistryDataKey.findOneAndUpdate.mockResolvedValue(null);
    expect((await ops.decideKey(ADMIN, KEY, 'accept')).code).toBe('not_found');
    expect((await ops.decideKey(ADMIN, KEY, 'publish')).code).toBe('invalid');
  });

  test('publish DEMOTES the previously published value (never deletes) then promotes', async () => {
    const row = {
      _id: oid('9'), wineDefinition: WINE, key: acceptedKey, value: 14,
      status: 'suggested', save: jest.fn().mockResolvedValue(undefined),
    };
    RegistryDataValue.findOne.mockReturnValue({ populate: jest.fn().mockResolvedValue(row) });
    RegistryDataValue.updateOne.mockResolvedValue({ modifiedCount: 1 });

    const res = await ops.decideValue(ADMIN, oid('9'), 'publish');
    expect(res.ok).toBe(true);
    expect(RegistryDataValue.deleteOne).not.toHaveBeenCalled();
    expect(RegistryDataValue.updateOne).toHaveBeenCalledWith(
      { wineDefinition: WINE, key: KEY, status: 'published' },
      expect.objectContaining({ $set: expect.objectContaining({ status: 'rejected', rejectReason: expect.stringContaining('Superseded') }) })
    );
    expect(row.status).toBe('published');
    expect(row.save).toHaveBeenCalled();
  });

  test('a suggestion whose key is gone is refused cleanly, not a TypeError', async () => {
    const row = { _id: oid('9'), wineDefinition: WINE, key: null, status: 'suggested' };
    RegistryDataValue.findOne.mockReturnValue({ populate: jest.fn().mockResolvedValue(row) });
    const res = await ops.decideValue(ADMIN, oid('9'), 'publish');
    expect(res).toMatchObject({ ok: false, code: 'invalid' });
  });

  test('reject keeps the row as history and never touches the published slot', async () => {
    const row = {
      _id: oid('9'), wineDefinition: WINE, key: acceptedKey, value: 14,
      status: 'suggested', save: jest.fn().mockResolvedValue(undefined),
    };
    RegistryDataValue.findOne.mockReturnValue({ populate: jest.fn().mockResolvedValue(row) });
    const res = await ops.decideValue(ADMIN, oid('9'), 'reject', 'no evidence');
    expect(res.ok).toBe(true);
    expect(row.status).toBe('rejected');
    expect(RegistryDataValue.updateOne).not.toHaveBeenCalled();
  });

  // ── Contributor feedback (2026-08-30) ────────────────────────────────────
  // The rejectReason field was written, capped and stored — and had no
  // reader: no notification type existed, and the user-facing keys endpoint
  // returns only the accepted vocabulary, so a curator's explanation reached
  // the contributor solely through a GDPR export. Every sibling queue (wine
  // requests, reports, images, price requests) notifies its submitter.

  test('a rejected key notifies its proposer WITH the curator reason', async () => {
    RegistryDataKey.findOneAndUpdate.mockResolvedValue({
      ...acceptedKey, name: 'Beautiful', status: 'rejected',
      proposedBy: ME, rejectReason: 'Not an objective property.',
    });
    await ops.decideKey(ADMIN, KEY, 'reject', 'Not an objective property.');

    expect(createNotification).toHaveBeenCalledWith(
      ME, 'registry_key_decided', 'Registry key not accepted',
      expect.stringContaining('Not an objective property.'),
      null
    );
    // The name is in the message too, so the notification stands alone.
    expect(createNotification.mock.calls[0][3]).toContain('Beautiful');
  });

  test('an accepted key notifies without a reason paragraph', async () => {
    RegistryDataKey.findOneAndUpdate.mockResolvedValue({
      ...acceptedKey, status: 'accepted', proposedBy: ME, rejectReason: undefined,
    });
    await ops.decideKey(ADMIN, KEY, 'accept');

    const [, type, title, message] = createNotification.mock.calls[0];
    expect(type).toBe('registry_key_decided');
    expect(title).toBe('Registry key accepted');
    expect(message).not.toContain('\n\n'); // no empty reason block appended
  });

  test('value decisions notify the suggester both ways', async () => {
    const base = () => ({
      _id: oid('9'), wineDefinition: WINE, key: acceptedKey, value: 13.5,
      status: 'suggested', suggestedBy: ME, save: jest.fn().mockResolvedValue(undefined),
    });

    RegistryDataValue.findOne.mockReturnValue({ populate: jest.fn().mockResolvedValue(base()) });
    await ops.decideValue(ADMIN, oid('9'), 'reject', 'unsourced');
    expect(createNotification).toHaveBeenLastCalledWith(
      ME, 'registry_value_decided', 'Suggested value not published',
      expect.stringContaining('unsourced'), null
    );

    RegistryDataValue.findOne.mockReturnValue({ populate: jest.fn().mockResolvedValue(base()) });
    await ops.decideValue(ADMIN, oid('9'), 'publish');
    expect(createNotification).toHaveBeenLastCalledWith(
      ME, 'registry_value_decided', 'Suggested value published',
      expect.stringContaining('13.5'), null
    );
  });

  test('a decision still succeeds when the notification fails', async () => {
    // Fire-and-forget: the decision is already persisted and audit-logged.
    createNotification.mockRejectedValueOnce(new Error('push broker down'));
    RegistryDataKey.findOneAndUpdate.mockResolvedValue({ ...acceptedKey, status: 'accepted', proposedBy: ME });
    const res = await ops.decideKey(ADMIN, KEY, 'accept');
    expect(res.ok).toBe(true);
  });

  test('a proposal from a deleted account is decided without notifying', async () => {
    RegistryDataKey.findOneAndUpdate.mockResolvedValue({ ...acceptedKey, status: 'accepted', proposedBy: null });
    const res = await ops.decideKey(ADMIN, KEY, 'accept');
    expect(res.ok).toBe(true);
    expect(createNotification).not.toHaveBeenCalled();
  });

  test('review queues are bounded', async () => {
    const kChain = chain([]);
    const vChain = chain([]);
    RegistryDataKey.find.mockReturnValue(kChain);
    RegistryDataValue.find.mockReturnValue(vChain);
    await ops.listReviewQueues();
    expect(kChain.limit).toHaveBeenCalledWith(ops.REVIEW_QUEUE_LIMIT);
    expect(vChain.limit).toHaveBeenCalledWith(ops.REVIEW_QUEUE_LIMIT);
  });
});
