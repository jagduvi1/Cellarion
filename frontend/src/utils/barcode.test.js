/**
 * Retail barcode normalisation — mirrors the backend's rules
 * (backend/src/utils/barcode.test.js), since the camera decides on this side
 * whether a code it read is worth looking up.
 */
import { describe, it, expect } from 'vitest';
import { normalizeBarcode, gs1CheckDigit } from './barcode';

describe('normalizeBarcode', () => {
  it('accepts valid EAN-13, EAN-8, UPC-A and GTIN-14 in one canonical form', () => {
    expect(normalizeBarcode('4006381333931')).toBe('4006381333931');
    expect(normalizeBarcode('96385074')).toBe('96385074');
    expect(normalizeBarcode('036000291452')).toBe('0036000291452');
    expect(normalizeBarcode('04006381333931')).toBe('4006381333931');
  });

  it('refuses misreads, odd lengths and shop-internal numbers', () => {
    expect(normalizeBarcode('4006381333932')).toBeNull();
    expect(normalizeBarcode('12345')).toBeNull();
    expect(normalizeBarcode('211234567890' + gs1CheckDigit('211234567890'))).toBeNull();
    expect(normalizeBarcode('0123456' + gs1CheckDigit('0123456'))).toBeNull();
    expect(normalizeBarcode(undefined)).toBeNull();
  });
});
