/**
 * Retail barcode normalisation.
 *
 * WHY THIS TEST EXISTS:
 * A barcode links one member's bottle to the wine another member scans. A
 * misread, a shop-internal number or two spellings of one product would link
 * the wrong wines or split the right one, so only checksum-valid public GTINs
 * pass, in one canonical form.
 */
const { normalizeBarcode, gs1CheckDigit } = require('./barcode');

describe('gs1CheckDigit', () => {
  it('computes the GS1 mod-10 check digit', () => {
    expect(gs1CheckDigit('400638133393')).toBe(1); // 4006381333931
    expect(gs1CheckDigit('03600029145')).toBe(2); // UPC-A 036000291452
    expect(gs1CheckDigit('9638507')).toBe(4); // EAN-8 96385074
  });
});

describe('normalizeBarcode', () => {
  it('keeps a valid EAN-13 and drops spaces and dashes', () => {
    expect(normalizeBarcode('4006381333931')).toBe('4006381333931');
    expect(normalizeBarcode(' 4006381-333931 ')).toBe('4006381333931');
    expect(normalizeBarcode(4006381333931)).toBe('4006381333931');
  });

  it('gives UPC-A and padded GTIN-14 the same EAN-13 form', () => {
    expect(normalizeBarcode('036000291452')).toBe('0036000291452');
    expect(normalizeBarcode('04006381333931')).toBe('4006381333931');
  });

  it('keeps an EAN-8 and a real GTIN-14', () => {
    expect(normalizeBarcode('96385074')).toBe('96385074');
    expect(normalizeBarcode('14006381333938')).toBe('14006381333938');
  });

  it('refuses a misread check digit, odd lengths and non-digits', () => {
    expect(normalizeBarcode('4006381333932')).toBeNull();
    expect(normalizeBarcode('400638133393')).toBeNull();
    expect(normalizeBarcode('40063813339a1')).toBeNull();
    expect(normalizeBarcode('0000000000000')).toBeNull();
    expect(normalizeBarcode('')).toBeNull();
    expect(normalizeBarcode(null)).toBeNull();
  });

  it('refuses shop-internal restricted numbers', () => {
    const withCheck = (body) => body + gs1CheckDigit(body);
    expect(normalizeBarcode(withCheck('211234567890'))).toBeNull(); // 2x: in-store / weighed goods
    expect(normalizeBarcode(withCheck('021234567890'))).toBeNull(); // 02x
    expect(normalizeBarcode(withCheck('0123456'))).toBeNull(); // EAN-8 0 prefix
    expect(normalizeBarcode(withCheck('2123456'))).toBeNull(); // EAN-8 2 prefix
  });
});
