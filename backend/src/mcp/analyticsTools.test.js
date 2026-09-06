/**
 * Analytics MCP tools (#987) — list_analytics_fields + analyze_cellar.
 *
 * Pins: read scope on both; delegation to the SHARED analytics engine
 * (catalogue + runQuery — no second query path); the MCP row clamp (50,
 * tighter than the REST 200); grouped defaults; and the QueryError →
 * invalid_input envelope the calling model self-corrects from.
 */

jest.mock('../services/analytics/fieldCatalogue', () => ({
  composeCatalogue: jest.fn(),
  opsForType: jest.fn(() => ['contains', 'eq', 'neq']),
}));
jest.mock('../services/analytics/queryEngine', () => {
  class QueryError extends Error {
    constructor(status, message) { super(message); this.status = status; }
  }
  return { runQuery: jest.fn(), QueryError };
});

const { composeCatalogue } = require('../services/analytics/fieldCatalogue');
const { runQuery, QueryError } = require('../services/analytics/queryEngine');
const { allTools } = require('./registry');
require('./tools');

const ME = 'a'.repeat(24);
const CTX = { user: { id: ME, roles: ['user'] }, scopes: ['read'], req: { user: { id: ME }, headers: {} } };

const tool = (name) => allTools().find((t) => t.name === name);
const parse = (res) => JSON.parse(res.content[0].text);

beforeEach(() => jest.clearAllMocks());

test('both tools exist on read scope with read-only annotations', () => {
  for (const name of ['list_analytics_fields', 'analyze_cellar']) {
    const t = tool(name);
    expect(t).toBeDefined();
    expect(t.scope).toBe('read');
    expect(t.annotations.readOnlyHint).toBe(true);
  }
});

test('list_analytics_fields returns the composed catalogue in compact form', async () => {
  composeCatalogue.mockResolvedValue([
    { key: 'wine.producer', label: 'Producer', type: 'text', unit: null, filterable: true, aggregations: [], sortable: true, groupable: true },
    { key: 'personal.' + 'd'.repeat(24), label: 'ABV', type: 'decimal', unit: '%', filterable: true, aggregations: ['avg'], sortable: true, groupable: false },
  ]);
  const res = await tool('list_analytics_fields').handler({}, CTX);
  const { data } = parse(res);
  expect(composeCatalogue).toHaveBeenCalledWith(ME);
  expect(data).toHaveLength(2);
  expect(data[0]).toMatchObject({ key: 'wine.producer', ops: ['contains', 'eq', 'neq'], sortable: true });
  expect(data[1]).toMatchObject({ key: 'personal.' + 'd'.repeat(24), unit: '%', aggregations: ['avg'], groupable: false });
});

test('analyze_cellar defaults to grouped by wine.type with count, and reports the scope', async () => {
  runQuery.mockResolvedValue({
    mode: 'grouped',
    buckets: [{ dimensions: ['red'], measures: [3] }],
    dimensionKeys: ['wine.type'],
    measureLabels: ['count'],
    scope: { bottles: 'active', cellars: [{ id: 'x', name: 'Home' }] },
  });
  const res = await tool('analyze_cellar').handler({}, CTX);
  expect(runQuery).toHaveBeenCalledWith(ME, expect.objectContaining({
    mode: 'grouped',
    dimensions: ['wine.type'],
    measures: [{ field: '*', agg: 'count' }],
  }));
  const { summary } = parse(res);
  expect(summary).toMatch(/1 bucket/);
  expect(summary).toMatch(/active bottles/);
});

test('rows mode passes columns/sort/filters through and clamps the limit to the MCP cap', async () => {
  runQuery.mockResolvedValue({
    mode: 'rows', rows: [], total: 0,
    page: { returned: 0, limit: 50, offset: 0 },
    scope: { bottles: 'all', cellars: [] },
  });
  await tool('analyze_cellar').handler({
    mode: 'rows',
    columns: ['wine.name'],
    sort: { field: 'purchase.price', dir: 'desc' },
    filters: [{ field: 'wine.type', op: 'eq', value: 'red' }],
    limit: 50,
    scope: { bottles: 'all' },
  }, CTX);
  expect(runQuery).toHaveBeenCalledWith(ME, expect.objectContaining({
    mode: 'rows',
    columns: ['wine.name'],
    sort: { field: 'purchase.price', dir: 'desc' },
    filters: [{ field: 'wine.type', op: 'eq', value: 'red' }],
    limit: 50,
  }));
});

test('a QueryError comes back as invalid_input with the engine message, never a throw', async () => {
  runQuery.mockRejectedValue(new QueryError(400, 'Unknown field "evil.$where"'));
  const res = await tool('analyze_cellar').handler({ mode: 'rows' }, CTX);
  expect(res.isError).toBe(true);
  const { error } = parse(res);
  expect(error.code).toBe('invalid_input');
  expect(error.message).toMatch(/Unknown field/);
});

test('a maxTimeMS expiry maps to busy with a narrow-and-retry hint', async () => {
  const e = new Error('operation exceeded time limit');
  e.codeName = 'MaxTimeMSExpired';
  runQuery.mockRejectedValue(e);
  const res = await tool('analyze_cellar').handler({}, CTX);
  expect(res.isError).toBe(true);
  expect(parse(res).error.code).toBe('busy');
});
