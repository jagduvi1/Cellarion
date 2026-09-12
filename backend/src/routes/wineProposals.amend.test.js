/**
 * POST /api/wine-proposals — the transport half of the amend path (support
 * ticket 2026-09-12, audit M-3): a fresh filing answers 201, an amendment of
 * the caller's own pending suggestion answers 200 with `amended: true`, and
 * both forward to the registry bridge (an amendment there is an amendment on
 * the hosted side too). Service semantics live in wineProposalOps.test.js.
 */

jest.mock('../middleware/auth', () => ({
  requireAuth: (req, _res, next) => { req.user = { id: 'a'.repeat(24), roles: ['user'] }; next(); },
  requireNonDemo: (_req, _res, next) => next(),
}));
jest.mock('../services/wineProposalOps', () => ({
  createFieldCorrection: jest.fn(),
  listMineForWine: jest.fn(),
}));
jest.mock('../services/registryBridge', () => ({ forwardCorrection: jest.fn() }));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));

const express = require('express');
const http = require('http');
const ops = require('../services/wineProposalOps');
const registryBridge = require('../services/registryBridge');
const router = require('./wineProposals');

const oid = (c) => c.repeat(24);
const WINE = oid('b');
const wine = { _id: WINE, producer: 'Chateau Martinat', name: 'Grand Vin de Bordeaux' };

let server;
let base;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/wine-proposals', router);
  server = http.createServer(app);
  server.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.close(done); });
beforeEach(() => {
  jest.clearAllMocks();
  registryBridge.forwardCorrection.mockResolvedValue(undefined);
});

const post = (body) => fetch(`${base}/api/wine-proposals`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

test('a fresh filing answers 201 with amended: false', async () => {
  ops.createFieldCorrection.mockResolvedValue({
    ok: true, amended: false, wine,
    proposal: { _id: oid('9'), proposedFields: { name: 'Château Martinat' }, status: 'pending', createdAt: '2026-09-11T19:14:12.715Z' },
  });
  const res = await post({ wineId: WINE, fields: { name: 'Château Martinat' }, reason: 'Label boilerplate, not the cuvée.' });
  expect(res.status).toBe(201);
  const body = await res.json();
  expect(body).toEqual({
    amended: false,
    proposal: { _id: oid('9'), proposedFields: { name: 'Château Martinat' }, status: 'pending', createdAt: '2026-09-11T19:14:12.715Z' },
  });
  expect(ops.createFieldCorrection).toHaveBeenCalledWith(
    oid('a'),
    { wineId: WINE, fields: { name: 'Château Martinat' }, reason: 'Label boilerplate, not the cuvée.', evidenceUrl: undefined },
    expect.objectContaining({ via: 'web' })
  );
});

test('an amendment answers 200 with amended: true and still forwards to the bridge', async () => {
  ops.createFieldCorrection.mockResolvedValue({
    ok: true, amended: true, amendedFields: ['grapes'], wine,
    proposal: { _id: oid('7'), proposedFields: { name: 'Château Martinat', grapes: ['Merlot', 'Malbec'] }, status: 'pending', createdAt: '2026-09-11T19:14:12.715Z' },
  });
  const res = await post({ wineId: WINE, fields: { grapes: ['Merlot', 'Malbec'] }, reason: 'Importer data sheet.', evidenceUrl: 'https://x.example/s' });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.amended).toBe(true);
  expect(body.proposal.proposedFields).toEqual({ name: 'Château Martinat', grapes: ['Merlot', 'Malbec'] });
  expect(registryBridge.forwardCorrection).toHaveBeenCalledWith(wine, {
    fields: { grapes: ['Merlot', 'Malbec'] }, reason: 'Importer data sheet.', evidenceUrl: 'https://x.example/s',
  });
});

test('a service failure maps to its HTTP status and nothing is forwarded', async () => {
  ops.createFieldCorrection.mockResolvedValue({ ok: false, code: 'conflict', message: 'Filed by another user.' });
  const res = await post({ wineId: WINE, fields: { name: 'x' }, reason: 'long enough reason' });
  expect(res.status).toBe(409);
  expect((await res.json()).error).toBe('Filed by another user.');
  expect(registryBridge.forwardCorrection).not.toHaveBeenCalled();
});
