const { isValidId, coerceStringQuery, parseAndValidateVintage } = require('./validation');
const { escapeRegex } = require('./sanitize');

describe('coerceStringQuery', () => {
  it('returns the string unchanged', () => {
    expect(coerceStringQuery('hello')).toBe('hello');
    expect(coerceStringQuery('')).toBe('');
  });
  it('returns "" for the object/array shapes Express produces for ?x[$gt]=', () => {
    expect(coerceStringQuery({ $gt: '' })).toBe('');
    expect(coerceStringQuery(['a', 'b'])).toBe('');
    expect(coerceStringQuery(undefined)).toBe('');
    expect(coerceStringQuery(null)).toBe('');
    expect(coerceStringQuery(123)).toBe('');
  });
});

describe('escapeRegex (total)', () => {
  it('escapes regex metacharacters', () => {
    expect(escapeRegex('a.b*c')).toBe('a\\.b\\*c');
    expect(escapeRegex('(x)[y]')).toBe('\\(x\\)\\[y\\]');
  });
  it('never throws on non-string input (coerces to "")', () => {
    expect(escapeRegex(undefined)).toBe('');
    expect(escapeRegex(null)).toBe('');
    // String({...}) is '[object Object]' — the [ and ] get escaped like any literal.
    expect(escapeRegex({ $gt: '' })).toBe('\\[object Object\\]');
    expect(() => escapeRegex(['a'])).not.toThrow();
  });
});

describe('isValidId', () => {
  it('accepts a valid 24-char hex string', () => {
    expect(isValidId('507f1f77bcf86cd799439011')).toBe(true);
  });

  it('rejects non-string values', () => {
    expect(isValidId(123)).toBe(false);
    expect(isValidId(null)).toBe(false);
    expect(isValidId(undefined)).toBe(false);
    expect(isValidId({ $gt: '' })).toBe(false);
    expect(isValidId(['507f1f77bcf86cd799439011'])).toBe(false);
  });

  it('rejects invalid strings', () => {
    expect(isValidId('')).toBe(false);
    expect(isValidId('not-an-id')).toBe(false);
    expect(isValidId('507f1f77bcf86cd79943901')).toBe(false); // 23 chars
  });
});

describe('parseAndValidateVintage', () => {
  // Fix "now" so tests don't drift as years pass
  const now = new Date('2026-05-03T00:00:00Z');

  it('treats blank, null, undefined as NV', () => {
    expect(parseAndValidateVintage(undefined, { now })).toEqual({ ok: true, value: 'NV' });
    expect(parseAndValidateVintage(null, { now })).toEqual({ ok: true, value: 'NV' });
    expect(parseAndValidateVintage('', { now })).toEqual({ ok: true, value: 'NV' });
    expect(parseAndValidateVintage('   ', { now })).toEqual({ ok: true, value: 'NV' });
  });

  it('accepts the literal "NV" in any case', () => {
    expect(parseAndValidateVintage('NV', { now })).toEqual({ ok: true, value: 'NV' });
    expect(parseAndValidateVintage('nv', { now })).toEqual({ ok: true, value: 'NV' });
    expect(parseAndValidateVintage(' Nv ', { now })).toEqual({ ok: true, value: 'NV' });
  });

  it('accepts the literal "Unknown" in any case', () => {
    expect(parseAndValidateVintage('Unknown', { now })).toEqual({ ok: true, value: 'Unknown' });
    expect(parseAndValidateVintage('unknown', { now })).toEqual({ ok: true, value: 'Unknown' });
    expect(parseAndValidateVintage(' UNKNOWN ', { now })).toEqual({ ok: true, value: 'Unknown' });
  });

  it('accepts plausible vintage years and returns canonical string', () => {
    expect(parseAndValidateVintage('2018', { now })).toEqual({ ok: true, value: '2018' });
    expect(parseAndValidateVintage(2018, { now })).toEqual({ ok: true, value: '2018' });
    expect(parseAndValidateVintage(' 2018 ', { now })).toEqual({ ok: true, value: '2018' });
    expect(parseAndValidateVintage('1900', { now })).toEqual({ ok: true, value: '1900' });
  });

  it('rejects the typo case (1001) that triggered this rule', () => {
    const result = parseAndValidateVintage('1001', { now });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/out of range/i);
  });

  it('rejects years before 1900', () => {
    expect(parseAndValidateVintage('1899', { now }).ok).toBe(false);
    expect(parseAndValidateVintage('0', { now }).ok).toBe(false);
    expect(parseAndValidateVintage('-2018', { now }).ok).toBe(false);
  });

  it('rejects years more than 5 ahead of current year', () => {
    // currentYear = 2026, max = 2031
    expect(parseAndValidateVintage('2031', { now }).ok).toBe(true);
    expect(parseAndValidateVintage('2032', { now }).ok).toBe(false);
    expect(parseAndValidateVintage('9999', { now }).ok).toBe(false);
  });

  it('rejects non-integer strings', () => {
    expect(parseAndValidateVintage('2018.5', { now }).ok).toBe(false);
    expect(parseAndValidateVintage('20a1', { now }).ok).toBe(false);
    expect(parseAndValidateVintage('2018 abc', { now }).ok).toBe(false);
    expect(parseAndValidateVintage('two thousand', { now }).ok).toBe(false);
  });
});
