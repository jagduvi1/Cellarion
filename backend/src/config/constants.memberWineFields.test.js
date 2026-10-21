/**
 * The member wine reads all build on one list (MEMBER_WINE_HIDDEN_FIELDS).
 * These pin the two derived selects, so a field added to the list reaches
 * every member read and the bottle lists at once.
 */
const { MEMBER_WINE_HIDDEN_FIELDS, MEMBER_WINE_EXCLUDE_KEEP_CREATOR, WINE_LIST_SELECT } = require('./constants');

test('the list names the contributor fields', () => {
  expect(MEMBER_WINE_HIDDEN_FIELDS).toEqual(expect.arrayContaining(['createdBy', 'contribution', 'createdVia']));
});

test('WINE_LIST_SELECT excludes every member-hidden field', () => {
  const fields = WINE_LIST_SELECT.split(/\s+/);
  for (const f of MEMBER_WINE_HIDDEN_FIELDS) expect(fields).toContain(`-${f}`);
});

test('the keep-creator select excludes every member-hidden field except createdBy', () => {
  const fields = MEMBER_WINE_EXCLUDE_KEEP_CREATOR.split(/\s+/);
  expect(fields).not.toContain('-createdBy');
  for (const f of MEMBER_WINE_HIDDEN_FIELDS.filter((x) => x !== 'createdBy')) expect(fields).toContain(`-${f}`);
});
