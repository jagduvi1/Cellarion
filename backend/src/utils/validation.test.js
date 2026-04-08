const { isValidId } = require('./validation');

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
