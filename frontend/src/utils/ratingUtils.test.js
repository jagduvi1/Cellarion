import {
  SCALE_META,
  VALID_SCALES,
  toNormalized,
  fromNormalized,
  convertRating,
  formatRating,
  allScales,
  formatDelta,
  isValidRating,
} from './ratingUtils';

// ---------------------------------------------------------------------------
// SCALE_META & VALID_SCALES
// ---------------------------------------------------------------------------
describe('SCALE_META', () => {
  it('contains entries for all three scales', () => {
    expect(SCALE_META).toHaveProperty('5');
    expect(SCALE_META).toHaveProperty('20');
    expect(SCALE_META).toHaveProperty('100');
  });

  it('has correct min/max for the star scale', () => {
    expect(SCALE_META['5'].min).toBe(1);
    expect(SCALE_META['5'].max).toBe(5);
  });

  it('has correct min/max for the davis scale', () => {
    expect(SCALE_META['20'].min).toBe(1);
    expect(SCALE_META['20'].max).toBe(20);
  });

  it('has correct min/max for the parker scale', () => {
    expect(SCALE_META['100'].min).toBe(50);
    expect(SCALE_META['100'].max).toBe(100);
  });
});

describe('VALID_SCALES', () => {
  it('contains exactly the three scale keys', () => {
    expect(VALID_SCALES).toEqual(expect.arrayContaining(['5', '20', '100']));
    expect(VALID_SCALES).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// toNormalized
// ---------------------------------------------------------------------------
describe('toNormalized', () => {
  it('returns null for null input', () => {
    expect(toNormalized(null, '5')).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(toNormalized(undefined, '5')).toBeNull();
  });

  it('returns null for NaN input', () => {
    expect(toNormalized(NaN, '5')).toBeNull();
  });

  it('returns null for non-numeric string', () => {
    expect(toNormalized('abc', '100')).toBeNull();
  });

  // Star scale anchors
  it('star 1.0 normalizes to 0', () => {
    expect(toNormalized(1.0, '5')).toBe(0);
  });

  it('star 5.0 normalizes to 100', () => {
    expect(toNormalized(5.0, '5')).toBe(100);
  });

  it('star 3.0 normalizes to 50', () => {
    expect(toNormalized(3.0, '5')).toBe(50);
  });

  // Parker scale anchors
  it('parker 60 normalizes to 0', () => {
    expect(toNormalized(60, '100')).toBe(0);
  });

  it('parker 100 normalizes to 100', () => {
    expect(toNormalized(100, '100')).toBe(100);
  });

  it('parker 82 normalizes to 50', () => {
    expect(toNormalized(82, '100')).toBe(50);
  });

  // Davis scale anchors
  it('davis 8.0 normalizes to 0', () => {
    expect(toNormalized(8.0, '20')).toBe(0);
  });

  it('davis 20.0 normalizes to 100', () => {
    expect(toNormalized(20.0, '20')).toBe(100);
  });

  it('davis 14.5 normalizes to 50', () => {
    expect(toNormalized(14.5, '20')).toBe(50);
  });

  // Values below the minimum anchor clamp to 0
  it('clamps star 0.5 (below min anchor) to 0', () => {
    expect(toNormalized(0.5, '5')).toBe(0);
  });

  it('clamps parker 50 (below min anchor) to 0', () => {
    expect(toNormalized(50, '100')).toBe(0);
  });

  // Unknown scale falls back to star scale
  it('treats unknown scale as star scale', () => {
    expect(toNormalized(5.0, 'unknown')).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// fromNormalized
// ---------------------------------------------------------------------------
describe('fromNormalized', () => {
  it('returns null for null input', () => {
    expect(fromNormalized(null, '5')).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(fromNormalized(undefined, '100')).toBeNull();
  });

  it('returns null for NaN input', () => {
    expect(fromNormalized(NaN, '20')).toBeNull();
  });

  // Normalized 0 maps to min of each scale
  it('0 maps to star 1.0', () => {
    expect(fromNormalized(0, '5')).toBe(1.0);
  });

  it('0 maps to davis 8.0', () => {
    expect(fromNormalized(0, '20')).toBe(8.0);
  });

  it('0 maps to parker 60', () => {
    expect(fromNormalized(0, '100')).toBe(60);
  });

  // Normalized 100 maps to max of each scale
  it('100 maps to star 5.0', () => {
    expect(fromNormalized(100, '5')).toBe(5.0);
  });

  it('100 maps to davis 20.0', () => {
    expect(fromNormalized(100, '20')).toBe(20.0);
  });

  it('100 maps to parker 100', () => {
    expect(fromNormalized(100, '100')).toBe(100);
  });

  // Midpoint (50) maps to expected anchor values
  it('50 maps to star 3.0', () => {
    expect(fromNormalized(50, '5')).toBe(3.0);
  });

  it('50 maps to davis 14.5', () => {
    expect(fromNormalized(50, '20')).toBe(14.5);
  });

  it('50 maps to parker 82', () => {
    expect(fromNormalized(50, '100')).toBe(82);
  });

  // Unknown scale falls back to star
  it('falls back to star scale for unknown target', () => {
    expect(fromNormalized(100, 'foo')).toBe(5.0);
  });
});

// ---------------------------------------------------------------------------
// convertRating
// ---------------------------------------------------------------------------
describe('convertRating', () => {
  it('returns null for null value', () => {
    expect(convertRating(null, '5', '100')).toBeNull();
  });

  it('returns null for NaN value', () => {
    expect(convertRating(NaN, '5', '100')).toBeNull();
  });

  it('returns same numeric value when scales are the same', () => {
    expect(convertRating(4.5, '5', '5')).toBe(4.5);
    expect(convertRating(92, '100', '100')).toBe(92);
  });

  it('converts star 5.0 to parker 100', () => {
    expect(convertRating(5.0, '5', '100')).toBe(100);
  });

  it('converts parker 60 to star 1.0', () => {
    expect(convertRating(60, '100', '5')).toBe(1.0);
  });

  it('converts star 1.0 to davis 8.0', () => {
    expect(convertRating(1.0, '5', '20')).toBe(8.0);
  });

  it('converts davis 20.0 to parker 100', () => {
    expect(convertRating(20.0, '20', '100')).toBe(100);
  });

  it('converts parker 82 to star 3.0', () => {
    expect(convertRating(82, '100', '5')).toBe(3.0);
  });

  it('converts string numeric value correctly', () => {
    expect(convertRating('5.0', '5', '100')).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// formatRating
// ---------------------------------------------------------------------------
describe('formatRating', () => {
  it('returns em-dash for null', () => {
    expect(formatRating(null, '5')).toBe('—');
  });

  it('returns em-dash for undefined', () => {
    expect(formatRating(undefined, '100')).toBe('—');
  });

  it('returns em-dash for NaN', () => {
    expect(formatRating(NaN, '20')).toBe('—');
  });

  it('formats star rating with star suffix', () => {
    expect(formatRating(4.6, '5')).toBe('4.6★');
  });

  it('formats parker rating with pts suffix', () => {
    expect(formatRating(92, '100')).toBe('92pts');
  });

  it('formats davis rating with /20 suffix', () => {
    expect(formatRating(17.5, '20')).toBe('17.5/20');
  });

  it('formats integer star rating with one decimal place', () => {
    expect(formatRating(4, '5')).toBe('4.0★');
  });

  it('formats parker rating with zero decimal places', () => {
    expect(formatRating(85, '100')).toBe('85pts');
  });

  it('falls back to star format for unknown scale', () => {
    expect(formatRating(3.5, 'unknown')).toBe('3.5★');
  });
});

// ---------------------------------------------------------------------------
// allScales
// ---------------------------------------------------------------------------
describe('allScales', () => {
  it('returns null for null value', () => {
    expect(allScales(null, '5')).toBeNull();
  });

  it('returns null for NaN value', () => {
    expect(allScales(NaN, '100')).toBeNull();
  });

  it('returns object with star, davis, parker, and normalized keys', () => {
    const result = allScales(5.0, '5');
    expect(result).toHaveProperty('star');
    expect(result).toHaveProperty('davis');
    expect(result).toHaveProperty('parker');
    expect(result).toHaveProperty('normalized');
  });

  it('returns correct values for star 5.0', () => {
    const result = allScales(5.0, '5');
    expect(result.star).toBe('5.0★');
    expect(result.davis).toBe('20.0/20');
    expect(result.parker).toBe('100pts');
    expect(result.normalized).toBe(100);
  });

  it('returns correct values for star 1.0 (minimum)', () => {
    const result = allScales(1.0, '5');
    expect(result.star).toBe('1.0★');
    expect(result.davis).toBe('8.0/20');
    expect(result.parker).toBe('60pts');
    expect(result.normalized).toBe(0);
  });

  it('returns correct cross-scale conversion for parker 82', () => {
    const result = allScales(82, '100');
    expect(result.parker).toBe('82pts');
    expect(result.star).toBe('3.0★');
    expect(result.davis).toBe('14.5/20');
    expect(result.normalized).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// formatDelta
// ---------------------------------------------------------------------------
describe('formatDelta', () => {
  it('returns em-dash for null', () => {
    expect(formatDelta(null, '5')).toBe('—');
  });

  it('returns em-dash for undefined', () => {
    expect(formatDelta(undefined, '100')).toBe('—');
  });

  it('returns em-dash for NaN', () => {
    expect(formatDelta(NaN, '20')).toBe('—');
  });

  it('formats a positive delta on the star scale', () => {
    const result = formatDelta(10, '5');
    // Should produce a positive numeric string with ★ suffix
    expect(result).toMatch(/^\d+\.\d★$/);
    const numeric = parseFloat(result);
    expect(numeric).toBeGreaterThan(0);
  });

  it('formats a negative delta on the parker scale', () => {
    const result = formatDelta(-10, '100');
    // Negative delta should produce a negative numeric string with pts suffix
    expect(result).toMatch(/^-\d+pts$/);
    const numeric = parseInt(result);
    expect(numeric).toBeLessThan(0);
  });

  it('formats zero delta', () => {
    const result = formatDelta(0, '5');
    expect(result).toMatch(/^0\.0★$/);
  });

  it('formats a positive delta on the davis scale', () => {
    const result = formatDelta(25, '20');
    expect(result).toMatch(/^\d+\.\d\/20$/);
    const numeric = parseFloat(result);
    expect(numeric).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// isValidRating
// ---------------------------------------------------------------------------
describe('isValidRating', () => {
  // Valid ranges
  it('returns true for star rating at minimum (1)', () => {
    expect(isValidRating(1, '5')).toBe(true);
  });

  it('returns true for star rating at maximum (5)', () => {
    expect(isValidRating(5, '5')).toBe(true);
  });

  it('returns true for star rating in the middle (3.5)', () => {
    expect(isValidRating(3.5, '5')).toBe(true);
  });

  it('returns true for davis rating in range', () => {
    expect(isValidRating(15, '20')).toBe(true);
  });

  it('returns true for parker rating at minimum (50)', () => {
    expect(isValidRating(50, '100')).toBe(true);
  });

  it('returns true for parker rating at maximum (100)', () => {
    expect(isValidRating(100, '100')).toBe(true);
  });

  // Out-of-range
  it('returns false for star rating below minimum (0.5)', () => {
    expect(isValidRating(0.5, '5')).toBe(false);
  });

  it('returns false for star rating above maximum (5.1)', () => {
    expect(isValidRating(5.1, '5')).toBe(false);
  });

  it('returns false for parker rating below minimum (49)', () => {
    expect(isValidRating(49, '100')).toBe(false);
  });

  it('returns false for parker rating above maximum (101)', () => {
    expect(isValidRating(101, '100')).toBe(false);
  });

  it('returns false for davis rating below minimum (0)', () => {
    expect(isValidRating(0, '20')).toBe(false);
  });

  it('returns false for davis rating above maximum (21)', () => {
    expect(isValidRating(21, '20')).toBe(false);
  });

  // Null / NaN / unknown
  it('returns false for null value', () => {
    expect(isValidRating(null, '5')).toBe(false);
  });

  it('returns false for undefined value', () => {
    expect(isValidRating(undefined, '100')).toBe(false);
  });

  it('returns false for NaN value', () => {
    expect(isValidRating(NaN, '20')).toBe(false);
  });

  it('returns false for unknown scale', () => {
    expect(isValidRating(3, 'unknown')).toBe(false);
  });

  it('returns false for no scale', () => {
    expect(isValidRating(3)).toBe(false);
  });
});
