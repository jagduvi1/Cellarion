/**
 * Retail barcodes (GTINs) on wine bottles — the same canonical form the
 * backend stores (backend/src/utils/barcode.js; keep the two in step):
 * digits only, a correct GS1 check digit, UPC-A and padded GTIN-14 as their
 * EAN-13 form, and shop-internal restricted numbers (prefix 2x / 02x, and 0/2
 * on EAN-8) refused because they mean different things in different shops.
 */

export function gs1CheckDigit(body) {
  let sum = 0;
  for (let i = body.length - 1, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) {
    sum += Number(body[i]) * w;
  }
  return (10 - (sum % 10)) % 10;
}

const validCheck = (code) => gs1CheckDigit(code.slice(0, -1)) === Number(code[code.length - 1]);

/** Canonical barcode, or null when the input is not a valid public GTIN. */
export function normalizeBarcode(raw) {
  if (raw == null) return null;
  const s = String(raw).replace(/[\s-]/g, '');
  if (!/^\d+$/.test(s) || /^0+$/.test(s)) return null;
  if (s.length === 8) return validCheck(s) && !/^[02]/.test(s) ? s : null;
  let code;
  if (s.length === 12) code = `0${s}`;
  else if (s.length === 13) code = s;
  else if (s.length === 14) code = s.startsWith('0') ? s.slice(1) : s;
  else return null;
  if (!validCheck(code)) return null;
  if (code.length === 13 && /^(2|02)/.test(code)) return null;
  return code;
}
