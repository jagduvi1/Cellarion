/**
 * Retail barcode normalisation — mirrors the backend's rules
 * (backend/src/utils/barcode.test.js), since the camera decides on this side
 * whether a code it read is worth looking up.
 */
import { describe, it, expect } from 'vitest';
import { normalizeBarcode, gs1CheckDigit, sharedBarcode, vintageBarcodeTargets } from './barcode';

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

describe('sharedBarcode', () => {
  test('the one code the bottles carry; a bottle without one does not count against it', () => {
    expect(sharedBarcode([{ barcode: '7310070000002' }, { barcode: '7310070000002' }])).toBe('7310070000002');
    expect(sharedBarcode([{ barcode: '7310070000002' }, { barcode: null }])).toBe('7310070000002');
  });
  test('none, or codes that differ: null', () => {
    expect(sharedBarcode([{}, { barcode: '' }])).toBeNull();
    expect(sharedBarcode([{ barcode: '7310070000002' }, { barcode: '0012345678905' }])).toBeNull();
    expect(sharedBarcode([])).toBeNull();
    expect(sharedBarcode(undefined)).toBeNull();
  });
});

describe('vintageBarcodeTargets', () => {
  const b = (id, bottleSize, barcode) => ({ _id: id, bottleSize, barcode });
  test('only the main size: a magnum is another product with another code', () => {
    const list = [b('1', '750ml'), b('2', '750ml'), b('3', '1500ml')];
    expect(vintageBarcodeTargets(list).map((x) => x._id)).toEqual(['1', '2']);
  });
  test('the most common size wins; 75 cl on a tie; a missing size is 75 cl', () => {
    expect(vintageBarcodeTargets([b('1', '375ml'), b('2', '375ml'), b('3', '750ml')]).map((x) => x._id)).toEqual(['1', '2']);
    expect(vintageBarcodeTargets([b('1', '1500ml'), b('2', undefined)]).map((x) => x._id)).toEqual(['2']);
  });
  test('one code between them: all of the main size (it is the code being changed)', () => {
    const list = [b('1', '750ml', '7310070000002'), b('2', '750ml')];
    expect(vintageBarcodeTargets(list).map((x) => x._id)).toEqual(['1', '2']);
  });
  test('different codes: only the bottles with none — a bottle keeps its own code', () => {
    const list = [b('1', '750ml', '7310070000002'), b('2', '750ml', '0012345678905'), b('3', '750ml')];
    expect(vintageBarcodeTargets(list).map((x) => x._id)).toEqual(['3']);
    expect(vintageBarcodeTargets(list.slice(0, 2))).toEqual([]);
  });
  test('no bottles: none', () => {
    expect(vintageBarcodeTargets([])).toEqual([]);
  });
});
