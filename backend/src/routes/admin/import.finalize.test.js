/**
 * finalizeMintedWines — the post-import invariant repair (strategy 2026-07-29,
 * R4). The LWIN import's bulkWrite bypasses every mongoose hook, so rows it
 * inserts are born without canonicalKey (invisible to duplicate prevention),
 * slug (no public wine page) and createdVia (unreviewable as a class). This
 * pins: only the given ids are touched, each gains all three invariants, slug
 * collisions get the -2 suffix, existing values are never overwritten, and a
 * per-row failure doesn't abort the rest.
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../../services/search', () => ({ fullSync: jest.fn(), indexWine: jest.fn() }));
jest.mock('../../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../../models/WineDefinition', () => ({
  findById: jest.fn(), findOne: jest.fn(), findFreeSlug: jest.fn(), bulkWrite: jest.fn(),
}));
jest.mock('../../models/Country', () => ({ findOne: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock('../../models/Region', () => ({ findOne: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock('../../models/Appellation', () => ({ findOne: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock('../../services/findOrCreateWine', () => ({ findOrCreateRegion: jest.fn(), regionForAppellation: jest.fn() }));
jest.mock('../../services/appellationResolve', () => ({ resolveCanonicalAppellation: jest.fn(async (n) => n) }));
jest.mock('../../services/producerSpelling', () => ({ resolveCanonicalProducerSpelling: jest.fn(async (p) => p) }));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const WineDefinition = require('../../models/WineDefinition');
const Country = require('../../models/Country');
const Appellation = require('../../models/Appellation');
const searchService = require('../../services/search');
const { findOrCreateRegion, regionForAppellation } = require('../../services/findOrCreateWine');
const importRouter = require('./import');
const { finalizeMintedWines } = importRouter;
const { computeCanonicalKey } = require('../../utils/wineIdentity');

const doc = (over = {}) => ({
  _id: 'w1',
  name: 'Albe',
  producer: 'G.D. Vajra',
  appellation: 'Barolo',
  canonicalKey: null,
  slug: null,
  createdVia: null,
  save: jest.fn().mockResolvedValue(undefined),
  ...over,
});

const selectChain = (result) => ({ select: jest.fn().mockReturnValue(
  typeof result?.then === 'function' ? result : Promise.resolve(result)
) });
const slugProbe = (result) => ({ select: () => ({ lean: () => Promise.resolve(result) }) });

beforeEach(() => {
  jest.clearAllMocks();
  WineDefinition.findOne.mockReturnValue(slugProbe(null)); // no slug collision
  // The real static (models/WineDefinition) probes slug AND previousSlugs; here
  // the base is simply free.
  WineDefinition.findFreeSlug.mockImplementation(async (base) => base);
});

describe('finalizeMintedWines', () => {
  test('stamps canonicalKey, slug and createdVia on a bare imported row', async () => {
    const d = doc();
    WineDefinition.findById.mockReturnValue(selectChain(d));
    const n = await finalizeMintedWines(['w1']);
    expect(n).toBe(1);
    expect(d.canonicalKey).toBe(computeCanonicalKey('Albe', 'G.D. Vajra', 'Barolo'));
    expect(d.createdVia).toBe('import');
    expect(typeof d.slug).toBe('string');
    expect(d.slug.length).toBeGreaterThan(0);
    expect(d.save).toHaveBeenCalled();
  });

  test('the slug comes from findFreeSlug — NOT a bare { slug } probe (audit M-5)', async () => {
    // This was the fifth slug-assignment site and the only one still blind to
    // previousSlugs: a bare `findOne({ slug })` happily hands an import a slug
    // that another wine still ANSWERS TO after a rename, and then
    // { $or: [{slug}, {previousSlugs}] } matches two documents and /wines/<slug>
    // resolves nondeterministically. Suffix behaviour itself is pinned on the
    // static (models/WineDefinition.slugRename.test.js).
    const d = doc();
    WineDefinition.findById.mockReturnValue(selectChain(d));
    WineDefinition.findFreeSlug.mockResolvedValue('albe-2');

    await finalizeMintedWines(['w1']);

    expect(WineDefinition.findFreeSlug).toHaveBeenCalledTimes(1);
    expect(d.slug).toBe('albe-2');
    // No hand-rolled probe survives anywhere on this path.
    expect(WineDefinition.findOne).not.toHaveBeenCalled();
  });

  test('a save collision re-asks findFreeSlug instead of mangling the slug', async () => {
    const err = Object.assign(new Error('dup'), { code: 11000 });
    const d = doc({ save: jest.fn().mockRejectedValueOnce(err).mockResolvedValue(undefined) });
    WineDefinition.findById.mockReturnValue(selectChain(d));
    WineDefinition.findFreeSlug
      .mockResolvedValueOnce('albe')
      .mockResolvedValueOnce('albe-2');

    expect(await finalizeMintedWines(['w1'])).toBe(1);
    // Was `${doc.slug}-r1` — a slug nothing had checked against previousSlugs.
    expect(d.slug).toBe('albe-2');
  });

  test('a save collision that is NOT the slug is not retried forever', async () => {
    // findFreeSlug returning the same value means the 11000 came from
    // normalizedKey; mangling the URL would not fix it, so the row fails
    // (non-fatally) instead of spinning.
    const err = Object.assign(new Error('dup'), { code: 11000 });
    const d = doc({ save: jest.fn().mockRejectedValue(err) });
    WineDefinition.findById.mockReturnValue(selectChain(d));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    expect(await finalizeMintedWines(['w1'])).toBe(0);
    expect(d.save).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  test('existing slug and createdVia are never overwritten', async () => {
    const d = doc({ slug: 'kept-slug', createdVia: 'ui' });
    WineDefinition.findById.mockReturnValue(selectChain(d));
    await finalizeMintedWines(['w1']);
    expect(d.slug).toBe('kept-slug');
    expect(d.createdVia).toBe('ui');
    // canonicalKey is always recomputed — idempotent by construction.
    expect(d.canonicalKey).toBe(computeCanonicalKey('Albe', 'G.D. Vajra', 'Barolo'));
  });

  test('a per-row failure is non-fatal — the rest still finalize', async () => {
    const bad = doc({ _id: 'w1', save: jest.fn().mockRejectedValue(new Error('boom')) });
    const good = doc({ _id: 'w2' });
    WineDefinition.findById
      .mockReturnValueOnce(selectChain(bad))
      .mockReturnValueOnce(selectChain(good));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const n = await finalizeMintedWines(['w1', 'w2']);
    expect(n).toBe(1);
    expect(good.save).toHaveBeenCalled();
    warn.mockRestore();
  });

  test('a vanished id is skipped without counting', async () => {
    WineDefinition.findById.mockReturnValue(selectChain(null));
    expect(await finalizeMintedWines(['gone'])).toBe(0);
  });
});

// The import resolves a row's region the way findOrCreateWine does — through
// the shared helpers — instead of upserting a Region by exact name (which
// re-minted merged-away regions and skipped the mint gates). The real router
// takes a real multipart CSV; taxonomy and the bulkWrite are mocked.
describe('POST /api/admin/import/wines — region resolution', () => {
  const USER_ID = '64b000000000000000000001';
  const COUNTRY_ID = '64b0000000000000000000c1';
  const REGION_ID = '64b0000000000000000000d1';
  const CHABLIS_REGION_ID = '64b0000000000000000000d2';

  const adminToken = () =>
    jwt.sign({ id: USER_ID, roles: ['admin'] }, 'test-secret', { algorithm: 'HS256', expiresIn: '1h' });

  function postCsv(csv) {
    const app = express();
    app.use('/api/admin/import', importRouter);
    const boundary = 'importRegionTestBoundary';
    const body = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="wines.csv"\r\n` +
      `Content-Type: text/csv\r\n\r\n${csv}\r\n--${boundary}--\r\n`
    );
    return new Promise((resolve) => {
      const server = http.createServer(app);
      server.listen(0, () => {
        const req = http.request({
          port: server.address().port,
          path: '/api/admin/import/wines',
          method: 'POST',
          headers: {
            authorization: `Bearer ${adminToken()}`,
            'content-type': `multipart/form-data; boundary=${boundary}`,
            'content-length': body.length,
          },
        }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            server.close();
            const text = Buffer.concat(chunks).toString();
            resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null });
          });
        });
        req.on('error', () => { server.close(); resolve({ status: 0 }); });
        req.end(body);
      });
    });
  }

  const opSet = (n) => WineDefinition.bulkWrite.mock.calls[0][0][n].updateOne.update[0].$set;

  beforeEach(() => {
    Country.findOneAndUpdate.mockResolvedValue({ _id: COUNTRY_ID });
    Appellation.findOneAndUpdate.mockResolvedValue({ _id: 'a1' });
    regionForAppellation.mockResolvedValue(null);
    findOrCreateRegion.mockImplementation(async (name) => (name === 'Bourgogne' ? { _id: REGION_ID } : null));
    WineDefinition.bulkWrite.mockImplementation(async (ops) => ({ upsertedCount: ops.length, modifiedCount: 0, upsertedIds: {} }));
    searchService.fullSync.mockResolvedValue(undefined);
  });

  const CSV = [
    'Producer,Wine,Country,Region,Appellation,WineType',
    'Domaine Un,Cuvee A,France,Bourgogne,,Red',
    'Domaine Deux,Cuvee B,France,Bourgogne,,Red',
    'Domaine Trois,Cuvee C,France,"Bordeaux, Haut-Medoc",,Red',
  ].join('\r\n');

  test('a region cell is resolved through findOrCreateRegion and its id is stored on the wine op', async () => {
    const { status, body } = await postCsv(CSV);

    expect(status).toBe(200);
    expect(findOrCreateRegion).toHaveBeenCalledWith('Bourgogne', COUNTRY_ID, USER_ID);
    expect(opSet(0).region).toEqual({ $ifNull: ['$region', REGION_ID] });
    expect(opSet(1).region).toEqual({ $ifNull: ['$region', REGION_ID] });
    expect(body.stats.errors).toEqual([]);
  });

  test('a region findOrCreateRegion refuses (null) leaves the region unset and still creates the wine', async () => {
    const { status, body } = await postCsv(CSV);

    expect(status).toBe(200);
    expect(findOrCreateRegion).toHaveBeenCalledWith('Bordeaux, Haut-Medoc', COUNTRY_ID, USER_ID);
    expect(WineDefinition.bulkWrite.mock.calls[0][0]).toHaveLength(3);
    expect(opSet(2)).not.toHaveProperty('region');
    expect(opSet(2).name).toEqual({ $ifNull: ['$name', { $literal: 'Cuvee C' }] });
    expect(body.stats.created).toBe(3);
  });

  test('the second row with the same region cell does not call findOrCreateRegion again', async () => {
    await postCsv(CSV);

    const bourgogneCalls = findOrCreateRegion.mock.calls.filter(([name]) => name === 'Bourgogne');
    expect(bourgogneCalls).toHaveLength(1);
    expect(findOrCreateRegion).toHaveBeenCalledTimes(2);
  });

  test('an appellation that names a known region wins over the region cell, as in findOrCreateWine', async () => {
    regionForAppellation.mockImplementation(async (app) => (app === 'Chablis' ? { _id: CHABLIS_REGION_ID } : null));

    const { status } = await postCsv([
      'Producer,Wine,Country,Region,Appellation,WineType',
      'Domaine Un,Cuvee A,France,Bourgogne,Chablis,White',
    ].join('\r\n'));

    expect(status).toBe(200);
    expect(regionForAppellation).toHaveBeenCalledWith('Chablis', COUNTRY_ID);
    expect(findOrCreateRegion).not.toHaveBeenCalled();
    expect(opSet(0).region).toEqual({ $ifNull: ['$region', CHABLIS_REGION_ID] });
  });
});
