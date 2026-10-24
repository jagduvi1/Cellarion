/**
 * GET /api/somm/maturity/lookup — the drink window of one wine + vintage,
 * read by any signed-in member (BottleDetail, CellarVintage).
 *
 * The registry never shows members who contributed its data, so who set the
 * window (setBy) is populated for sommeliers and admins only; for everyone
 * else the field is left out of the query altogether.
 *
 * Real router + real requireAuth (HS256 test tokens); the model is mocked so
 * no MongoDB is needed.
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../../services/dataVersion', () => ({ bumpWineOwners: jest.fn() }));
jest.mock('../../services/labelScan', () => ({ suggestDrinkWindow: jest.fn() }));
jest.mock('../../models/WineVintageProfile', () => ({ findOne: jest.fn() }));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const WineVintageProfile = require('../../models/WineVintageProfile');
const maturityRouter = require('./maturity');

const USER_ID = '64b000000000000000000002';
const WINE_ID = '64b0000000000000000000ee';

// The query findOne returns: populate/select record the call and return the
// query; awaiting it resolves the profile the test chose.
const queryResolving = (profile) => {
  const q = {};
  q.populate = jest.fn(() => q);
  q.select = jest.fn(() => q);
  q.then = (res, rej) => Promise.resolve(profile).then(res, rej);
  return q;
};

function lookup(roles, url = `/api/somm/maturity/lookup?wine=${WINE_ID}&vintage=2018`) {
  const app = express();
  app.use('/api/somm/maturity', maturityRouter);
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const token = jwt.sign({ id: USER_ID, roles }, 'test-secret', { algorithm: 'HS256', expiresIn: '1h' });
      http.get({ port: server.address().port, path: url, headers: { authorization: `Bearer ${token}` } }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => { server.close(); resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }); });
      }).on('error', (e) => { server.close(); reject(e); });
    });
  });
}

beforeEach(() => jest.clearAllMocks());

test('a member gets the window without who set it', async () => {
  const q = queryResolving({ status: 'reviewed', peakFrom: 2024, peakUntil: 2030 });
  WineVintageProfile.findOne.mockReturnValue(q);
  const res = await lookup(['user']);
  expect(res.status).toBe(200);
  expect(res.body.profile).toEqual({ status: 'reviewed', peakFrom: 2024, peakUntil: 2030 });
  expect(WineVintageProfile.findOne).toHaveBeenCalledWith({ wineDefinition: WINE_ID, vintage: '2018' });
  expect(q.select).toHaveBeenCalledWith('-setBy');
  expect(q.populate).not.toHaveBeenCalled();
});

test.each([['somm'], ['admin']])('a %s also sees who set it', async (role) => {
  const q = queryResolving({ status: 'reviewed', setBy: { username: 'curator' } });
  WineVintageProfile.findOne.mockReturnValue(q);
  const res = await lookup([role]);
  expect(res.status).toBe(200);
  expect(res.body.profile.setBy).toEqual({ username: 'curator' });
  expect(q.populate).toHaveBeenCalledWith({ path: 'setBy', select: 'username' });
  expect(q.select).not.toHaveBeenCalled();
});

test('no profile answers null; bad input answers 400', async () => {
  WineVintageProfile.findOne.mockReturnValue(queryResolving(null));
  expect((await lookup(['user'])).body).toEqual({ profile: null });
  expect((await lookup(['user'], '/api/somm/maturity/lookup?wine=nope&vintage=2018')).status).toBe(400);
  expect((await lookup(['user'], `/api/somm/maturity/lookup?wine=${WINE_ID}`)).status).toBe(400);
});
