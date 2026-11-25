/**
 * utils/proposalSnapshot — the one shape a correction proposal's snapshot and
 * the admin review's live values share. The sommelier tool, the member path
 * and the review route each pin their own answers; this file pins the shape
 * itself, and the cases where the three used to be free to differ.
 */
const { grapeLabel, styleLabel, identitySnapshot } = require('./proposalSnapshot');

test('the snapshot carries the nine identity fields and the sweetness style: region and country as names, grapes and the style as one string', () => {
  expect(identitySnapshot({
    producer: 'E. Pira e Figli', name: 'Barolo Cannubi', appellation: 'Barolo',
    region: { name: 'Piedmont' }, country: { name: 'Italy' }, classification: 'Riserva',
    type: 'red', colour: null, grapes: [{ name: 'Nebbiolo' }, { name: 'Barbera' }],
    sweetnessStyle: { term: { name: 'feinherb' }, source: 'trade', url: 'https://merchant.example/wine' },
  })).toEqual({
    producer: 'E. Pira e Figli', name: 'Barolo Cannubi', appellation: 'Barolo',
    region: 'Piedmont', country: 'Italy', classification: 'Riserva',
    type: 'red', colour: null, grapes: 'Nebbiolo, Barbera', sweetnessStyle: 'feinherb (trade)',
  });
});

test('a blank or missing field is null, never an empty string or undefined', () => {
  const snapshot = identitySnapshot({ producer: '', name: 'X' });
  expect(snapshot).toEqual({
    producer: null, name: 'X', appellation: null, region: null, country: null,
    classification: null, type: null, colour: null, grapes: null, sweetnessStyle: null,
  });
  expect(Object.keys(snapshot)).toHaveLength(10);
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

test('styleLabel reads the stored style, the shape a read sends and a proposed style the same way', () => {
  expect(styleLabel({ term: { name: 'feinherb' }, source: 'trade' })).toBe('feinherb (trade)');
  expect(styleLabel({ name: 'feinherb', band: 'off-dry', source: 'producer', sourceUrl: 'https://x.example/' })).toBe('feinherb (producer)');
  expect(styleLabel({ term: 'fruchtsüß', source: 'producer', url: 'https://x.example/' })).toBe('fruchtsüß (producer)');
});

test('a style whose term is not populated, and no style, contribute nothing', () => {
  expect(styleLabel({ source: 'trade' })).toBeNull();
  expect(styleLabel({ term: { _id: '64b0000000000000000000aa' }, source: 'trade' })).toBeNull();
  expect(styleLabel(null)).toBeNull();
  expect(styleLabel(undefined)).toBeNull();
  expect(identitySnapshot({ name: 'X' }).sweetnessStyle).toBeNull();
});
