/**
 * Registry Bridge — self-hosted domain logic (docs/registry-bridge.md).
 *
 * WHY THIS TEST EXISTS:
 * Adoption is where a registry wine becomes a local one, and every detail of
 * that copy decides whether the install stays coherent: the dedup key must
 * be COMPUTED so a later local add finds the copy instead of minting a twin;
 * a local twin typed earlier is linked, not duplicated, and a locally curated
 * profile survives; windows and published values arrive as reviewed /
 * published rows; the refresh marks removed wines and keeps local identity
 * edits; contributions are forwarded only for adopted wines; and every path
 * degrades to local-only when the bridge is off or unreachable.
 */
jest.mock('../models/WineDefinition', () => {
  const M = jest.fn(function (doc) {
    Object.assign(this, doc);
    this._id = this._id || 'new1';
    this.save = jest.fn().mockResolvedValue(this);
    this.populate = jest.fn().mockResolvedValue(this);
  });
  M.findOne = jest.fn(); M.find = jest.fn(); M.findById = jest.fn(); M.countDocuments = jest.fn(); M.updateOne = jest.fn();
  return M;
});
jest.mock('../models/WineVintageProfile', () => ({ findOneAndUpdate: jest.fn().mockResolvedValue({}), findOne: jest.fn() }));
jest.mock('../models/RegistryDataKey', () => ({ findOne: jest.fn(), create: jest.fn(), findById: jest.fn() }));
jest.mock('../models/RegistryDataValue', () => ({ findOneAndUpdate: jest.fn().mockResolvedValue({}), findOne: jest.fn() }));
jest.mock('../models/SiteConfig', () => ({ findOne: jest.fn(), findOneAndUpdate: jest.fn().mockResolvedValue({}) }));
jest.mock('./registryBridgeClient', () => ({
  isEnabled: jest.fn(() => true),
  fetchWine: jest.fn(), search: jest.fn(), changes: jest.fn(), me: jest.fn(),
  forwardCorrection: jest.fn().mockResolvedValue({ ok: true }), forwardValue: jest.fn().mockResolvedValue({ ok: true }), forwardRequest: jest.fn().mockResolvedValue({ ok: true }),
  transportState: jest.fn(() => ({ enabled: true, reason: null, url: 'https://cellarion.app', keyPrefix: 'cbr_12345678', blocked: null, lastError: null })),
}));
jest.mock('./findOrCreateWine', () => ({
  findOrCreateCountry: jest.fn(async (name) => ({ _id: `country:${name}` })),
  findOrCreateRegion: jest.fn(async (name) => ({ _id: `region:${name}` })),
  regionForAppellation: jest.fn(async () => null),
  findOrCreateGrapes: jest.fn(async (names) => names.map((n) => `grape:${n}`)),
}));
jest.mock('./search', () => ({ indexWine: jest.fn().mockResolvedValue(undefined) }));

const WineDefinition = require('../models/WineDefinition');
const WineVintageProfile = require('../models/WineVintageProfile');
const RegistryDataKey = require('../models/RegistryDataKey');
const RegistryDataValue = require('../models/RegistryDataValue');
const SiteConfig = require('../models/SiteConfig');
const client = require('./registryBridgeClient');
const { findOrCreateCountry } = require('./findOrCreateWine');
const { generateWineKey } = require('../utils/normalize');
const bridge = require('./registryBridge');

const RID = 'a'.repeat(24);
const USER = 'u1';
const registryWine = (over = {}) => ({
  id: RID, slug: 'torres-salmos', producer: 'Torres', name: 'Salmos', type: 'red', appellation: 'Priorat', classification: 'DOQ',
  region: 'Catalonia', country: 'Spain', grapes: ['Cariñena', 'Syrah'], image: 'https://cellarion.app/api/uploads/processed/x.png', imageCredit: 'Estate', lwin: null,
  profile: { body: 'full', tannin: 'high', acidity: 'medium', sweetness: 'dry', flavors: ['plum'], foodPairings: ['lamb'], description: 'A dense Priorat.', source: 'curator', generatedAt: '2026-09-01T00:00:00.000Z' },
  windows: [{ vintage: '2019', relative: false, early: { from: 2022, until: 2023 }, peak: { from: 2024, until: 2030 }, late: { from: 2031, until: 2034 } }],
  values: [{ key: { name: 'ABV', type: 'decimal', unit: '%' }, value: 14.5, wineValue: 14.5, overrides: [{ vintage: '2020', value: 14 }] }],
  ...over,
});
// findOne is awaited directly in one place and chained with populate in another.
const lookup = (doc) => ({ populate: jest.fn().mockResolvedValue(doc), then: (res, rej) => Promise.resolve(doc).then(res, rej) });

beforeEach(() => {
  jest.clearAllMocks();
  bridge._reset();
  client.isEnabled.mockReturnValue(true);
  WineDefinition.findOne.mockReturnValue(lookup(null));
  RegistryDataKey.findOne.mockResolvedValue(null);
  RegistryDataKey.create.mockImplementation(async (doc) => ({ _id: 'key1', ...doc }));
  WineVintageProfile.findOne.mockResolvedValue(null);
  RegistryDataValue.findOne.mockResolvedValue(null);
  SiteConfig.findOne.mockReturnValue({ lean: () => Promise.resolve(null) });
  delete process.env.REGISTRY_BRIDGE_REFRESH;
});

describe('adoptWine', () => {
  test('copies a registry wine as a local wine: computed dedup key, bridge provenance, profile, windows, values, local index', async () => {
    client.fetchWine.mockResolvedValue(registryWine());
    const r = await bridge.adoptWine(RID, USER);
    expect(r.ok).toBe(true);
    expect(r.created).toBe(true);
    const doc = WineDefinition.mock.calls[0][0];
    expect(doc).toMatchObject({
      name: 'Salmos', producer: 'Torres', appellation: 'Priorat', classification: 'DOQ', type: 'red',
      country: 'country:Spain', region: 'region:Catalonia', grapes: ['grape:Cariñena', 'grape:Syrah'],
      image: 'https://cellarion.app/api/uploads/processed/x.png', imageCredit: 'Estate',
      normalizedKey: generateWineKey('Salmos', 'Torres', 'Priorat'), createdBy: USER, createdVia: 'bridge', registryId: RID,
      aiProfile: expect.objectContaining({ body: 'full', description: 'A dense Priorat.', source: 'curator' }),
    });
    expect(doc.registrySyncedAt).toBeInstanceOf(Date);
    expect(doc).not.toHaveProperty('slug'); // hook-assigned, never copied
    expect(r.wine.save).toHaveBeenCalled();
    expect(WineVintageProfile.findOneAndUpdate).toHaveBeenCalledWith(
      { wineDefinition: 'new1', vintage: '2019' },
      { $set: expect.objectContaining({ relative: false, earlyFrom: 2022, peakFrom: 2024, peakUntil: 2030, lateUntil: 2034, status: 'reviewed', setBy: USER }) },
      expect.objectContaining({ upsert: true })
    );
    expect(RegistryDataKey.create).toHaveBeenCalledWith(expect.objectContaining({ name: 'ABV', type: 'decimal', unit: '%', status: 'accepted', proposedBy: USER }));
    const published = RegistryDataValue.findOneAndUpdate.mock.calls.map((c) => [c[0].vintage, c[1].$set.value]);
    expect(published).toEqual([[null, 14.5], ['2020', 14]]);
    expect(require('./search').indexWine).toHaveBeenCalledWith('new1');
  });

  test('a wine this install already holds is returned as is, without a fetch', async () => {
    const held = { _id: 'local9', registryId: RID };
    WineDefinition.findOne.mockReturnValueOnce(lookup(held));
    const r = await bridge.adoptWine(RID, USER);
    expect(r).toEqual({ ok: true, wine: held, created: false });
    expect(client.fetchWine).not.toHaveBeenCalled();
  });

  test('a local twin with the same dedup key is linked, not duplicated, and its curated profile stays', async () => {
    client.fetchWine.mockResolvedValue(registryWine());
    const twin = { _id: 'twin1', image: null, aiProfile: { source: 'curator', description: 'My own note.' }, save: jest.fn().mockResolvedValue(undefined), populate: jest.fn().mockResolvedValue(undefined) };
    WineDefinition.findOne.mockReturnValueOnce(lookup(null)).mockReturnValueOnce(lookup(twin));
    const r = await bridge.adoptWine(RID, USER);
    expect(r.ok).toBe(true);
    expect(WineDefinition).not.toHaveBeenCalled(); // no new document
    expect(twin.registryId).toBe(RID);
    expect(twin.image).toBe('https://cellarion.app/api/uploads/processed/x.png');
    expect(twin.aiProfile.description).toBe('My own note.');
    expect(twin.save).toHaveBeenCalled();
  });

  test('an unresolvable country does not stop the copy, and an unknown type is left absent', async () => {
    findOrCreateCountry.mockRejectedValueOnce(new Error('unrecognised country'));
    client.fetchWine.mockResolvedValue(registryWine({ country: 'Atlantis', region: null, type: 'orange' }));
    const r = await bridge.adoptWine(RID, USER);
    expect(r.ok).toBe(true);
    const doc = WineDefinition.mock.calls[0][0];
    expect(doc).not.toHaveProperty('country');
    expect(doc).not.toHaveProperty('type');
    expect(doc.region).toBeNull();
  });

  test('off, invalid, gone and unreachable are codes, never throws', async () => {
    client.isEnabled.mockReturnValue(false);
    expect(await bridge.adoptWine(RID, USER)).toEqual({ ok: false, code: 'disabled' });
    client.isEnabled.mockReturnValue(true);
    expect(await bridge.adoptWine('nope', USER)).toEqual({ ok: false, code: 'invalid' });
    client.fetchWine.mockResolvedValueOnce({ removed: true });
    expect(await bridge.adoptWine(RID, USER)).toEqual({ ok: false, code: 'not_found' });
    client.fetchWine.mockResolvedValueOnce(null);
    expect(await bridge.adoptWine(RID, USER)).toEqual({ ok: false, code: 'unavailable' });
  });
});

describe('registrySearch', () => {
  test('returns registry identities minus the ones already held, marked as registry rows', async () => {
    client.search.mockResolvedValue([{ id: RID, name: 'Salmos' }, { id: 'b'.repeat(24), name: 'Salmos Reserva' }]);
    WineDefinition.find.mockReturnValue({ select: () => ({ lean: () => Promise.resolve([{ registryId: RID }]) }) });
    const rows = await bridge.registrySearch('salmos');
    expect(rows).toEqual([{ id: 'b'.repeat(24), name: 'Salmos Reserva', registryId: 'b'.repeat(24), source: 'registry' }]);
    client.isEnabled.mockReturnValue(false);
    expect(await bridge.registrySearch('salmos')).toEqual([]);
  });
});

describe('refreshHeld', () => {
  test('one change check for the held ids, changed copies re-fetched, removed ones marked', async () => {
    const held = [
      { _id: 'l1', registryId: RID, registrySyncedAt: new Date('2026-09-01'), updatedAt: new Date('2026-09-01'), createdBy: USER },
      { _id: 'l2', registryId: 'b'.repeat(24), registrySyncedAt: new Date('2026-09-02'), updatedAt: new Date('2026-09-02'), createdBy: USER },
    ];
    WineDefinition.find.mockReturnValue({ select: () => ({ lean: () => Promise.resolve(held) }) });
    client.changes.mockResolvedValue({ changed: [{ id: RID, updatedAt: 'x' }], removed: ['b'.repeat(24)], checked: 2, failed: false });
    client.fetchWine.mockResolvedValue(registryWine({ name: 'Salmos Priorat' }));
    const local = { _id: 'l1', createdBy: USER, registrySyncedAt: new Date('2026-09-01'), updatedAt: new Date('2026-09-01'), aiProfile: { source: 'ai' }, save: jest.fn().mockResolvedValue(undefined) };
    WineDefinition.findById.mockResolvedValue(local);
    const r = await bridge.refreshHeld({ now: new Date('2026-09-08') });
    expect(client.changes).toHaveBeenCalledWith([RID, 'b'.repeat(24)], new Date('2026-09-01'));
    expect(local.name).toBe('Salmos Priorat'); // untouched locally → identity follows the registry
    expect(local.aiProfile).toMatchObject({ description: 'A dense Priorat.' });
    expect(local.save).toHaveBeenCalled();
    expect(WineDefinition.updateOne).toHaveBeenCalledWith({ _id: 'l2' }, { $set: { registryRemovedAt: new Date('2026-09-08') } });
    expect(r).toMatchObject({ checked: 2, changed: 1, updated: 1, removed: 1, failed: false });
  });

  test('a copy edited locally since the last sync keeps its identity but still takes the profile and windows', async () => {
    WineDefinition.find.mockReturnValue({ select: () => ({ lean: () => Promise.resolve([{ _id: 'l1', registryId: RID, registrySyncedAt: new Date('2026-09-01'), createdBy: USER }]) }) });
    client.changes.mockResolvedValue({ changed: [{ id: RID }], removed: [], checked: 1, failed: false });
    client.fetchWine.mockResolvedValue(registryWine({ name: 'Renamed Upstream' }));
    const local = { _id: 'l1', name: 'My Local Name', createdBy: USER, registrySyncedAt: new Date('2026-09-01'), updatedAt: new Date('2026-09-05'), image: null, aiProfile: { source: 'ai' }, save: jest.fn().mockResolvedValue(undefined) };
    WineDefinition.findById.mockResolvedValue(local);
    await bridge.refreshHeld({ now: new Date('2026-09-08') });
    expect(local.name).toBe('My Local Name');
    expect(local.aiProfile.description).toBe('A dense Priorat.');
    expect(WineVintageProfile.findOneAndUpdate).toHaveBeenCalled();
  });

  test('is a no-op when off or when nothing is held', async () => {
    client.isEnabled.mockReturnValue(false);
    expect(await bridge.refreshHeld()).toEqual({ skipped: 'disabled' });
    client.isEnabled.mockReturnValue(true);
    WineDefinition.find.mockReturnValue({ select: () => ({ lean: () => Promise.resolve([]) }) });
    expect(await bridge.refreshHeld()).toMatchObject({ checked: 0 });
    expect(client.changes).not.toHaveBeenCalled();
  });
});

describe('forwarding', () => {
  test('a correction is forwarded only for an adopted wine, with the registry id', async () => {
    await bridge.forwardCorrection({ _id: 'l1', registryId: RID }, { fields: { producer: 'Familia Torres' }, reason: 'label', evidenceUrl: 'https://torres.es' });
    expect(client.forwardCorrection).toHaveBeenCalledWith({ wineId: RID, fields: { producer: 'Familia Torres' }, reason: 'label', evidenceUrl: 'https://torres.es' });
    expect(await bridge.forwardCorrection({ _id: 'l2' }, { fields: {}, reason: 'x' })).toBeNull();
  });

  test('a value is forwarded by key NAME, resolved from the local key id when needed', async () => {
    WineDefinition.findOne.mockReturnValue({ select: () => ({ lean: () => Promise.resolve({ registryId: RID }) }) });
    RegistryDataKey.findOne.mockReturnValue({ select: () => ({ lean: () => Promise.resolve({ name: 'ABV' }) }) });
    await bridge.forwardValueFor('c'.repeat(24), { keyId: 'd'.repeat(24), value: 14.5, reason: 'label', vintage: '2019' });
    expect(client.forwardValue).toHaveBeenCalledWith(expect.objectContaining({ wineId: RID, keyName: 'ABV', value: 14.5, vintage: '2019' }));
    WineDefinition.findOne.mockReturnValue({ select: () => ({ lean: () => Promise.resolve({ registryId: null }) }) });
    expect(await bridge.forwardValueFor('c'.repeat(24), { keyName: 'ABV', value: 1 })).toBeNull();
  });

  test('a wine request is forwarded, an inline image is not', async () => {
    await bridge.forwardRequest({ wineName: 'X', sourceUrl: 'https://x.example', image: 'data:image/png;base64,AAAA' });
    expect(client.forwardRequest).toHaveBeenCalledWith({ wineName: 'X', sourceUrl: 'https://x.example' });
    await bridge.forwardRequest({ wineName: 'Y', sourceUrl: 'https://y.example', image: 'https://y.example/label.jpg' });
    expect(client.forwardRequest).toHaveBeenLastCalledWith({ wineName: 'Y', sourceUrl: 'https://y.example', image: 'https://y.example/label.jpg' });
  });
});

describe('status', () => {
  test('reports transport, held and removed counts, the last refresh and the key\'s own /me', async () => {
    WineDefinition.countDocuments.mockResolvedValueOnce(12).mockResolvedValueOnce(1);
    client.me.mockResolvedValue({ usage: { used: { fetches: 3 } } });
    const s = await bridge.status();
    expect(s).toMatchObject({ enabled: true, url: 'https://cellarion.app', keyPrefix: 'cbr_12345678', held: 12, removed: 1, lastRefresh: null, me: { usage: { used: { fetches: 3 } } } });
  });
});

// ── Local changes win, and the refresh switch ────────────────────────────────
// The weekly refresh must never undo what someone on this install did to a
// copy. Rows the bridge wrote carry REGISTRY_NOTE and the sync time; anything
// else — or anything touched after the last sync — is local and stays. And an
// install that wants no refresh at all can say so in .env or on the card.

describe('local changes win', () => {
  const PREV_SYNC = new Date('2026-09-01');
  const NOW = new Date('2026-09-08');
  const REGISTRY_NOTE = bridge.REGISTRY_NOTE;

  function setupRefresh(localOver = {}) {
    WineDefinition.find.mockReturnValue({ select: () => ({ lean: () => Promise.resolve([{ _id: 'l1', registryId: RID, registrySyncedAt: PREV_SYNC, updatedAt: PREV_SYNC, createdBy: USER }]) }) });
    client.changes.mockResolvedValue({ changed: [{ id: RID }], removed: [], checked: 1, failed: false });
    client.fetchWine.mockResolvedValue(registryWine());
    const local = { _id: 'l1', name: 'Salmos', createdBy: USER, registrySyncedAt: PREV_SYNC, updatedAt: PREV_SYNC, aiProfile: { source: 'ai' }, save: jest.fn().mockResolvedValue(undefined), ...localOver };
    WineDefinition.findById.mockResolvedValue(local);
    return local;
  }

  test('a window set by someone on this install is kept; a placeholder row is still filled', async () => {
    setupRefresh();
    // Vintage 2019 in the registry payload; the local row for it was set by a person (no bridge note, real dates).
    WineVintageProfile.findOne.mockResolvedValueOnce({ vintage: '2019', sommNotes: 'Our sommelier, from the bottle', status: 'reviewed', peakFrom: 2026, peakUntil: 2028, setAt: new Date('2026-08-20') });
    await bridge.refreshHeld({ now: NOW });
    expect(WineVintageProfile.findOne).toHaveBeenCalledWith({ wineDefinition: 'l1', vintage: '2019' });
    expect(WineVintageProfile.findOneAndUpdate).not.toHaveBeenCalled();

    jest.clearAllMocks();
    setupRefresh();
    // A seeded placeholder: no note, no dates, not reviewed → the registry fills it.
    WineVintageProfile.findOne.mockResolvedValueOnce({ vintage: '2019', sommNotes: null, status: 'pending', peakFrom: null, peakUntil: null });
    await bridge.refreshHeld({ now: NOW });
    expect(WineVintageProfile.findOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  test('a bridge-written window is refreshed only while nobody touched it since the last sync', async () => {
    setupRefresh();
    WineVintageProfile.findOne.mockResolvedValueOnce({ vintage: '2019', sommNotes: REGISTRY_NOTE, setAt: PREV_SYNC });
    await bridge.refreshHeld({ now: NOW });
    expect(WineVintageProfile.findOneAndUpdate).toHaveBeenCalledTimes(1);

    jest.clearAllMocks();
    setupRefresh();
    // Same bridge row, but edited on 2026-09-05 (dates changed, note kept) → theirs now.
    WineVintageProfile.findOne.mockResolvedValueOnce({ vintage: '2019', sommNotes: REGISTRY_NOTE, setAt: new Date('2026-09-05') });
    await bridge.refreshHeld({ now: NOW });
    expect(WineVintageProfile.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test('a public value set on this install is kept; a bridge-written one is refreshed', async () => {
    setupRefresh();
    RegistryDataKey.findOne.mockResolvedValue({ _id: 'key1', name: 'ABV' });
    // Wine-wide value (vintage null) is local; the 2020 override is the bridge's own.
    RegistryDataValue.findOne
      .mockResolvedValueOnce({ value: 14.2, reason: 'Read from our label', decidedAt: new Date('2026-08-30') })
      .mockResolvedValueOnce({ value: 14, reason: REGISTRY_NOTE, decidedAt: PREV_SYNC });
    await bridge.refreshHeld({ now: NOW });
    const writes = RegistryDataValue.findOneAndUpdate.mock.calls.map((c) => c[0].vintage);
    expect(writes).toEqual(['2020']);
  });

  test('a profile curated on this install after the last sync is kept; the registry profile replaces an AI one', async () => {
    const local = setupRefresh({ aiProfile: { source: 'curator', description: 'Our note', verifiedAt: new Date('2026-09-06') } });
    await bridge.refreshHeld({ now: NOW });
    expect(local.aiProfile.description).toBe('Our note');

    jest.clearAllMocks();
    const local2 = setupRefresh({ aiProfile: { source: 'curator', description: 'Registry curated', verifiedAt: new Date('2026-08-01') } });
    await bridge.refreshHeld({ now: NOW });
    expect(local2.aiProfile.description).toBe('A dense Priorat.');
  });

  test('adopting onto a local twin keeps the window its owner set', async () => {
    client.fetchWine.mockResolvedValue(registryWine());
    const twin = { _id: 'l9', name: 'Salmos', producer: 'Torres', aiProfile: null, image: null, save: jest.fn().mockResolvedValue(undefined), populate: jest.fn().mockResolvedValue(undefined) };
    WineDefinition.findOne
      .mockReturnValueOnce(lookup(null))   // not held by registry id
      .mockReturnValueOnce(lookup(twin));  // twin by dedup key
    WineVintageProfile.findOne.mockResolvedValueOnce({ vintage: '2019', sommNotes: null, status: 'reviewed', peakFrom: 2027, peakUntil: 2031 });
    const r = await bridge.adoptWine(RID, USER);
    expect(r.ok).toBe(true);
    expect(WineVintageProfile.findOneAndUpdate).not.toHaveBeenCalled();
  });
});

describe('refresh switch', () => {
  test('REGISTRY_BRIDGE_REFRESH=off in .env stops the weekly run before any request', async () => {
    process.env.REGISTRY_BRIDGE_REFRESH = 'off';
    expect(await bridge.refreshHeld()).toEqual({ skipped: 'refresh_off', source: 'env' });
    expect(client.changes).not.toHaveBeenCalled();
    expect(await bridge.refreshMode()).toEqual({ mode: 'off', source: 'env' });
    // …and the admin toggle is refused while the env decides.
    expect(await bridge.setRefreshMode('weekly', USER)).toEqual({ ok: false, code: 'env_override', mode: 'off', source: 'env' });
    expect(SiteConfig.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test('the Settings toggle is stored in site config and read at each run; unset means weekly', async () => {
    expect(await bridge.refreshMode()).toEqual({ mode: 'weekly', source: 'default' });
    expect(await bridge.setRefreshMode('off', USER)).toEqual({ ok: true, mode: 'off', source: 'settings' });
    expect(SiteConfig.findOneAndUpdate).toHaveBeenCalledWith(
      { key: 'registryBridge' },
      { $set: expect.objectContaining({ value: { refresh: 'off' }, updatedBy: USER }) },
      expect.objectContaining({ upsert: true })
    );
    SiteConfig.findOne.mockReturnValue({ lean: () => Promise.resolve({ key: 'registryBridge', value: { refresh: 'off' } }) });
    expect(await bridge.refreshHeld()).toEqual({ skipped: 'refresh_off', source: 'settings' });
    expect(await bridge.setRefreshMode('sometimes', USER)).toEqual({ ok: false, code: 'invalid' });
  });

  test('a failing site-config read falls back to weekly, and status reports the mode', async () => {
    SiteConfig.findOne.mockReturnValue({ lean: () => Promise.reject(new Error('down')) });
    WineDefinition.countDocuments.mockResolvedValue(0);
    client.me.mockResolvedValue(null);
    const s = await bridge.status();
    expect(s.refresh).toEqual({ mode: 'weekly', source: 'default' });
  });
});
