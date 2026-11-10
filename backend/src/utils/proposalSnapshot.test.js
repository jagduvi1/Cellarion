/**
 * utils/proposalSnapshot — the one shape a correction proposal's snapshot and
 * the admin review's live values share. The sommelier tool, the member path
 * and the review route each pin their own answers; this file pins the shape
 * itself, and the cases where the three used to be free to differ.
 */
const { grapeLabel, identitySnapshot } = require('./proposalSnapshot');

test('the snapshot carries the nine identity fields, region and country as names, grapes as one string', () => {
  expect(identitySnapshot({
    producer: 'E. Pira e Figli', name: 'Barolo Cannubi', appellation: 'Barolo',
    region: { name: 'Piedmont' }, country: { name: 'Italy' }, classification: 'Riserva',
    type: 'red', colour: null, grapes: [{ name: 'Nebbiolo' }, { name: 'Barbera' }],
  })).toEqual({
    producer: 'E. Pira e Figli', name: 'Barolo Cannubi', appellation: 'Barolo',
    region: 'Piedmont', country: 'Italy', classification: 'Riserva',
    type: 'red', colour: null, grapes: 'Nebbiolo, Barbera',
  });
});

test('a blank or missing field is null, never an empty string or undefined', () => {
  const snapshot = identitySnapshot({ producer: '', name: 'X' });
  expect(snapshot).toEqual({
    producer: null, name: 'X', appellation: null, region: null, country: null,
    classification: null, type: null, colour: null, grapes: null,
  });
  expect(Object.keys(snapshot)).toHaveLength(9);
});

test('a grape reference that does not resolve to a document contributes nothing', () => {
  // A deleted variety populates as null; an unpopulated reference is a bare id.
  expect(identitySnapshot({ grapes: [{ name: 'Merlot' }, null, '64b0000000000000000000aa'] }).grapes).toBe('Merlot');
  expect(identitySnapshot({ grapes: [null] }).grapes).toBeNull();
  expect(identitySnapshot({ grapes: [] }).grapes).toBeNull();
});

test('grapeLabel joins a list of names and answers null for none', () => {
  expect(grapeLabel(['Syrah', 'Viognier'])).toBe('Syrah, Viognier');
  expect(grapeLabel([])).toBeNull();
  expect(grapeLabel(undefined)).toBeNull();
});
