import { normaliseKeyName, matchKeyByName } from './registryKeyName';

// Same rule as backend/src/utils/registryKeyName.js — the card steers by the
// name the server will resolve.
const ABV = { _id: 'k1', name: 'ABV', displayName: 'ABV', translations: { sv: 'Alkoholhalt', fr: 'Degré d’alcool' } };
const CLOSURE = { _id: 'k2', name: 'Closure', displayName: 'Closure', translations: { sv: 'Förslutning' } };

test('ignores case, accents and punctuation', () => {
  expect(normaliseKeyName("degré d'alcool")).toBe(normaliseKeyName('Degré d’alcool'));
  expect(normaliseKeyName(' A.B.V. % ')).toBe('abv');
  expect(normaliseKeyName(null)).toBe('');
});

test('matches the canonical name or one key\'s translation', () => {
  expect(matchKeyByName([ABV, CLOSURE], 'abv')).toBe(ABV);
  expect(matchKeyByName([ABV, CLOSURE], 'alkoholhalt')).toBe(ABV);
  expect(matchKeyByName([ABV, CLOSURE], "degre d'alcool")).toBe(ABV);
  expect(matchKeyByName([ABV, CLOSURE], 'forslutning')).toBe(CLOSURE);
});

test('an unknown, empty or shared name matches nothing', () => {
  expect(matchKeyByName([ABV, CLOSURE], 'Provenance')).toBeNull();
  expect(matchKeyByName([ABV, CLOSURE], ' ')).toBeNull();
  expect(matchKeyByName(undefined, 'ABV')).toBeNull();
  const a = { _id: 'k4', name: 'Sugar', translations: { sv: 'Socker' } };
  const b = { _id: 'k5', name: 'Residual sugar', translations: { sv: 'Socker' } };
  expect(matchKeyByName([a, b], 'socker')).toBeNull();
});
