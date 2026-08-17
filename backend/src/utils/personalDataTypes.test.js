/**
 * The shared typed-value system (#986) — every type's accept/reject/cast
 * behaviour, plus key-definition validation. This module is reused by the
 * public-vocabulary work (#985) and the analytics catalogue (#987), so these
 * pins are contract tests, not implementation details.
 */
const { TYPES, TEXT_MAX, validateValue, validateKeyDefinition } = require('./personalDataTypes');

describe('validateValue', () => {
  test('rejects unknown key types and empty values', () => {
    expect(validateValue(null, 'x').ok).toBe(false);
    expect(validateValue({ type: 'nope' }, 'x').ok).toBe(false);
    for (const type of TYPES) {
      expect(validateValue({ type }, '').ok).toBe(false);
      expect(validateValue({ type }, null).ok).toBe(false);
      expect(validateValue({ type }, undefined).ok).toBe(false);
    }
  });

  describe('text', () => {
    test('trims and accepts', () => {
      expect(validateValue({ type: 'text' }, '  decanted 2h  ')).toEqual({ ok: true, value: 'decanted 2h' });
    });
    test('rejects non-strings and over-long text', () => {
      expect(validateValue({ type: 'text' }, 42).ok).toBe(false);
      expect(validateValue({ type: 'text' }, 'x'.repeat(TEXT_MAX + 1)).ok).toBe(false);
      expect(validateValue({ type: 'text' }, 'x'.repeat(TEXT_MAX)).ok).toBe(true);
    });
    test('whitespace-only is empty', () => {
      expect(validateValue({ type: 'text' }, '   ').ok).toBe(false);
    });
  });

  describe('integer', () => {
    test('accepts whole numbers, numeric strings included', () => {
      expect(validateValue({ type: 'integer' }, 3)).toEqual({ ok: true, value: 3 });
      expect(validateValue({ type: 'integer' }, '12')).toEqual({ ok: true, value: 12 });
      expect(validateValue({ type: 'integer' }, '-4')).toEqual({ ok: true, value: -4 });
    });
    test('rejects decimals and non-numbers', () => {
      expect(validateValue({ type: 'integer' }, 3.5).ok).toBe(false);
      expect(validateValue({ type: 'integer' }, '3.5').ok).toBe(false);
      expect(validateValue({ type: 'integer' }, 'three').ok).toBe(false);
    });
    test('whitespace-only never becomes 0 (Number("") === 0 trap)', () => {
      expect(validateValue({ type: 'integer' }, ' ').ok).toBe(false);
      expect(validateValue({ type: 'integer' }, '\t').ok).toBe(false);
    });
  });

  describe('decimal', () => {
    test('accepts numbers and both decimal separators (Swedish keyboards type 13,5)', () => {
      expect(validateValue({ type: 'decimal' }, 13.5)).toEqual({ ok: true, value: 13.5 });
      expect(validateValue({ type: 'decimal' }, '13.5')).toEqual({ ok: true, value: 13.5 });
      expect(validateValue({ type: 'decimal' }, '13,5')).toEqual({ ok: true, value: 13.5 });
    });
    test('rejects non-finite, non-numeric and whitespace-only', () => {
      expect(validateValue({ type: 'decimal' }, 'abc').ok).toBe(false);
      expect(validateValue({ type: 'decimal' }, Infinity).ok).toBe(false);
      expect(validateValue({ type: 'decimal' }, NaN).ok).toBe(false);
      expect(validateValue({ type: 'decimal' }, '  ').ok).toBe(false);
    });
  });

  describe('boolean', () => {
    test('accepts booleans and yes/no/true/false strings', () => {
      expect(validateValue({ type: 'boolean' }, true)).toEqual({ ok: true, value: true });
      expect(validateValue({ type: 'boolean' }, 'Yes')).toEqual({ ok: true, value: true });
      expect(validateValue({ type: 'boolean' }, 'false')).toEqual({ ok: true, value: false });
      expect(validateValue({ type: 'boolean' }, 'No')).toEqual({ ok: true, value: false });
    });
    test('rejects anything else', () => {
      expect(validateValue({ type: 'boolean' }, 'maybe').ok).toBe(false);
      expect(validateValue({ type: 'boolean' }, 1).ok).toBe(false);
    });
  });

  describe('date', () => {
    test('accepts ISO calendar dates and keeps them as strings', () => {
      expect(validateValue({ type: 'date' }, '2026-08-17')).toEqual({ ok: true, value: '2026-08-17' });
    });
    test('rejects malformed and impossible dates', () => {
      expect(validateValue({ type: 'date' }, '17/08/2026').ok).toBe(false);
      expect(validateValue({ type: 'date' }, '2026-02-30').ok).toBe(false);
      expect(validateValue({ type: 'date' }, '2026-13-01').ok).toBe(false);
      expect(validateValue({ type: 'date' }, 'tomorrow').ok).toBe(false);
    });
  });

  describe('enum', () => {
    const key = { type: 'enum', enumOptions: ['cork', 'screwcap', 'crown'] };
    test('accepts exact members', () => {
      expect(validateValue(key, 'cork')).toEqual({ ok: true, value: 'cork' });
      expect(validateValue(key, ' screwcap ')).toEqual({ ok: true, value: 'screwcap' });
    });
    test('rejects non-members and keys without options', () => {
      expect(validateValue(key, 'plastic').ok).toBe(false);
      expect(validateValue({ type: 'enum', enumOptions: [] }, 'cork').ok).toBe(false);
      expect(validateValue({ type: 'enum' }, 'cork').ok).toBe(false);
    });
  });
});

describe('validateKeyDefinition', () => {
  test('requires name and a known type', () => {
    expect(validateKeyDefinition({}).ok).toBe(false);
    expect(validateKeyDefinition({ name: 'ABV' }).ok).toBe(false);
    expect(validateKeyDefinition({ name: 'ABV', type: 'percentage' }).ok).toBe(false);
    expect(validateKeyDefinition({ name: 'x'.repeat(61), type: 'text' }).ok).toBe(false);
  });

  test('keeps unit only on numeric keys', () => {
    const dec = validateKeyDefinition({ name: 'ABV', type: 'decimal', unit: '%' });
    expect(dec).toEqual({ ok: true, def: { name: 'ABV', type: 'decimal', unit: '%' } });
    const txt = validateKeyDefinition({ name: 'Provenance', type: 'text', unit: '%' });
    expect(txt.ok).toBe(true);
    expect(txt.def.unit).toBeUndefined();
  });

  test('enum keys need 2-20 deduped non-empty options within length', () => {
    expect(validateKeyDefinition({ name: 'Closure', type: 'enum', enumOptions: ['cork'] }).ok).toBe(false);
    expect(validateKeyDefinition({ name: 'Closure', type: 'enum', enumOptions: ['cork', 'cork', ' '] }).ok).toBe(false);
    const good = validateKeyDefinition({ name: 'Closure', type: 'enum', enumOptions: [' cork ', 'screwcap'] });
    expect(good.ok).toBe(true);
    expect(good.def.enumOptions).toEqual(['cork', 'screwcap']);
    expect(validateKeyDefinition({
      name: 'Big', type: 'enum', enumOptions: Array.from({ length: 21 }, (_, i) => `o${i}`),
    }).ok).toBe(false);
    expect(validateKeyDefinition({ name: 'Long', type: 'enum', enumOptions: ['ok', 'x'.repeat(41)] }).ok).toBe(false);
  });

  test('trims the name', () => {
    expect(validateKeyDefinition({ name: '  ABV  ', type: 'decimal' }).def.name).toBe('ABV');
  });
});
