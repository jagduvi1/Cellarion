/**
 * PUT /api/somm/wine-profile/:wineId: two curators saving the same wine at once.
 *
 * The second save finds the wine changed under it and Mongoose refuses it.
 * That was reported as "Failed to update tasting profile", a server failure;
 * it is a conflict the curator resolves by reloading.
 *
 * Real router and auth (HS256 test tokens); the model and the side-effect
 * services are mocked, and the profile rules are stubbed to accept the patch.
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../../services/search', () => ({ indexWine: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../services/embeddingJob', () => ({ reembedActiveVintages: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../models/WineDefinition', () => ({ findById: jest.fn() }));
jest.mock('../../services/wineProfileOps', () => ({
  PROFILE_ENUMS: {}, LIST_FIELDS: [], EDITABLE_FIELDS: [], RECORD_FIELDS: [], WINE_TYPES: ['red'],
  GRAPES_MAX: 12, GRAPE_NAME_MAX: 60, DESCRIPTION_MAX: 2000,
  validateProfilePatch: jest.fn((body) => ({ ok: true, clean: { description: body.description } })),
  resolveGrapeIdsStrict: jest.fn(),
  applyProfilePatch: jest.fn(),
  snapshotProfile: jest.fn(() => ({ source: 'ai' })),
}));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const WineDefinition = require('../../models/WineDefinition');
const { logAudit } = require('../../services/audit');
const wineProfileRouter = require('./wineProfile');

const SOMM_ID = '64b000000000000000000001';
const WINE_ID = '64b0000000000000000000ee';

function save(body) {
  const app = express();
  app.use(express.json());
  app.use('/api/somm/wine-profile', wineProfileRouter);
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const req = http.request({
        port: server.address().port, path: `/api/somm/wine-profile/${WINE_ID}`, method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          authorization: `Bearer ${jwt.sign({ id: SOMM_ID, roles: ['somm'] }, 'test-secret', { algorithm: 'HS256', expiresIn: '1h' })}`,
        },
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => { server.close(); resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }); });
      });
      req.on('error', (e) => { server.close(); reject(e); });
      req.end(JSON.stringify(body));
    });
  });
}

const wine = (saveImpl) => ({ _id: WINE_ID, name: 'Cannubi', producer: 'Example Estate', type: 'red', aiProfile: {}, grapes: [], save: jest.fn(saveImpl) });

let consoleError;
beforeEach(() => {
  jest.clearAllMocks();
  consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { consoleError.mockRestore(); });

test('the save that loses answers 409, is not audited, and is not logged as a server failure', async () => {
  WineDefinition.findById.mockResolvedValue(wine(() => Promise.reject(Object.assign(new Error('No matching document found'), { name: 'VersionError' }))));
  const { status, body } = await save({ description: 'Roses and tar' });
  expect(status).toBe(409);
  expect(body.error).toMatch(/modified by another request/);
  expect(logAudit).not.toHaveBeenCalled();
  expect(consoleError).not.toHaveBeenCalled();
});

test('a save that goes through answers 200 and is audited', async () => {
  WineDefinition.findById.mockResolvedValue(wine(() => Promise.resolve()));
  const { status } = await save({ description: 'Roses and tar' });
  expect(status).toBe(200);
  expect(logAudit).toHaveBeenCalledTimes(1);
});

test('any other failure is still a 500', async () => {
  WineDefinition.findById.mockResolvedValue(wine(() => Promise.reject(new Error('db down'))));
  const { status, body } = await save({ description: 'Roses and tar' });
  expect(status).toBe(500);
  expect(body.error).toBe('Failed to update tasting profile');
});
