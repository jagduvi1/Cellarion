import { formatVintage } from './vintage';

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
