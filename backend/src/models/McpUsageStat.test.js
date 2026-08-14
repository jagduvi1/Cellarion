/**
 * McpUsageStat.record — the fire-and-forget counter behind the admin MCP usage
 * view. Two things matter here and neither was covered: it must never throw or
 * await (a stats hiccup must not fail a tool call), and the error CODE it
 * $incs becomes a Mongo FIELD NAME, so an unsanitised code could nest or
 * reject the whole update.
 */
const mongoose = require('mongoose');

jest.mock('mongoose', () => {
  const actual = jest.requireActual('mongoose');
  return { ...actual, connection: { readyState: 1 } };
});

const McpUsageStat = require('./McpUsageStat');

let updateOne;
beforeEach(() => {
  mongoose.connection.readyState = 1;
  updateOne = jest.spyOn(McpUsageStat, 'updateOne').mockReturnValue(Promise.resolve());
});
afterEach(() => jest.restoreAllMocks());

const incOf = () => updateOne.mock.calls[0][1].$inc;

test('a successful call bumps calls only — no error counter, no code bucket', () => {
  McpUsageStat.record({ surface: 'personal', kind: 'tool', name: 'get_wine', error: false });
  expect(incOf()).toEqual({ calls: 1, errorCount: 0 });
});

test('a failed call buckets by code alongside the flat count', () => {
  McpUsageStat.record({ surface: 'public', kind: 'tool', name: 'find_similar_wines', error: true, code: 'invalid_input' });
  expect(incOf()).toEqual({ calls: 1, errorCount: 1, 'errorCodes.invalid_input': 1 });
});

test('a failure with no code still buckets, as unknown — never a bare errorCount', () => {
  McpUsageStat.record({ surface: 'personal', kind: 'tool', name: 'x', error: true });
  expect(incOf()).toEqual({ calls: 1, errorCount: 1, 'errorCodes.unknown': 1 });
});

test('dots and $ in a code are neutralised — they would nest the counter or be rejected outright', () => {
  McpUsageStat.record({ surface: 'personal', kind: 'tool', name: 'x', error: true, code: '$weird.code' });
  const keys = Object.keys(incOf()).filter((k) => k.startsWith('errorCodes.'));
  expect(keys).toEqual(['errorCodes._weird_code']);
});

test('the day key is UTC midnight, so a row is one calendar day regardless of server TZ', () => {
  McpUsageStat.record({ surface: 'personal', kind: 'tool', name: 'x', error: false });
  const { day } = updateOne.mock.calls[0][0];
  expect([day.getUTCHours(), day.getUTCMinutes(), day.getUTCSeconds(), day.getUTCMilliseconds()]).toEqual([0, 0, 0, 0]);
});

test('an over-long tool name is truncated to the schema max', () => {
  McpUsageStat.record({ surface: 'personal', kind: 'tool', name: 'n'.repeat(200), error: false });
  expect(updateOne.mock.calls[0][0].name).toHaveLength(100);
});

test('no live connection → no write at all (keeps the unit-tested handlers DB-free)', () => {
  mongoose.connection.readyState = 0;
  McpUsageStat.record({ surface: 'personal', kind: 'tool', name: 'x', error: true, code: 'boom' });
  expect(updateOne).not.toHaveBeenCalled();
});

test('a rejected write is swallowed — instrumentation must never fail the tool call', async () => {
  updateOne.mockReturnValue(Promise.reject(new Error('mongo down')));
  expect(() => McpUsageStat.record({ surface: 'personal', kind: 'tool', name: 'x', error: false })).not.toThrow();
  await new Promise((r) => setImmediate(r)); // let the rejection settle unhandled-free
});
