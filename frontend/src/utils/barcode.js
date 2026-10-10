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

/**
 * The one barcode these bottles carry, or null when none has one or they
 * carry different ones. A bottle without a code does not count against it:
 * saving goes to all of them, so it gets the same one.
 */
export function sharedBarcode(bottles) {
  const codes = new Set((bottles || []).map((b) => b?.barcode).filter(Boolean));
  return codes.size === 1 ? [...codes][0] : null;
}

/**
 * The bottles of a vintage that the vintage page's "Add barcode" writes to.
 * A barcode names one product, and a magnum is not the same product as a
 * 75 cl bottle, so only the vintage's main size (the most common one; 75 cl
 * on a tie). Of those: all of them when they carry at most one code between
 * them (that code is the one being added or changed), else only the ones
 * without a code — a bottle with its own, different code keeps it.
 */
export function vintageBarcodeTargets(bottles) {
  const list = bottles || [];
  const sizeOf = (b) => b.bottleSize || '750ml';
  const counts = new Map();
  for (const b of list) counts.set(sizeOf(b), (counts.get(sizeOf(b)) || 0) + 1);
  let main = null;
  for (const [size, n] of counts) {
    const best = main === null ? 0 : counts.get(main);
    if (n > best || (n === best && size === '750ml')) main = size;
  }
  const sized = list.filter((b) => sizeOf(b) === main);
  const codes = new Set(sized.map((b) => b.barcode).filter(Boolean));
  return codes.size <= 1 ? sized : sized.filter((b) => !b.barcode);
}
