/**
 * DELETE /api/somm/maturity/:id — a curator takes a pending wine+vintage out
 * of the drink-window queue (the wine was never released in that vintage).
 *
 * Pins:
 *   - a pending row is deleted and audited (somm.maturity.remove), with no
 *     data-version bump: nothing is left for an owner to read
 *   - the delete carries the "not reviewed" condition itself, so a row
 *     another curator reviewed between this route's load and its delete stays:
 *     409, no audit row. The MCP twin, remove_from_maturity_queue, answers
 *     the same race with a conflict
 *   - a reviewed row is refused with 409 before any delete; unknown id 404
 *
 * Real router + real requireAuth/requireSommOrAdmin (HS256 test tokens); the
 * model is mocked so no MongoDB is needed.
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../../services/dataVersion', () => ({ bumpWineOwners: jest.fn() }));
jest.mock('../../services/labelScan', () => ({ suggestDrinkWindow: jest.fn() }));
jest.mock('../../models/WineVintageProfile', () => ({ findById: jest.fn(), deleteOne: jest.fn() }));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const WineVintageProfile = require('../../models/WineVintageProfile');
const { logAudit } = require('../../services/audit');
const { bumpWineOwners } = require('../../services/dataVersion');
const maturityRouter = require('./maturity');

const SOMM_ID = '64b000000000000000000001';
const WINE_ID = '64b0000000000000000000ee';
const PROFILE_ID = '64b0000000000000000000aa';

const profileDoc = (over = {}) => ({ _id: PROFILE_ID, wineDefinition: WINE_ID, vintage: '2027', status: 'pending', ...over });

function remove(id = PROFILE_ID, roles = ['somm']) {
  const app = express();
  app.use('/api/somm/maturity', maturityRouter);
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const token = jwt.sign({ id: SOMM_ID, roles }, 'test-secret', { algorithm: 'HS256', expiresIn: '1h' });
      const req = http.request(
        { port: server.address().port, path: `/api/somm/maturity/${id}`, method: 'DELETE', headers: { authorization: `Bearer ${token}` } },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => { server.close(); resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }); });
        }
      );
      req.on('error', (e) => { server.close(); reject(e); });
      req.end();
    });
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  WineVintageProfile.deleteOne.mockResolvedValue({ deletedCount: 1 });
});

test('a pending row is deleted while it is still not reviewed, audited, and no owner is bumped', async () => {
  WineVintageProfile.findById.mockResolvedValue(profileDoc());
  const res = await remove();
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ removed: true });
  expect(WineVintageProfile.deleteOne).toHaveBeenCalledWith({ _id: PROFILE_ID, status: { $ne: 'reviewed' } });
  expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'somm.maturity.remove', { type: 'wine', id: WINE_ID }, { vintage: '2027' });
  expect(bumpWineOwners).not.toHaveBeenCalled();
});

test('a row reviewed by someone else between the load and the delete stays: 409 and no audit row', async () => {
  WineVintageProfile.findById.mockResolvedValue(profileDoc());
  WineVintageProfile.deleteOne.mockResolvedValueOnce({ deletedCount: 0 });
  const res = await remove();
  expect(res.status).toBe(409);
  expect(res.body.error).toMatch(/reviewed or removed by someone else/);
  expect(logAudit).not.toHaveBeenCalled();
});

test('a reviewed row is refused before any delete; an unknown profile is 404', async () => {
  WineVintageProfile.findById.mockResolvedValue(profileDoc({ status: 'reviewed' }));
  expect((await remove()).status).toBe(409);
  expect(WineVintageProfile.deleteOne).not.toHaveBeenCalled();

  WineVintageProfile.findById.mockResolvedValue(null);
  expect((await remove()).status).toBe(404);
});
