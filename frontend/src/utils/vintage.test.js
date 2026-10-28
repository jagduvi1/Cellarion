import { formatVintage, parseVintageInput, vintageInputProps } from './vintage';

const t = (key, fallback) => ({ 'common.nonVintage': 'Uten årgang', 'common.unknownVintage': 'Ukjent årgang' }[key] ?? fallback);

describe('formatVintage', () => {
  test('shows a year as it is', () => {
    expect(formatVintage(2015, t)).toBe('2015');
    expect(formatVintage('1999', t)).toBe('1999');
  });

  test('translates the stored codes', () => {
    expect(formatVintage('NV', t)).toBe('Uten årgang');
    expect(formatVintage('Unknown', t)).toBe('Ukjent årgang');
  });

  test('reads the codes case-insensitively, as vintage URLs can carry them', () => {
    expect(formatVintage('nv', t)).toBe('Uten årgang');
    expect(formatVintage('unknown', t)).toBe('Ukjent årgang');
  });

  test('keeps the English codes when no translation exists', () => {
    const fallbackOnly = (key, fallback) => fallback;
    expect(formatVintage('NV', fallbackOnly)).toBe('NV');
    expect(formatVintage('Unknown', fallbackOnly)).toBe('Unknown');
  });

  test('returns an empty string for a missing vintage', () => {
    expect(formatVintage(null, t)).toBe('');
    expect(formatVintage(undefined, t)).toBe('');
    expect(formatVintage('', t)).toBe('');
  });
});

describe('parseVintageInput', () => {
  test('maps the translated words back to the stored codes, in any case', () => {
    expect(parseVintageInput('Uten årgang', t)).toBe('NV');
    expect(parseVintageInput('  uten ÅRGANG ', t)).toBe('NV');
    expect(parseVintageInput('Ukjent årgang', t)).toBe('Unknown');
  });

  test('still accepts the English codes', () => {
    expect(parseVintageInput('nv', t)).toBe('NV');
    expect(parseVintageInput('UNKNOWN', t)).toBe('Unknown');
  });

  test('leaves years and anything else to the usual validation', () => {
    expect(parseVintageInput(' 2015 ', t)).toBe('2015');
    expect(parseVintageInput('', t)).toBe('');
    expect(parseVintageInput('abc', t)).toBe('abc');
  });
});

describe('vintageInputProps', () => {
  // The browser compiles pattern with the v flag and anchors it itself.
  const accepts = (props, value) => new RegExp(props.pattern, 'v').test(value);

  test('accepts years, the codes and the translated words', () => {
    const props = vintageInputProps(t);
    for (const value of ['2015', '1999', 'NV', 'nv', 'Unknown', 'unknown', 'Uten årgang', 'uten Årgang', 'Ukjent årgang']) {
      expect(accepts(props, value)).toBe(true);
    }
    for (const value of ['15', '1899', 'n.v.', 'Uten', 'abc']) {
      expect(accepts(props, value)).toBe(false);
    }
  });

  test('makes room for the longest word', () => {
    expect(vintageInputProps(t).maxLength).toBe('Ukjent årgang'.length);
    expect(vintageInputProps((key, fallback) => fallback).maxLength).toBe(7);
  });

  test('escapes a translation that contains pattern syntax', () => {
    const props = vintageInputProps((key, fallback) => (key === 'common.nonVintage' ? 'N.V.' : fallback));
    expect(accepts(props, 'n.v.')).toBe(true);
    expect(accepts(props, 'nxvx')).toBe(false);
  });
});

describe('parseVintageInput — hardening (release audit 2026-10-28)', () => {
  test('an empty field stays empty even when a locale ships an empty word', () => {
    const blank = (key, fallback) => (key === 'common.nonVintage' ? '' : fallback);
    expect(parseVintageInput('', blank)).toBe('');
    expect(parseVintageInput('   ', blank)).toBe('');
    expect(parseVintageInput('nv', blank)).toBe('NV');
  });
});
