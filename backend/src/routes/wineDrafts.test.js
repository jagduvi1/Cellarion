/**
 * routes/wineDrafts — the REST surface over services/wineDraftOps (support
 * ticket 2026-09-12). The ops are mocked; this pins the transport contract:
 * status codes per result code, the read path for shared-cellar members
 * (read only), demo accounts refused on writes, and the batch shape.
 */
process.env.JWT_SECRET = 'test-secret';

jest.mock('../services/wineDraftOps', () => ({
  draftSummary: jest.fn((w) => ({ _id: w._id, name: w.name, draft: true })),
  listDrafts: jest.fn(),
  loadOwnDraft: jest.fn(),
  validateDraftPatch: jest.fn(),
  updateDraft: jest.fn(),
  publishDraft: jest.fn(),
  publishDrafts: jest.fn(),
  attachDraftBottles: jest.fn(),
  deleteDraft: jest.fn(),
}));
jest.mock('../services/wineVisibility', () => ({ findVisibleWine: jest.fn() }));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../models/User', () => ({ exists: jest.fn(async () => ({ _id: 'demo1' })) }));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const ops = require('../services/wineDraftOps');
const { findVisibleWine } = require('../services/wineVisibility');
const router = require('./wineDrafts');

const ME = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const WINE = 'cccccccccccccccccccccccc';
const TARGET = 'dddddddddddddddddddddddd';

let server, baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/wine-drafts', router);
  server = http.createServer(app);
  server.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.closeAllConnections(); server.close(done); });
beforeEach(() => jest.clearAllMocks());

const token = (userId = ME, extra = {}) => jwt.sign({ id: userId, roles: ['user'], ...extra }, 'test-secret');
const call = async (method, path, body, t = token()) => {
  const res = await fetch(baseUrl + path, {
    method,
    headers: { 'Content-Type': 'application/json', authorization: `Bearer ${t}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

const doc = (o = {}) => ({ _id: WINE, name: 'Kaefferkopf', draft: true, createdBy: ME, populate: jest.fn(async function () { return this; }), ...o });

describe('GET /', () => {
  test('lists my drafts', async () => {
    ops.listDrafts.mockResolvedValue({ ok: true, drafts: [{ _id: WINE }] });
    const r = await call('GET', '/api/wine-drafts');
    expect(r).toEqual({ status: 200, body: { drafts: [{ _id: WINE }] } });
    expect(ops.listDrafts).toHaveBeenCalledWith(ME);
  });
});

describe('GET /:id', () => {
  test('reads through the visibility rule with the shared-cellar path on; a miss is 404', async () => {
    findVisibleWine.mockResolvedValue(null);
    expect((await call('GET', `/api/wine-drafts/${WINE}`)).status).toBe(404);
    expect(findVisibleWine).toHaveBeenCalledWith(WINE, expect.objectContaining({ userId: ME, viaSharedCellar: true, lean: true }));
  });

  test('a shared-cellar member sees it with mine:false; a published wine at this path is 404', async () => {
    findVisibleWine.mockResolvedValue({ _id: WINE, name: 'Kaefferkopf', draft: true, createdBy: ME });
    const r = await call('GET', `/api/wine-drafts/${WINE}`, null, token(OTHER));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ draft: { _id: WINE, name: 'Kaefferkopf', draft: true }, mine: false });
    findVisibleWine.mockResolvedValue({ _id: WINE, draft: false });
    expect((await call('GET', `/api/wine-drafts/${WINE}`)).status).toBe(404);
  });
});

describe('PATCH /:id', () => {
  test('a stranger (not_found from the ops) is a 404; a bad patch is a 400; a demo account is a 403', async () => {
    ops.loadOwnDraft.mockResolvedValue({ ok: false, code: 'not_found', message: 'No draft with that id.' });
    expect((await call('PATCH', `/api/wine-drafts/${WINE}`, { name: 'X' })).status).toBe(404);

    ops.loadOwnDraft.mockResolvedValue({ ok: true, wine: doc() });
    ops.validateDraftPatch.mockReturnValue({ ok: false, error: 'Nothing to change' });
    const bad = await call('PATCH', `/api/wine-drafts/${WINE}`, {});
    expect(bad).toEqual({ status: 400, body: { error: 'Nothing to change' } });

    expect((await call('PATCH', `/api/wine-drafts/${WINE}`, { name: 'X' }, token(ME, { isDemo: true }))).status).toBe(403);
  });

  test('a valid edit returns the draft and the diff', async () => {
    const w = doc();
    ops.loadOwnDraft.mockResolvedValue({ ok: true, wine: w });
    ops.validateDraftPatch.mockReturnValue({ ok: true, clean: { name: 'X' } });
    ops.updateDraft.mockResolvedValue({ ok: true, wine: w, diff: { name: { from: 'Kaefferkopf', to: 'X' } } });
    const r = await call('PATCH', `/api/wine-drafts/${WINE}`, { name: 'X' });
    expect(r.status).toBe(200);
    expect(r.body.diff).toEqual({ name: { from: 'Kaefferkopf', to: 'X' } });
    expect(ops.updateDraft).toHaveBeenCalledWith(w, { name: 'X' }, ME);
  });
});

describe('POST /:id/publish', () => {
  test('duplicate and similar are 409 with their payloads and codes; invalid_identity is 400', async () => {
    ops.loadOwnDraft.mockResolvedValue({ ok: true, wine: doc() });
    ops.publishDraft.mockResolvedValue({ ok: false, code: 'duplicate', message: 'dup', match: { wine_id: TARGET } });
    let r = await call('POST', `/api/wine-drafts/${WINE}/publish`, {});
    expect(r).toEqual({ status: 409, body: { error: 'dup', code: 'duplicate', match: { wine_id: TARGET } } });

    ops.publishDraft.mockResolvedValue({ ok: false, code: 'similar', message: 'sim', candidates: [{ wine_id: TARGET, score: 0.9 }] });
    r = await call('POST', `/api/wine-drafts/${WINE}/publish`, {});
    expect(r.status).toBe(409);
    expect(r.body.candidates).toHaveLength(1);

    ops.publishDraft.mockResolvedValue({ ok: false, code: 'invalid_identity', message: 'bad producer' });
    expect((await call('POST', `/api/wine-drafts/${WINE}/publish`, {})).status).toBe(400);
  });

  test('confirmCreate rides through strictly as a boolean; success reports promotion', async () => {
    const w = doc({ slug: 'kaefferkopf' });
    ops.loadOwnDraft.mockResolvedValue({ ok: true, wine: w });
    ops.publishDraft.mockResolvedValue({ ok: true, wine: w, promoted: true, pendingCuration: false });
    const r = await call('POST', `/api/wine-drafts/${WINE}/publish`, { confirmCreate: 'yes' });
    expect(ops.publishDraft).toHaveBeenCalledWith(w, expect.objectContaining({ confirmCreate: false, userId: ME }));
    expect(r.body).toMatchObject({ published: true, promoted: true, wine: { slug: 'kaefferkopf' } });
  });
});

describe('POST /publish (batch), POST /:id/attach, DELETE /:id', () => {
  test('batch validates ids and returns per-id results', async () => {
    expect((await call('POST', '/api/wine-drafts/publish', { ids: ['nope'] })).status).toBe(400);
    ops.publishDrafts.mockResolvedValue({ ok: true, results: [{ id: WINE, status: 'published' }] });
    const r = await call('POST', '/api/wine-drafts/publish', { ids: [WINE], confirmCreate: true });
    expect(r).toEqual({ status: 200, body: { results: [{ id: WINE, status: 'published' }] } });
    expect(ops.publishDrafts).toHaveBeenCalledWith([WINE], ME, expect.objectContaining({ confirmCreate: true }));
  });

  test('attach needs a wine id target and reports bottles moved', async () => {
    ops.loadOwnDraft.mockResolvedValue({ ok: true, wine: doc() });
    expect((await call('POST', `/api/wine-drafts/${WINE}/attach`, { targetWineId: 'x' })).status).toBe(400);
    ops.attachDraftBottles.mockResolvedValue({ ok: true, bottlesMoved: 2, wine: { _id: TARGET, name: 'K', producer: 'C' } });
    const r = await call('POST', `/api/wine-drafts/${WINE}/attach`, { targetWineId: TARGET });
    expect(r.body).toEqual({ attached: true, bottlesMoved: 2, wine: { _id: TARGET, name: 'K', producer: 'C' } });
  });

  test('delete: 409 while bottles remain, 204 when gone', async () => {
    ops.loadOwnDraft.mockResolvedValue({ ok: true, wine: doc() });
    ops.deleteDraft.mockResolvedValue({ ok: false, code: 'conflict', message: 'holds bottles' });
    expect((await call('DELETE', `/api/wine-drafts/${WINE}`)).status).toBe(409);
    ops.deleteDraft.mockResolvedValue({ ok: true });
    expect((await call('DELETE', `/api/wine-drafts/${WINE}`)).status).toBe(204);
  });
});
