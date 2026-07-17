/**
 * WineList total-entry cap (security audit H1).
 *
 * The public, unauthenticated PDF endpoint renders every entry synchronously
 * and buffers the whole document in the backend heap, so an uncapped list is a
 * whole-service DoS. The cap is enforced in a pre('save') hook (so EVERY write
 * path — REST create/update/duplicate + the MCP add_to_list tool — is covered)
 * via the exported entryCapError helper, tested directly here.
 */

const WineList = require('./WineList');
const { MAX_ENTRIES_PER_LIST: MAX, countWineListEntries, entryCapError } = WineList;

const entry = () => ({ wine: '5f'.repeat(12), vintage: '2019', bottleSize: '750ml' });

test('exports a sane cap', () => {
  expect(typeof MAX).toBe('number');
  expect(MAX).toBeGreaterThan(0);
  expect(MAX).toBeLessThanOrEqual(1000);
});

test('counts the TOTAL across autoGroupEntries + every section', () => {
  expect(countWineListEntries({ autoGroupEntries: [entry(), entry()] })).toBe(2);
  expect(countWineListEntries({ sections: [{ entries: [entry()] }, { entries: [entry(), entry()] }] })).toBe(3);
  expect(countWineListEntries({})).toBe(0);
});

test('at/under the cap → no error; over the cap → ValidationError', () => {
  expect(entryCapError({ autoGroupEntries: Array.from({ length: MAX }, entry) })).toBeNull();

  const err = entryCapError({ autoGroupEntries: Array.from({ length: MAX + 1 }, entry) });
  expect(err).toBeTruthy();
  expect(err.name).toBe('ValidationError'); // → REST 400 / MCP invalid_input
  expect(err.message).toMatch(/at most/);
});

test('the cap is enforced across BOTH containers (a mode-flip can\'t double it)', () => {
  const err = entryCapError({
    sections: [{ entries: Array.from({ length: MAX }, entry) }],
    autoGroupEntries: [entry()],
  });
  expect(err).toBeTruthy();
  expect(err.name).toBe('ValidationError');
});
