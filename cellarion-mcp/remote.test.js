import { test } from 'node:test';
import assert from 'node:assert/strict';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { makeRemote } from './remote.js';

// A fake remote: every connect() makes a new client (the first
// `failedConnects` attempts throw instead); each request takes the next answer
// from `answers` (an Error is thrown, anything else is returned).
function fakeRemote(answers, { failedConnects = 0 } = {}) {
  const clients = [];
  const sent = [];
  const answer = (client, method, params) => {
    sent.push({ client: client.id, method, params });
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  const connect = async () => {
    if (failedConnects > 0) {
      failedConnects -= 1;
      throw new Error('fetch failed');
    }
    const client = { id: clients.length + 1, closed: false };
    client.close = async () => { client.closed = true; };
    for (const method of ['listTools', 'callTool', 'listResources', 'listResourceTemplates', 'readResource']) {
      client[method] = async (params) => answer(client, method, params);
    }
    clients.push(client);
    return client;
  };
  return { remote: makeRemote(connect), clients, sent };
}

// What the SDK throws when the HTTP POST itself fails (a proxy 502, a reset
// socket): a plain Error, not an McpError.
const lostResponse = () => new Error('Streamable HTTP error: Error POSTing to endpoint (HTTP 502)');

test('a lost response to a read: reconnects and sends it again', async () => {
  const { remote, clients, sent } = fakeRemote([lostResponse(), { tools: [] }]);
  assert.deepEqual(await remote.listTools({}), { tools: [] });
  assert.equal(clients.length, 2);
  assert.equal(clients[0].closed, true);
  assert.deepEqual(sent.map((s) => s.client), [1, 2]);
});

for (const method of ['listResources', 'listResourceTemplates', 'readResource']) {
  test(`a lost response to ${method}: sent again`, async () => {
    const { remote, sent } = fakeRemote([lostResponse(), { ok: true }]);
    assert.deepEqual(await remote[method]({}), { ok: true });
    assert.equal(sent.length, 2);
  });
}

test('a lost response to a tool call without idempotency_key: the error comes back, nothing is sent twice', async () => {
  const { remote, clients, sent } = fakeRemote([lostResponse(), { content: [] }]);
  const params = { name: 'add_bottle', arguments: { wine_id: 'w1' } };
  await assert.rejects(remote.callTool(params), /HTTP 502/);
  assert.equal(sent.length, 1);
  assert.equal(clients[0].closed, true);
  assert.equal(clients.length, 1, 'no reconnect just to re-send');

  // The next call opens a fresh connection instead of reusing the dead one.
  assert.deepEqual(await remote.callTool({ name: 'list_cellars', arguments: {} }), { content: [] });
  assert.equal(clients.length, 2);
  assert.deepEqual(sent.map((s) => s.client), [1, 2]);
});

test('an empty or non-string idempotency_key does not make a tool call re-sendable', async () => {
  for (const key of ['', 42, null]) {
    const { remote, sent } = fakeRemote([lostResponse(), { content: [] }]);
    await assert.rejects(remote.callTool({ name: 'pour_glass', arguments: { idempotency_key: key } }), /HTTP 502/);
    assert.equal(sent.length, 1, `key ${JSON.stringify(key)}`);
  }
  const { remote, sent } = fakeRemote([lostResponse(), { content: [] }]);
  await assert.rejects(remote.callTool({ name: 'pour_glass' }), /HTTP 502/);
  assert.equal(sent.length, 1, 'no arguments at all');
});

test('a lost response to a tool call with idempotency_key: reconnects and sends it once more', async () => {
  const { remote, clients, sent } = fakeRemote([lostResponse(), { content: [{ type: 'text', text: '{}' }] }]);
  const params = { name: 'add_bottle', arguments: { wine_id: 'w1', idempotency_key: 'k-1' } };
  assert.deepEqual(await remote.callTool(params), { content: [{ type: 'text', text: '{}' }] });
  assert.equal(clients[0].closed, true);
  assert.deepEqual(sent.map((s) => [s.client, s.params]), [[1, params], [2, params]]);
});

// A tools/list answer as the server publishes it: every tool carries MCP
// annotations, readOnlyHint true for reads and false for writes.
const toolList = (tools) => ({
  tools: Object.entries(tools).map(([name, annotations]) => ({ name, inputSchema: { type: 'object' }, annotations })),
});
const CATALOGUE = toolList({
  search_bottles: { readOnlyHint: true },
  add_bottle: { readOnlyHint: false },
  get_source_info: {},
});

test('a lost response to a listed read-only tool: reconnects and sends it once more', async () => {
  const { remote, clients, sent } = fakeRemote([CATALOGUE, lostResponse(), { content: [] }]);
  await remote.listTools({});
  const params = { name: 'search_bottles', arguments: { query: 'barolo' } };
  assert.deepEqual(await remote.callTool(params), { content: [] });
  assert.equal(clients[0].closed, true);
  assert.deepEqual(sent.slice(1).map((s) => [s.client, s.params]), [[1, params], [2, params]]);
});

test('a listed write tool, or one without readOnlyHint true, is not sent again', async () => {
  for (const name of ['add_bottle', 'get_source_info']) {
    const { remote, sent } = fakeRemote([CATALOGUE, lostResponse(), { content: [] }]);
    await remote.listTools({});
    await assert.rejects(remote.callTool({ name, arguments: {} }), /HTTP 502/);
    assert.equal(sent.length, 2, name);
  }
});

test('a tool the bridge has not seen in a list is not sent again', async () => {
  const { remote, sent } = fakeRemote([lostResponse(), CATALOGUE, lostResponse(), { content: [] }]);
  await assert.rejects(remote.callTool({ name: 'search_bottles', arguments: {} }), /HTTP 502/, 'before any list');
  await remote.listTools({});
  await assert.rejects(remote.callTool({ name: 'list_cellars', arguments: {} }), /HTTP 502/, 'not in the list');
  assert.deepEqual(sent.map((s) => s.method), ['callTool', 'listTools', 'callTool']);
});

test('the read-only tools survive a reconnect', async () => {
  const { remote, clients, sent } = fakeRemote([CATALOGUE, lostResponse(), lostResponse(), { content: [] }]);
  await remote.listTools({});
  await assert.rejects(remote.callTool({ name: 'add_bottle', arguments: {} }), /HTTP 502/);
  // The second connection has not listed anything itself.
  assert.deepEqual(await remote.callTool({ name: 'search_bottles', arguments: {} }), { content: [] });
  assert.equal(clients.length, 3);
  assert.deepEqual(sent.map((s) => s.client), [1, 1, 2, 3]);
});

test('a list fetched again after a lost response is remembered', async () => {
  const { remote, sent } = fakeRemote([lostResponse(), CATALOGUE, lostResponse(), { content: [] }]);
  await remote.listTools({});
  assert.deepEqual(await remote.callTool({ name: 'search_bottles', arguments: {} }), { content: [] });
  assert.equal(sent.length, 4);
});

test('each full tool list replaces the read-only tools; a later page adds to them', async () => {
  const { remote, sent } = fakeRemote([
    CATALOGUE,
    toolList({ add_bottle: { readOnlyHint: false } }),
    toolList({ get_cellar: { readOnlyHint: true } }),
    lostResponse(),
    lostResponse(), { content: [] },
  ]);
  await remote.listTools({});
  await remote.listTools({});
  await remote.listTools({ cursor: 'page-2' });
  await assert.rejects(remote.callTool({ name: 'search_bottles', arguments: {} }), /HTTP 502/, 'gone from the new list');
  assert.deepEqual(await remote.callTool({ name: 'get_cellar', arguments: {} }), { content: [] });
  assert.equal(sent.length, 6);
});

// What the SDK throws when the server answers the POST with an HTTP error
// status: a StreamableHTTPError whose `code` is the status.
const httpError = (status, body) => new StreamableHTTPError(status, `Error POSTing to endpoint: ${body}`);
// The server's answer to a request on a session that has expired or that it
// does not know: 404, before it runs anything.
const sessionGone = () => httpError(404,
  '{"jsonrpc":"2.0","error":{"code":-32001,"message":"Session not found or expired — re-initialize (POST without Mcp-Session-Id)."},"id":null}');

test('an expired session (404) on a tool call without idempotency_key: reconnects and sends it once more', async () => {
  const { remote, clients, sent } = fakeRemote([sessionGone(), { content: [] }]);
  const params = { name: 'add_bottle', arguments: { wine_id: 'w1' } };
  assert.deepEqual(await remote.callTool(params), { content: [] });
  assert.equal(clients[0].closed, true);
  assert.deepEqual(sent.map((s) => [s.client, s.params]), [[1, params], [2, params]]);
});

test('a second 404, on the fresh session, comes back: no third send', async () => {
  const { remote, sent } = fakeRemote([sessionGone(), sessionGone(), { content: [] }]);
  await assert.rejects(remote.callTool({ name: 'add_bottle', arguments: {} }), (err) => err.code === 404);
  assert.equal(sent.length, 2);
});

test('a 502, 401 or 429 on a tool call without idempotency_key: the error comes back, nothing is sent twice', async () => {
  for (const status of [502, 401, 429]) {
    const { remote, sent } = fakeRemote([httpError(status, 'refused'), { content: [] }]);
    await assert.rejects(remote.callTool({ name: 'add_bottle', arguments: { wine_id: 'w1' } }), (err) => err.code === status);
    assert.equal(sent.length, 1, `HTTP ${status}`);
  }
});

test('a second failure after the re-send is not retried again', async () => {
  const { remote, sent } = fakeRemote([lostResponse(), lostResponse()]);
  await assert.rejects(remote.listTools({}), /HTTP 502/);
  assert.equal(sent.length, 2);
});

test('an answer from the server (McpError) comes back as is, on the same connection', async () => {
  const { remote, clients, sent } = fakeRemote([
    new McpError(ErrorCode.InvalidParams, 'bad arguments'),
    { content: [] },
  ]);
  await assert.rejects(remote.callTool({ name: 'add_bottle', arguments: { idempotency_key: 'k-2' } }), McpError);
  assert.equal(sent.length, 1);
  assert.equal(clients[0].closed, false);
  await remote.callTool({ name: 'list_cellars', arguments: {} });
  assert.equal(clients.length, 1, 'no reconnect');
  assert.deepEqual(sent.map((s) => s.client), [1, 1]);
});

test('a closed connection (McpError ConnectionClosed) on a tool call: not re-sent, the next call reconnects', async () => {
  const { remote, clients, sent } = fakeRemote([
    new McpError(ErrorCode.ConnectionClosed, 'Connection closed'),
    { content: [] },
  ]);
  await assert.rejects(remote.callTool({ name: 'pour_glass', arguments: {} }), McpError);
  assert.equal(sent.length, 1);
  await remote.callTool({ name: 'list_cellars', arguments: {} });
  assert.equal(clients.length, 2);
  assert.deepEqual(sent.map((s) => s.client), [1, 2]);
});

test('a request timeout is not re-sent and keeps the connection', async () => {
  const { remote, clients, sent } = fakeRemote([
    new McpError(ErrorCode.RequestTimeout, 'Request timed out'),
    { content: [] },
  ]);
  await assert.rejects(remote.callTool({ name: 'pour_glass', arguments: { idempotency_key: 'k-3' } }), McpError);
  await remote.callTool({ name: 'list_cellars', arguments: {} });
  assert.equal(clients.length, 1);
  assert.deepEqual(sent.map((s) => s.client), [1, 1]);
});

test('two calls failing at the same moment share one reconnect', async () => {
  const { remote, clients, sent } = fakeRemote([lostResponse(), lostResponse(), { ok: 1 }, { ok: 2 }]);
  await remote.open();
  assert.deepEqual(
    await Promise.all([remote.listResources({}), remote.listResources({})]),
    [{ ok: 1 }, { ok: 2 }],
  );
  assert.equal(clients.length, 2, 'connect called once after the failures');
  assert.deepEqual(sent.map((s) => s.client), [1, 1, 2, 2]);
});

test('two calls before any connection share one connect', async () => {
  const { remote, clients } = fakeRemote([{ ok: 1 }, { ok: 2 }]);
  await Promise.all([remote.listResources({}), remote.listResources({})]);
  assert.equal(clients.length, 1);
});

test('a failed connect is not kept: the next call connects again', async () => {
  const { remote, clients } = fakeRemote([{ ok: 1 }], { failedConnects: 1 });
  await assert.rejects(remote.listResources({}), /fetch failed/);
  assert.deepEqual(await remote.listResources({}), { ok: 1 });
  assert.equal(clients.length, 1);
});

test('open() connects eagerly and close() drops the connection', async () => {
  const { remote, clients } = fakeRemote([{ tools: [] }]);
  const client = await remote.open();
  assert.equal(client, clients[0]);
  await remote.close();
  assert.equal(clients[0].closed, true);
  await remote.listTools({});
  assert.equal(clients.length, 2, 'a call after close() reconnects');
});
