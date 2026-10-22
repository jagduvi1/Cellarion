/**
 * The public API document and the token allowlist (middleware/apiTokenAuth.js)
 * describe the same surface: every documented operation is reachable with the
 * scope it names and refused with the others, and every allowlist rule is
 * covered by a documented operation (MCP is documented separately).
 */
const { buildOpenApiDocument } = require('./document');
const { createValidator } = require('./validator');
const { isRequestAllowed, classifyRequest, SCOPE_ALLOWLIST } = require('../middleware/apiTokenAuth');
const { DEPRECATED_RULES } = require('../config/apiDeprecations');
const { TOKEN_SCOPES } = require('../models/ApiToken');

const v = createValidator(buildOpenApiDocument({ version: 'test' }));
const SAMPLE_ID = '66f0a1b2c3d4e5f6a7b8c906';
const concrete = (path) => path.replace(/\{bottleId\}/g, SAMPLE_ID).replace(/\{(\w+)\}/g, 'x');

// Allowlist rules documented elsewhere: the MCP endpoint (docs/mcp-connect.md).
const DOCUMENTED_ELSEWHERE = [/\\\/api\\\/mcp\$/];

const tokenOps = v.operations().filter((o) => o.scopes.length > 0);

test.each(tokenOps.map((o) => [o.operationId, o]))('%s is reachable exactly with its scope', (_, o) => {
  const path = concrete(o.path);
  const needs = o.scopes.flat();
  for (const scope of TOKEN_SCOPES) {
    const expected = needs.length === 0 || needs.includes(scope); // [] = any token
    expect([scope, isRequestAllowed([scope], o.method, path)]).toEqual([scope, expected]);
  }
});

test('every allowlist rule is a documented operation', () => {
  const uncovered = [];
  for (const [scope, rules] of Object.entries(SCOPE_ALLOWLIST)) {
    for (const rule of rules) {
      if (DOCUMENTED_ELSEWHERE.some((re) => re.test(rule.pattern.source))) continue;
      const covered = tokenOps.some((o) => o.method === rule.method && rule.pattern.test(concrete(o.path)) && o.scopes.flat().includes(scope));
      if (!covered) uncovered.push(`${scope} ${rule.method} ${rule.pattern}`);
    }
  }
  expect(uncovered).toEqual([]);
});

test('no documented operation is on its way out', () => {
  for (const o of tokenOps) {
    const scopes = o.scopes.flat().length ? o.scopes.flat() : TOKEN_SCOPES; // [] = any token
    for (const scope of scopes) {
      expect([o.operationId, classifyRequest([scope], o.method, concrete(o.path))]).toEqual([o.operationId, 'allowed']);
    }
  }
});

test('deprecated rules only ever admit read-scope GETs', () => {
  expect(Object.keys(DEPRECATED_RULES)).toEqual(['read']);
  expect(DEPRECATED_RULES.read.every((r) => r.method === 'GET')).toBe(true);
});

test('operations without a token are the public ones', () => {
  const open = v.operations().filter((o) => o.scopes.length === 0).map((o) => o.operationId).sort();
  expect(open).toEqual(['getHealth', 'getOpenApiDocument', 'getThumbnail']);
});
