/**
 * Deprecated-route bookkeeping (services/apiDeprecation): uses are counted per
 * route Express matched, so the count says WHICH route is still in use, never
 * by whom, and a caller cannot invent rows with made-up paths. The real write
 * is in openapi/contract.test.js.
 */
const { matchedRoute, recordDeprecatedUse } = require('./apiDeprecation');

test('the key is the route as declared, never the requested path', () => {
  const req = { method: 'GET', baseUrl: '/api/cellars', route: { path: '/:id/statistics' }, path: '/66f0a1b2c3d4e5f6a7b8c902/statistics' };
  expect(matchedRoute(req)).toBe('GET /api/cellars/:id/statistics');
  expect(matchedRoute({ ...req, method: 'HEAD' })).toBe('GET /api/cellars/:id/statistics');
});

test('no matched route, or a failed answer, is not counted', async () => {
  expect(matchedRoute({ method: 'GET', baseUrl: '/api/cellars', path: '/made-up-path' })).toBeNull();
  await expect(recordDeprecatedUse({ method: 'GET', baseUrl: '/api/cellars' }, { statusCode: 404 })).resolves.toBeUndefined();
});

test('without a database connection nothing is queued', async () => {
  const req = { method: 'GET', baseUrl: '/api/stats', route: { path: '/value-history' } };
  await expect(recordDeprecatedUse(req, { statusCode: 200 })).resolves.toBeUndefined();
});
