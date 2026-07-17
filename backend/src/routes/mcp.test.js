/**
 * /api/mcp/activity — the "Recent AI activity" timeline + one-click revert
 * (Phase 2d). These routes are the HUMAN oversight surface for MCP mutations,
 * so the test pins the security-critical properties:
 *   - JWT-only in spirit: a row is only ever the caller's own (user filter).
 *   - Revert re-checks reversed / viaUndo / window BEFORE the engine runs, and
 *     maps the engine's typed failure codes to the right HTTP status.
 *   - The timeline never leaks token material and reports the revert window.
 */

process.env.JWT_SECRET = 'test-secret';

const DAY = 86400000;
const WINDOW = 5 * DAY;

jest.mock('../mcp/server', () => ({ handleMcpRequest: jest.fn(), initStatefulSession: jest.fn() }));
jest.mock('../mcp/sessions', () => ({ getSession: jest.fn() }));
jest.mock('../services/bottleOps', () => ({ RESTORE_WINDOW_MS: 5 * 86400000 }));
jest.mock('../mcp/revert', () => ({
  revertLedgerRow: jest.fn(),
  // The route builds its revertible-action set from this at load time.
  reversibleActionsFor: () => ['consume', 'restore', 'add', 'update', 'bulk_add',
    'somm_maturity', 'somm_price', 'cellar_create', 'rack_create', 'place', 'unplace', 'move'],
}));
jest.mock('../models/McpActionLog', () => ({
  find: jest.fn(),
  findOne: jest.fn(),
  countDocuments: jest.fn(),
}));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const McpActionLog = require('../models/McpActionLog');
const { revertLedgerRow } = require('../mcp/revert');
const { handleMcpRequest, initStatefulSession } = require('../mcp/server');
const { getSession } = require('../mcp/sessions');
const mcpRouter = require('./mcp');

let server, baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/mcp', mcpRouter);
  server = http.createServer(app);
  server.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => {
  server.closeAllConnections();
  server.close(done);
});
beforeEach(() => jest.clearAllMocks());

const token = (claims = { id: 'u1', roles: ['user'] }) =>
  jwt.sign(claims, process.env.JWT_SECRET, { algorithm: 'HS256' });

const request = (method, path, body, tok = token()) =>
  fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });

// find(...).sort(...).skip(...).limit(...).lean() chain
const findChain = (rows) => {
  const c = {};
  c.sort = jest.fn(() => c);
  c.skip = jest.fn(() => c);
  c.limit = jest.fn(() => c);
  c.lean = jest.fn(() => Promise.resolve(rows));
  return c;
};

describe('GET /api/mcp/activity', () => {
  test('unauthenticated is rejected', async () => {
    const res = await request('GET', '/api/mcp/activity', null, null);
    expect(res.status).toBe(401);
  });

  test('returns the caller-scoped timeline with revert flags + window', async () => {
    const now = Date.now();
    const rows = [
      { _id: 'a1', tool: 'consume_bottle', action: 'consume', result: { summary: 'Consumed the 2015 Barolo' },
        cellar: 'c1', bottle: 'b1', tokenId: null, reversed: false, viaUndo: false, createdAt: new Date(now - DAY) },
      { _id: 'a2', tool: 'add_bottle', action: 'add', result: { summary: 'Added a bottle' },
        cellar: 'c1', bottle: 'b2', tokenId: 'tok9', reversed: true, viaUndo: false, createdAt: new Date(now - 2 * DAY) },
      { _id: 'a3', tool: 'add_bottle', action: 'add', result: { summary: 'Old add' },
        cellar: 'c1', bottle: 'b3', tokenId: null, reversed: false, viaUndo: false, createdAt: new Date(now - 40 * DAY) },
    ];
    McpActionLog.find.mockReturnValue(findChain(rows));
    McpActionLog.countDocuments.mockResolvedValue(3);

    const res = await request('GET', '/api/mcp/activity');
    expect(res.status).toBe(200);
    const body = await res.json();

    // caller-scoped query that hides never-applied previews (bulk + arrange)
    expect(McpActionLog.find).toHaveBeenCalledWith({ user: 'u1', action: { $nin: ['bulk_preview', 'arrange_preview'] } });
    expect(body.total).toBe(3);
    expect(body.revert_window_days).toBe(5);
    expect(body.activity).toHaveLength(3);

    // fresh, un-reversed, session-origin → revertible
    expect(body.activity[0]).toMatchObject({ id: 'a1', by: 'session', reversed: false, revertible: true });
    expect(body.activity[0].summary).toMatch(/Barolo/);
    // already reversed → not revertible, marked by token
    expect(body.activity[1]).toMatchObject({ id: 'a2', by: 'token', reversed: true, revertible: false });
    // older than the window → shown as history only
    expect(body.activity[2]).toMatchObject({ id: 'a3', revertible: false });

    // never leaks token material
    expect(JSON.stringify(body)).not.toMatch(/tok9/);
  });

  test('limit is clamped to [1,100] and skip to >=0', async () => {
    McpActionLog.find.mockReturnValue(findChain([]));
    McpActionLog.countDocuments.mockResolvedValue(0);
    await request('GET', '/api/mcp/activity?limit=9999&skip=-5');
    const chain = McpActionLog.find.mock.results[0].value;
    expect(chain.limit).toHaveBeenCalledWith(100);
    expect(chain.skip).toHaveBeenCalledWith(0);
  });

  test('falls back to a synthetic summary when result has none', async () => {
    McpActionLog.find.mockReturnValue(findChain([
      { _id: 'a1', tool: 'move_bottle', action: 'move', result: null,
        cellar: 'c1', bottle: null, tokenId: null, reversed: false, viaUndo: false, createdAt: new Date() },
    ]));
    McpActionLog.countDocuments.mockResolvedValue(1);
    const res = await request('GET', '/api/mcp/activity');
    const body = await res.json();
    expect(body.activity[0].summary).toBe('move_bottle (move)');
  });

  test('non-reversible action types (undo records) are shown but never revertible', async () => {
    McpActionLog.find.mockReturnValue(findChain([
      { _id: 'u1', tool: 'undo_last', action: 'undo_add', result: { summary: 'Undid add' },
        cellar: 'c1', bottle: null, tokenId: null, reversed: false, viaUndo: true, createdAt: new Date() },
    ]));
    McpActionLog.countDocuments.mockResolvedValue(1);
    const res = await request('GET', '/api/mcp/activity');
    const body = await res.json();
    expect(body.activity[0].revertible).toBe(false);
  });
});

describe('POST /api/mcp/activity/:id/revert', () => {
  const OID = '507f1f77bcf86cd799439011';

  test('malformed (non-ObjectId) :id → 404, never a cast 500, no DB hit', async () => {
    const res = await request('POST', '/api/mcp/activity/notanid/revert');
    expect(res.status).toBe(404);
    expect(McpActionLog.findOne).not.toHaveBeenCalled();
    expect(revertLedgerRow).not.toHaveBeenCalled();
  });

  test('404 when the row is not the caller\'s', async () => {
    McpActionLog.findOne.mockResolvedValue(null);
    const res = await request('POST', `/api/mcp/activity/${OID}/revert`);
    expect(res.status).toBe(404);
    expect(McpActionLog.findOne).toHaveBeenCalledWith({ _id: OID, user: 'u1' });
    expect(revertLedgerRow).not.toHaveBeenCalled();
  });

  test('409 when already reversed', async () => {
    McpActionLog.findOne.mockResolvedValue({ _id: 'a1', reversed: true, viaUndo: false, createdAt: new Date() });
    const res = await request('POST', `/api/mcp/activity/${OID}/revert`);
    expect(res.status).toBe(409);
    expect(revertLedgerRow).not.toHaveBeenCalled();
  });

  test('400 when the row is itself an undo record', async () => {
    McpActionLog.findOne.mockResolvedValue({ _id: 'a1', reversed: false, viaUndo: true, createdAt: new Date() });
    const res = await request('POST', `/api/mcp/activity/${OID}/revert`);
    expect(res.status).toBe(400);
    expect(revertLedgerRow).not.toHaveBeenCalled();
  });

  test('409 when older than the revert window (engine never runs)', async () => {
    McpActionLog.findOne.mockResolvedValue({ _id: 'a1', reversed: false, viaUndo: false, createdAt: new Date(Date.now() - 40 * DAY) });
    const res = await request('POST', `/api/mcp/activity/${OID}/revert`);
    expect(res.status).toBe(409);
    expect(revertLedgerRow).not.toHaveBeenCalled();
  });

  test('success passes a full-authority ctx to the engine and returns its envelope', async () => {
    McpActionLog.findOne.mockResolvedValue({ _id: 'a1', action: 'consume', reversed: false, viaUndo: false, createdAt: new Date() });
    revertLedgerRow.mockImplementation((row, ctx, h) => h.ok('Undid consume — bottle back', { undone: 'consume_bottle' }));
    const res = await request('POST', `/api/mcp/activity/${OID}/revert`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ reverted: true, summary: 'Undid consume — bottle back', data: { undone: 'consume_bottle' } });
    const ctx = revertLedgerRow.mock.calls[0][1];
    expect(ctx.user.id).toBe('u1');
    expect(ctx.scopes).toEqual(['read', 'consume', 'write']); // browser session = full personal authority
    expect(ctx.req).toBeDefined();
  });

  test.each([
    ['conflict', 409],
    ['not_found', 404],
    ['forbidden_scope', 403],
    ['invalid_input', 400],
    ['weird_unknown', 400],
  ])('maps engine failure %s → HTTP %i', async (code, status) => {
    McpActionLog.findOne.mockResolvedValue({ _id: 'a1', action: 'consume', reversed: false, viaUndo: false, createdAt: new Date() });
    revertLedgerRow.mockImplementation((row, ctx, h) => h.fail(code, 'nope'));
    const res = await request('POST', `/api/mcp/activity/${OID}/revert`);
    expect(res.status).toBe(status);
    const body = await res.json();
    expect(body).toMatchObject({ error: 'nope', code });
  });
});

describe('stateful session dispatch (plan §4)', () => {
  const mkSession = () => ({
    callState: { calls: 7 }, // stale from the previous request
    ctx: { user: { id: 'u1' }, scopes: ['read'], req: null },
    transport: { handleRequest: jest.fn(async (req, res) => res.status(200).json({ routed: true })) },
  });

  test('POST with Mcp-Session-Id routes to the session transport, resets the call budget, swaps req', async () => {
    const session = mkSession();
    getSession.mockReturnValue(session);
    const res = await fetch(`${baseUrl}/api/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}`, 'Mcp-Session-Id': 'sid-1' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(200);
    expect(getSession).toHaveBeenCalledWith('sid-1', { userId: 'u1', tokenId: undefined });
    expect(session.transport.handleRequest).toHaveBeenCalledTimes(1);
    expect(session.callState.calls).toBe(0);          // per-REQUEST budget reset
    expect(session.ctx.req).toBeTruthy();             // audit attribution follows the caller
    expect(handleMcpRequest).not.toHaveBeenCalled();  // never double-handled
    expect(initStatefulSession).not.toHaveBeenCalled();
  });

  test('unknown/foreign/expired session id → 404 JSON-RPC error, nothing handled', async () => {
    getSession.mockReturnValue(null);
    const res = await fetch(`${baseUrl}/api/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}`, 'Mcp-Session-Id': 'stolen' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe(-32001);
    expect(handleMcpRequest).not.toHaveBeenCalled();
  });

  test('initialize without a session header tries a stateful session first, falls back stateless on caps', async () => {
    // "Handled" means the fn answered the HTTP request itself — mimic that.
    initStatefulSession.mockImplementationOnce(async (req, r) => { r.status(200).json({ stateful: true }); return true; });
    let res = await request('POST', '/api/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    expect(res.status).toBe(200);
    expect(initStatefulSession).toHaveBeenCalledTimes(1);
    expect(handleMcpRequest).not.toHaveBeenCalled();

    initStatefulSession.mockResolvedValueOnce(false); // cap hit
    handleMcpRequest.mockImplementationOnce(async (req, r) => r.status(200).json({ stateless: true }));
    res = await request('POST', '/api/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    expect(res.status).toBe(200);
    expect(handleMcpRequest).toHaveBeenCalledTimes(1);
  });

  test('non-initialize POST without a header stays stateless (no session minted)', async () => {
    handleMcpRequest.mockImplementationOnce(async (req, r) => r.status(200).json({}));
    await request('POST', '/api/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(initStatefulSession).not.toHaveBeenCalled();
    expect(handleMcpRequest).toHaveBeenCalledTimes(1);
  });

  test('GET: session → transport (SSE); no header → 405; dead session → 404', async () => {
    const session = mkSession();
    getSession.mockReturnValue(session);
    let res = await fetch(`${baseUrl}/api/mcp`, {
      method: 'GET', headers: { Authorization: `Bearer ${token()}`, 'Mcp-Session-Id': 'sid-1' },
    });
    expect(res.status).toBe(200);
    expect(session.transport.handleRequest).toHaveBeenCalledTimes(1);

    res = await request('GET', '/api/mcp');
    expect(res.status).toBe(405);

    getSession.mockReturnValue(null);
    res = await fetch(`${baseUrl}/api/mcp`, {
      method: 'GET', headers: { Authorization: `Bearer ${token()}`, 'Mcp-Session-Id': 'gone' },
    });
    expect(res.status).toBe(404);
  });

  test('DELETE: session → transport (termination); no header → 405', async () => {
    const session = mkSession();
    getSession.mockReturnValue(session);
    let res = await fetch(`${baseUrl}/api/mcp`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${token()}`, 'Mcp-Session-Id': 'sid-1' },
    });
    expect(res.status).toBe(200);
    expect(session.transport.handleRequest).toHaveBeenCalledTimes(1);

    res = await request('DELETE', '/api/mcp');
    expect(res.status).toBe(405);
  });
});
