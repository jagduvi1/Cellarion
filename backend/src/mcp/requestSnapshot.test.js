/**
 * Audit 2026-09 M01-1: a stateful MCP session must never retain the Express
 * request (and with it the parsed body). The snapshot has to satisfy every
 * consumer of ctx.req — attribution, ledger token id, rate-limit key — and
 * carry nothing else.
 */
jest.mock('../utils/cloudflareIps', () => ({ isCloudflareIP: (ip) => ip === '172.64.0.1' }));

const { snapshotRequest } = require('./requestSnapshot');
const { getClientIp, rateLimitKey } = require('../utils/clientIp');

const bigBody = { jsonrpc: '2.0', method: 'initialize', params: { pad: 'x'.repeat(1000) } };
const req = {
  user: { id: 'u1', roles: ['user'] },
  apiToken: { id: 't1', scopes: ['read'], hashed: 'must-not-travel' },
  ip: '172.64.0.1',
  headers: { 'cf-connecting-ip': '203.0.113.9', 'user-agent': 'ClaudeDesktop/1.0', cookie: 'secret=1' },
  body: bigBody,
  query: { q: 1 },
  params: { id: 'p' },
};

test('keeps only what attribution, the ledger and the budgets read', () => {
  const s = snapshotRequest(req);
  expect(s).toEqual({
    user: { id: 'u1', roles: ['user'] },
    apiToken: { id: 't1', scopes: ['read'] },
    ip: '203.0.113.9',
    headers: { 'user-agent': 'ClaudeDesktop/1.0' },
  });
  expect(s.body).toBeUndefined();
  expect(s.query).toBeUndefined();
  expect(s.params).toBeUndefined();
  expect(s.headers.cookie).toBeUndefined();
});

test('the client ip and the rate-limit key resolve the same as on the live request', () => {
  const s = snapshotRequest(req);
  expect(getClientIp(s)).toBe(getClientIp(req));
  expect(rateLimitKey(s)).toBe(rateLimitKey(req));
});

test('a JWT session (no api token) and a missing request are handled', () => {
  expect(snapshotRequest({ user: { id: 'u2' }, ip: '10.0.0.5', headers: {} })).toEqual({
    user: { id: 'u2' }, apiToken: undefined, ip: '10.0.0.5', headers: { 'user-agent': undefined },
  });
  expect(snapshotRequest(null)).toBeNull();
  expect(snapshotRequest(undefined)).toBeUndefined();
});
