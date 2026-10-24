/**
 * DELETE /api/somm/maturity/:id/reset — a curator withdraws a reviewed drink
 * window, putting the wine+vintage back in the pending queue.
 *
 * Pins:
 *   - the withdrawal moves the data version of every owner of the wine
 *     (bumpWineOwners), like the review that set the window does — their
 *     maturity statistics change with it, and a read cache must not keep the
 *     old counts
 *   - a row that is already pending is refused with 409 (nothing to withdraw),
 *     the same answer the MCP reset_maturity_row tool gives: no save, no
 *     audit row, no bump
 *
 * Real router + real requireAuth/requireSommOrAdmin (HS256 test tokens); the
 * model is mocked so no MongoDB is needed.
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../../services/dataVersion', () => ({ bumpWineOwners: jest.fn() }));
jest.mock('../../services/labelScan', () => ({ suggestDrinkWindow: jest.fn() }));
jest.mock('../../models/WineVintageProfile', () => ({ findById: jest.fn() }));

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

const profileDoc = (over = {}) => ({
  _id: PROFILE_ID,
  wineDefinition: WINE_ID,
  vintage: '2018',
  status: 'reviewed',
  earlyFrom: 2022, earlyUntil: 2025, peakFrom: 2026, peakUntil: 2032, lateFrom: 2033, lateUntil: 2040,
  sommNotes: 'Firm tannins; give it time.',
  setBy: SOMM_ID,
  setAt: new Date('2026-09-01'),
  save: jest.fn().mockResolvedValue(undefined),
  ...over,
});

function reset(id = PROFILE_ID, roles = ['somm']) {
  const app = express();
  app.use('/api/somm/maturity', maturityRouter);
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const token = jwt.sign({ id: SOMM_ID, roles }, 'test-secret', { algorithm: 'HS256', expiresIn: '1h' });
      const req = http.request(
        { port: server.address().port, path: `/api/somm/maturity/${id}/reset`, method: 'DELETE', headers: { authorization: `Bearer ${token}` } },
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

beforeEach(() => jest.clearAllMocks());

test('withdrawing a reviewed window clears it and moves the wine owners\' data version', async () => {
  const doc = profileDoc();
  WineVintageProfile.findById.mockResolvedValue(doc);

  const res = await reset();

  expect(res.status).toBe(200);
  expect(res.body.profile.status).toBe('pending');
  for (const f of ['earlyFrom', 'earlyUntil', 'peakFrom', 'peakUntil', 'lateFrom', 'lateUntil']) expect(doc[f]).toBeUndefined();
  expect(doc.save).toHaveBeenCalledTimes(1);
  expect(bumpWineOwners).toHaveBeenCalledTimes(1);
  expect(bumpWineOwners).toHaveBeenCalledWith([WINE_ID]);
  expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'somm.maturity.reset',
    { type: 'wine', id: WINE_ID }, { vintage: '2018' });
});

test('the owners are bumped only once the withdrawal is saved', async () => {
  const doc = profileDoc({ save: jest.fn().mockRejectedValue(new Error('write failed')) });
  WineVintageProfile.findById.mockResolvedValue(doc);
  const spy = jest.spyOn(console, 'error').mockImplementation(() => {});

  const res = await reset();

  spy.mockRestore();
  expect(res.status).toBe(500);
  expect(bumpWineOwners).not.toHaveBeenCalled();
});

test('a pending row is refused with 409 — no save, no audit row, no bump', async () => {
  const doc = profileDoc({
    status: 'pending',
    earlyFrom: undefined, earlyUntil: undefined, peakFrom: undefined, peakUntil: undefined, lateFrom: undefined, lateUntil: undefined,
    sommNotes: '', setBy: null, setAt: null,
  });
  WineVintageProfile.findById.mockResolvedValue(doc);

  const res = await reset();

  expect(res.status).toBe(409);
  expect(res.body.error).toMatch(/already pending/);
  expect(doc.save).not.toHaveBeenCalled();
  expect(logAudit).not.toHaveBeenCalled();
  expect(bumpWineOwners).not.toHaveBeenCalled();
});

test('an unknown profile is 404 and a plain member is refused', async () => {
  WineVintageProfile.findById.mockResolvedValue(null);
  expect((await reset()).status).toBe(404);
  expect((await reset(PROFILE_ID, ['user'])).status).toBe(403);
  expect(bumpWineOwners).not.toHaveBeenCalled();
});
