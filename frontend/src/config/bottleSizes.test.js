import { BOTTLE_SIZES, bottleSizeLabel, formatVolume, mlFromCode, normalizeBottleSize } from './bottleSizes';
import en from '../locales/en/translation.json';

// Stand-in for i18n's t(): resolves the dotted key against the en bundle so a
// missing bottleSizeNames entry shows up as a failing label, not as the raw key
// silently rendered to the user.
const t = (key) => key.split('.').reduce((acc, part) => (acc == null ? undefined : acc[part]), en);

describe('BOTTLE_SIZES', () => {
  test('is sorted ascending by volume — the pickers render it in array order', () => {
    const mls = BOTTLE_SIZES.map((s) => s.ml);
    expect(mls).toEqual([...mls].sort((a, b) => a - b));
  });

  test('every entry has an en translation for its nameKey', () => {
    for (const s of BOTTLE_SIZES) {
      expect(en.bottleSizeNames[s.nameKey]).toBeTruthy();
    }
  });

  test('every code round-trips through normalizeBottleSize', () => {
    for (const s of BOTTLE_SIZES) {
      expect(normalizeBottleSize(s.code)).toBe(s.code);
      expect(mlFromCode(s.code)).toBe(s.ml);
    }
  });

  test('includes the 1 litre format', () => {
    expect(BOTTLE_SIZES.find((s) => s.code === '1000ml')).toBeTruthy();
  });
});

describe('bottleSizeLabel', () => {
  test('names the litre bottle', () => {
    expect(bottleSizeLabel('1000ml', t)).toBe('1 L (Litre)');
  });

  test('keeps the existing formats intact', () => {
    expect(bottleSizeLabel('750ml', t)).toBe('750 ml (Standard)');
    expect(bottleSizeLabel('1500ml', t)).toBe('1.5 L (Magnum)');
  });

  test('falls back to a bare volume for an unnamed code', () => {
    expect(bottleSizeLabel('900ml', t)).toBe('900 ml');
  });
});

describe('normalizeBottleSize — litre inputs', () => {
  test.each([
    ['100cl', '1000ml'],
    ['1L', '1000ml'],
    ['1 litre', '1000ml'],
    ['1,0 l', '1000ml'],
    [1, '1000ml'],
  ])('%p → %p', (input, expected) => {
    expect(normalizeBottleSize(input)).toBe(expected);
  });
});

test('formatVolume renders a litre without trailing zeros', () => {
  expect(formatVolume(1000)).toBe('1 L');
});
