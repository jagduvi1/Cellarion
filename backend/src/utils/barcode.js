/**
 * Retail barcodes (GTINs) on wine bottles: EAN-13 in most of the world, UPC-A
 * in North America, EAN-8 on small packs, GTIN-14 on cases.
 *
 * normalizeBarcode() returns ONE canonical form per product, or null:
 *   - digits only (spaces and dashes a scanner or a person adds are dropped);
 *   - the GS1 check digit must be right — a misread almost never passes it;
 *   - UPC-A (12) becomes its EAN-13 form ("0" + code), and a GTIN-14 that only
 *     pads an EAN-13 loses the padding, so the same bottle scanned as UPC in
 *     one shop and EAN in another is one code;
 *   - restricted-circulation numbers are refused: prefixes 20–29 and 02 (and
 *     0/2 on EAN-8) are assigned by each shop for its own use — weighed goods,
 *     in-store labels — so the same number means different things in different
 *     shops and must never link two bottles.
 *
 * Kept in step with frontend/src/utils/barcode.js.
 */

const isDigits = (s) => /^\d+$/.test(s);

/** GS1 mod-10 check digit for the digits BEFORE the check digit. */
function gs1CheckDigit(body) {
  let sum = 0;
  for (let i = body.length - 1, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) {
    sum += Number(body[i]) * w;
  }
  return (10 - (sum % 10)) % 10;
}

function hasValidCheckDigit(code) {
  return gs1CheckDigit(code.slice(0, -1)) === Number(code[code.length - 1]);
}

function normalizeBarcode(raw) {
  if (raw == null) return null;
  const s = String(raw).replace(/[\s-]/g, '');
  if (!isDigits(s) || /^0+$/.test(s)) return null;

  let code;
  if (s.length === 8) {
    if (!hasValidCheckDigit(s) || /^[02]/.test(s)) return null;
    return s;
  }
  if (s.length === 12) code = `0${s}`;
  else if (s.length === 13) code = s;
  else if (s.length === 14) code = s.startsWith('0') ? s.slice(1) : s;
  else return null;

  if (!hasValidCheckDigit(code)) return null;
  if (code.length === 13 && /^(2|02)/.test(code)) return null;
  return code;
}

module.exports = { normalizeBarcode, gs1CheckDigit };
