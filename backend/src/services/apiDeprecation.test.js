/**
 * Deprecated-route bookkeeping (services/apiDeprecation): uses are counted per
 * route shape, so ids and years collapse and the count says WHICH route is
 * still in use, never by whom. The real write is in openapi/contract.test.js.
 */
const { routeKey, recordDeprecatedUse } = require('./apiDeprecation');

test('ids and numbers collapse into the route shape', () => {
  expect(routeKey('/api/cellars/66f0a1b2c3d4e5f6a7b8c902/statistics')).toBe('/api/cellars/:id/statistics');
  expect(routeKey('/api/cellars/66F0A1B2C3D4E5F6A7B8C902/vintages/66f0a1b2c3d4e5f6a7b8c905/2015'))
    .toBe('/api/cellars/:id/vintages/:id/:n');
  expect(routeKey('/api/stats/value-history')).toBe('/api/stats/value-history');
});

test('without a database connection nothing is queued', async () => {
  await expect(recordDeprecatedUse('GET', '/api/stats/value-history')).resolves.toBeUndefined();
});
