/**
 * utils/registryKeyName — which accepted public key a member's name for it
 * means. Shared by registryDataOps (suggest by name) and the MCP personal-data
 * hint; the frontend mirrors the same rule.
 */
const { normaliseKeyName, matchKeyByName } = require('./registryKeyName');

const ABV = {
  _id: 'k1', name: 'ABV',
  translations: { sv: 'Alkoholhalt', de: 'Alkoholgehalt', fr: 'Degré d’alcool' },
};
const CLOSURE = { _id: 'k2', name: 'Closure', translations: new Map([['fr', 'Bouchage'], ['sv', 'Förslutning']]) };

describe('normaliseKeyName', () => {
  test('ignores case, accents and everything that is not a letter or a digit', () => {
    expect(normaliseKeyName("degré d'alcool")).toBe(normaliseKeyName('Degré d’alcool'));
    expect(normaliseKeyName('A.B.V.')).toBe('abv');
    expect(normaliseKeyName('  ABV % ')).toBe('abv');
    expect(normaliseKeyName('Förslutning')).toBe('forslutning');
  });

  test('nothing in, nothing out', () => {
    expect(normaliseKeyName(null)).toBe('');
    expect(normaliseKeyName(undefined)).toBe('');
    expect(normaliseKeyName('—')).toBe('');
  });
});

describe('matchKeyByName', () => {
  test('a canonical name matches in any spelling', () => {
    expect(matchKeyByName([ABV, CLOSURE], 'abv')).toBe(ABV);
    expect(matchKeyByName([ABV, CLOSURE], 'A.B.V')).toBe(ABV);
  });

  test('a translation matches, from a plain object or a Map', () => {
    expect(matchKeyByName([ABV, CLOSURE], 'Alkoholhalt')).toBe(ABV);
    expect(matchKeyByName([ABV, CLOSURE], "degré d'alcool")).toBe(ABV);
    expect(matchKeyByName([ABV, CLOSURE], 'forslutning')).toBe(CLOSURE);
  });

  test('a served displayName counts as a translation', () => {
    const served = { _id: 'k1', name: 'ABV', displayName: 'Alkoholgehalt' };
    expect(matchKeyByName([served], 'alkoholgehalt')).toBe(served);
  });

  test('an unknown or empty name matches nothing', () => {
    expect(matchKeyByName([ABV, CLOSURE], 'Residual sugar')).toBeNull();
    expect(matchKeyByName([ABV, CLOSURE], '%')).toBeNull();
    expect(matchKeyByName([ABV, CLOSURE], '')).toBeNull();
    expect(matchKeyByName(null, 'ABV')).toBeNull();
  });

  test('the canonical name wins over another key\'s translation', () => {
    const odd = { _id: 'k3', name: 'Strength', translations: { en_GB: 'ABV' } };
    expect(matchKeyByName([odd, ABV], 'ABV')).toBe(ABV);
  });

  test('a translation two keys share is a guess, so it matches neither', () => {
    const a = { _id: 'k4', name: 'Sugar', translations: { sv: 'Socker' } };
    const b = { _id: 'k5', name: 'Residual sugar', translations: { sv: 'Socker' } };
    expect(matchKeyByName([a, b], 'socker')).toBeNull();
  });
});
