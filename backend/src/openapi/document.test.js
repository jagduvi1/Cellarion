/**
 * The public API document (openapi/document.js) is well-formed, its examples
 * match its own schemas, and its enums are the code's. Without a database;
 * contract.test.js checks real answers against it.
 */
const { buildOpenApiDocument } = require('./document');
const { createValidator } = require('./validator');
const { RACK_TYPES } = require('../models/Rack');
const Bottle = require('../models/Bottle');
const WineDefinition = require('../models/WineDefinition');
const { TOKEN_SCOPES } = require('../models/ApiToken');
const { TYPES: PERSONAL_TYPES } = require('../utils/personalDataTypes');
const { CONSUMED_STATUSES } = require('../config/constants');

const doc = buildOpenApiDocument({ version: '9.9.9', serverUrl: 'https://cellar.example.org' });
const v = createValidator(doc);
const S = doc.components.schemas;
const values = (schema) => (schema.enum || []).filter((x) => x !== null);

test('is an OpenAPI 3.1 document for this server and version', () => {
  expect(doc.openapi).toBe('3.1.0');
  expect(doc.info.version).toBe('9.9.9');
  expect(doc.servers).toEqual([{ url: 'https://cellar.example.org' }]);
  expect(buildOpenApiDocument({ version: '1.2.3' }).servers[0].url).toBe('https://cellarion.app');
});

test('every operation has a unique id, a known tag, a summary and described responses', () => {
  const ops = v.operations();
  const ids = ops.map((o) => o.operationId);
  expect(new Set(ids).size).toBe(ids.length);
  const tags = new Set(doc.tags.map((t) => t.name));
  for (const o of ops) {
    expect(o.op.tags.every((t) => tags.has(t))).toBe(true);
    expect(o.op.summary).toEqual(expect.any(String));
    for (const r of Object.values(o.op.responses)) expect(v.resolve(r).description).toEqual(expect.any(String));
  }
  // Every tag is used.
  expect([...tags].filter((t) => !ops.some((o) => o.op.tags.includes(t)))).toEqual([]);
});

test('every operation has a curl and a Python sample, on this server\'s address', () => {
  for (const o of v.operations()) {
    const samples = o.op['x-codeSamples'] || [];
    expect([o.operationId, samples.map((s) => s.label)]).toEqual([o.operationId, ['curl', 'Python']]);
    for (const s of samples) {
      const urls = s.source.match(/https?:\/\/[^\s"/]+/g) || [];
      expect([o.operationId, urls.filter((u) => u !== 'https://cellar.example.org')]).toEqual([o.operationId, []]);
    }
  }
  expect(doc.info.description).toContain('## Getting started');
  expect(doc.info.description).toContain('curl -H "Authorization: Bearer $CELLARION_TOKEN" "https://cellar.example.org/api/inventory"');
});

test('every $ref resolves', () => {
  const refs = JSON.stringify(doc).match(/"\$ref":"[^"]+"/g) || [];
  const broken = refs
    .map((r) => r.slice(8, -1))
    .filter((r) => {
      const [, kind, name] = r.match(/^#\/components\/(\w+)\/(.+)$/) || [];
      return !kind || !doc.components[kind] || !doc.components[kind][name];
    });
  expect(broken).toEqual([]);
});

test('every schema compiles in strict mode', () => {
  for (const name of Object.keys(S)) {
    expect(() => v.check({ $ref: `#/components/schemas/${name}` }, null, name)).not.toThrow();
  }
});

test('every example matches its own schema', () => {
  const errors = [];
  const visit = (content, where) => {
    for (const [type, m] of Object.entries(content || {})) {
      if (type === 'application/json' && m.example !== undefined) errors.push(...v.check(m.schema, m.example, where));
    }
  };
  for (const o of v.operations()) {
    if (o.op.requestBody) visit(o.op.requestBody.content, `${o.operationId} request`);
    for (const [status, r] of Object.entries(o.op.responses)) visit(v.resolve(r).content, `${o.operationId} ${status}`);
  }
  for (const [name, r] of Object.entries(doc.components.responses)) visit(r.content, `responses.${name}`);
  expect(errors).toEqual([]);
});

test('the validator rejects what the document does not allow', () => {
  expect(v.validateResponse('whoAmI', { status: 200, contentType: 'application/json', body: { id: 42 } })).not.toEqual([]);
  expect(v.validateResponse('whoAmI', { status: 200, contentType: 'application/json', body: {} })).not.toEqual([]);
  expect(v.validateResponse('whoAmI', { status: 418, contentType: 'application/json', body: {} })).not.toEqual([]);
  expect(v.validateResponse('whoAmI', { status: 200, contentType: 'text/html', body: '<html>' })).not.toEqual([]);
  expect(v.validateResponse('getInventory', { status: 304, body: '' })).toEqual([]);
  expect(v.validateResponse('getInventory', { status: 200, contentType: 'application/json', body: { schema: 1 } })).not.toEqual([]);
  // A new field is fine: schemas stay open.
  expect(v.validateResponse('whoAmI', { status: 200, contentType: 'application/json', body: { id: '66f0a1b2c3d4e5f6a7b8c901', extra: true } })).toEqual([]);
});

test('enums are the code\'s', () => {
  expect(S.RackSummary.properties.type.enum).toEqual(RACK_TYPES);
  expect([...values(S.Bottle.properties.status)].sort()).toEqual([...Bottle.schema.path('status').enumValues].sort());
  expect(values(S.ConsumeRequest.properties.reason)).toEqual(CONSUMED_STATUSES);
  expect(values(S.Bottle.properties.consumedReason)).toEqual(CONSUMED_STATUSES);
  expect(values(S.WineSummary.properties.type)).toEqual(WineDefinition.schema.path('type').enumValues);
  expect(values(S.PersonalEntry.properties.type)).toEqual(PERSONAL_TYPES);
  for (const o of v.operations()) for (const s of o.scopes.flat()) expect(TOKEN_SCOPES).toContain(s);
});
