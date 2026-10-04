/**
 * Receipt scan: read the wine lines off a purchase document — a photographed
 * till receipt, a screenshot of an online order, or a PDF invoice — and turn
 * them into rows for the bottle importer (routes/import.js validate/confirm).
 *
 * The document only ever exists in memory. It is prepared here (orientation
 * baked in, metadata dropped, tall photos sliced), sent to the AI provider, and
 * discarded with the request: receipts carry a name, an address, a member
 * number or the last card digits, none of which Cellarion needs. What survives
 * is what a bottle already stores — price, currency, purchase date and the
 * shop — and only once the user confirms the import.
 *
 * Identification is NOT done here. A receipt line is often truncated or
 * abbreviated ("CH BEL-AIR 19 75CL"); the import's own validate step resolves
 * each row against the registry (and the AI lookup) exactly as it does for a
 * CSV row, and the user reviews every match before anything is created.
 */

const sharp = require('sharp');
const aiConfig = require('../config/aiConfig');
const aiProvider = require('./aiProvider');
const { MAX_PIXELS } = require('./imageSanitizer');
const { extractFirstJsonObject } = require('../utils/jsonExtract');
const { textFromResponse, thinkingOff } = require('../utils/aiResponse');
const { normalizeBottleSize } = require('../config/bottleSizes');
const { SUPPORTED_CURRENCIES } = require('../config/currencies');
const { WINE_TYPES } = require('./wineProfileOps');

// ── Limits ───────────────────────────────────────────────────────────────────

const MAX_IMAGE_FILES = 5;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_PDF_BYTES = 10 * 1024 * 1024;
const MAX_PDF_PAGES = 10;

// The vision models we run read up to 2576 px on the long edge and 3.75 MP per
// image; anything larger is downscaled by the API anyway, so do it here and
// send fewer bytes. A till receipt is long and narrow: squeezed into one
// 2576-px frame, a 1:6 slip ends up ~430 px wide and its small print becomes
// unreadable. Such a photo is cut into overlapping slices instead, each no
// taller than SLICE_ASPECT × its width, so the text keeps its size.
const MAX_LONG_EDGE = 2576;
const MAX_IMAGE_PIXELS = 3_750_000;
const SLICE_ASPECT = 2.5;
const SLICE_OVERLAP = 0.08; // a printed line on a cut is whole in one of the two slices
const MAX_SLICES_PER_IMAGE = 4;
const MAX_IMAGES_PER_SCAN = 10;

const IMAGE_FORMATS = new Set(['jpeg', 'png', 'webp', 'heif']);

// The output is a JSON list; ~60–90 tokens per wine line. 6000 covers a
// receipt with ~60 wine lines plus the skipped lines.
const MAX_OUTPUT_TOKENS = 6000;

const MAX_WINES = 200;
const MAX_SKIPPED = 50;
const MAX_QUANTITY = 240; // 20 cases of 12; more is a misread, not a purchase
const MAX_UNIT_PRICE = 1_000_000;

const SKIP_REASONS = new Set([
  'beer', 'cider', 'spirits', 'non-alcoholic', 'food', 'deposit', 'packaging',
  'shipping', 'discount', 'fee', 'gift card', 'return', 'other',
]);
const SKIP_REASON_ALIASES = { bag: 'packaging', 'gift wrap': 'packaging', pant: 'deposit' };

// A prepayment receipt (Systembolaget's förskottskvitto) and a pro-forma
// invoice (en primeur) are followed by a second document for the SAME bottles;
// the import page warns, so one purchase is not imported twice.
const DOCUMENT_TYPES = new Set(['receipt', 'order', 'invoice', 'prepayment', 'proforma', 'other']);

const SCAN_REQUEST = 'Read the wine purchase in these images, following your instructions exactly.';

function httpError(status, message, code) {
  const err = new Error(message);
  err.status = status;
  if (code) err.code = code;
  return err;
}

// ── Preparing the document ───────────────────────────────────────────────────

/**
 * Where to cut a W×H image into slices no taller than `aspect` × W. Returns
 * [{ top, height }], ordered top to bottom, consecutive slices overlapping by
 * `overlap` of a slice. An image that is only a little taller than one slice
 * (up to 20% over) is left whole. When more than `maxSlices` would be needed,
 * the slices grow instead, so the whole receipt is always covered.
 */
function planSlices(width, height, { aspect = SLICE_ASPECT, overlap = SLICE_OVERLAP, maxSlices = MAX_SLICES_PER_IMAGE } = {}) {
  if (!(width > 0) || !(height > 0)) return [];
  let sliceHeight = Math.round(width * aspect);
  if (height <= sliceHeight * 1.2) return [{ top: 0, height }];
  let count = Math.ceil((height - sliceHeight) / (sliceHeight * (1 - overlap))) + 1;
  if (count > maxSlices) {
    count = maxSlices;
    sliceHeight = Math.ceil(height / (count - (count - 1) * overlap));
  }
  const step = (height - sliceHeight) / (count - 1);
  return Array.from({ length: count }, (_, i) => {
    const top = Math.round(i * step);
    return { top, height: Math.min(sliceHeight, height - top) };
  });
}

/** Scale factor that fits W×H inside the model's per-image limits (never > 1). */
function fitScale(width, height) {
  return Math.min(1, MAX_LONG_EDGE / Math.max(width, height), Math.sqrt(MAX_IMAGE_PIXELS / (width * height)));
}

/**
 * One uploaded photo → one or more JPEG frames for the model. Fails closed on
 * anything that does not decode as an image within MAX_PIXELS (a decompression
 * bomb never reaches the slicer). EXIF — including GPS — is dropped by the
 * re-encode; .rotate() bakes the orientation in first.
 */
async function prepareImage(buffer) {
  let meta;
  try {
    meta = await sharp(buffer, { limitInputPixels: MAX_PIXELS }).metadata();
  } catch {
    throw httpError(400, 'The photo could not be read. Upload a JPEG, PNG, WebP or HEIC image.', 'unreadable_image');
  }
  if (!IMAGE_FORMATS.has(meta.format)) {
    throw httpError(400, 'Upload a JPEG, PNG, WebP or HEIC image, or a PDF.', 'unsupported_type');
  }

  const { data, info } = await sharp(buffer, { limitInputPixels: MAX_PIXELS })
    .rotate()
    .jpeg({ quality: 95 })
    .toBuffer({ resolveWithObject: true });

  const frames = [];
  for (const slice of planSlices(info.width, info.height)) {
    const scale = fitScale(info.width, slice.height);
    const frame = await sharp(data, { limitInputPixels: MAX_PIXELS })
      .extract({ left: 0, top: slice.top, width: info.width, height: slice.height })
      .resize({
        width: Math.max(1, Math.floor(info.width * scale)),
        height: Math.max(1, Math.floor(slice.height * scale)),
        fit: 'fill',
      })
      .jpeg({ quality: 85 })
      .toBuffer();
    frames.push(frame.toString('base64'));
  }
  return frames;
}

const isPdf = (buffer) => Buffer.isBuffer(buffer) && buffer.length > 5 && buffer.toString('latin1', 0, 5) === '%PDF-';

/**
 * Rough page count from the page objects a PDF declares. PDFs that keep their
 * objects in compressed streams show none, so 0 means "unknown" — the byte
 * cap still bounds those.
 */
function countPdfPages(buffer) {
  const matches = buffer.toString('latin1').match(/\/Type\s*\/Page(?![a-zA-Z])/g);
  return matches ? matches.length : 0;
}

/**
 * Turn the uploaded files into the content blocks of one request.
 * files: [{ buffer, mimetype, originalname }] (multer memory storage).
 * Either one PDF, or up to MAX_IMAGE_FILES photos/screenshots — the photos of
 * one long receipt, in order.
 */
async function prepareReceiptContent(files) {
  if (!Array.isArray(files) || files.length === 0) {
    throw httpError(400, 'Choose a photo or a PDF of the receipt.', 'no_file');
  }

  const pdfs = files.filter((f) => isPdf(f.buffer));
  if (pdfs.length > 0) {
    if (files.length > 1) {
      throw httpError(400, 'Upload one PDF on its own, or photos without a PDF.', 'mixed_files');
    }
    const pdf = pdfs[0].buffer;
    if (pdf.length > MAX_PDF_BYTES) throw httpError(400, 'The PDF is too large (max 10 MB).', 'too_large');
    if (countPdfPages(pdf) > MAX_PDF_PAGES) {
      throw httpError(400, `The PDF has more than ${MAX_PDF_PAGES} pages. Upload only the pages with the wines.`, 'too_many_pages');
    }
    // The OpenAI-compatible adapter (self-hosted local models) has no document
    // input; photos and screenshots still work there.
    if (aiProvider.providerName() !== 'anthropic') {
      throw httpError(400, 'Reading PDFs is not available on this server. Upload a photo or screenshot instead.', 'pdf_unsupported');
    }
    return {
      blocks: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf.toString('base64') } }],
      stats: { pdf: true, files: 1, images: 0 },
    };
  }

  if (files.length > MAX_IMAGE_FILES) {
    throw httpError(400, `Upload at most ${MAX_IMAGE_FILES} photos at a time.`, 'too_many_files');
  }
  const blocks = [];
  for (const file of files) {
    if (file.buffer.length > MAX_IMAGE_BYTES) throw httpError(400, 'A photo is too large (max 12 MB).', 'too_large');
    for (const data of await prepareImage(file.buffer)) {
      blocks.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } });
    }
  }
  if (blocks.length > MAX_IMAGES_PER_SCAN) {
    throw httpError(400, 'The receipt is too long to read in one go. Photograph the part with the wines, or split it into two scans.', 'too_many_pages');
  }
  return { blocks, stats: { pdf: false, files: files.length, images: blocks.length } };
}

// ── The model call ───────────────────────────────────────────────────────────

/**
 * Send the prepared blocks to the vision model and return the parsed JSON
 * object. Throws 422 when the reply holds no JSON (a completed, billed call),
 * and lets the provider's own errors through (503 when no provider is
 * configured, transport errors) — the route refunds those.
 */
async function readReceipt(blocks) {
  const client = aiProvider.getChatClient({ maxRetries: 4, feature: 'receipt_scan' });
  const { labelScanModel: model, receiptScanPrompt: prompt } = aiConfig.get();
  // Instructions as the system block on Anthropic; one message on the
  // OpenAI-compatible adapter (mirrors services/labelScan). Not cache-marked:
  // receipts arrive far apart, and a cache write costs more than it saves.
  const asSystem = aiProvider.providerName() === 'anthropic';

  const response = await client.messages.create({
    model,
    max_tokens: MAX_OUTPUT_TOKENS,
    ...thinkingOff(model),
    ...(asSystem ? { system: prompt } : {}),
    messages: [{
      role: 'user',
      content: [...blocks, { type: 'text', text: asSystem ? SCAN_REQUEST : prompt }],
    }],
  });

  const raw = textFromResponse(response);
  const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try {
    return JSON.parse(extractFirstJsonObject(stripped));
  } catch {
    console.error('[receiptScan] no JSON in the model reply (%d chars)', raw.length);
    throw httpError(422, 'The receipt could not be read. Try a sharper photo with the whole receipt in view.', 'unreadable');
  }
}

// ── Cleaning the reply ───────────────────────────────────────────────────────

const clean = (v, max) => (typeof v === 'string'
  ? v.replace(/\p{C}/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
  : '');

const toNumber = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v.replace(/\s/g, '').replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

const round2 = (n) => Math.round(n * 100) / 100;

function cleanVintage(v, currentYear) {
  const s = clean(String(v ?? ''), 8).toUpperCase();
  if (s === 'NV') return 'NV';
  if (/^\d{4}$/.test(s)) {
    const y = Number(s);
    if (y >= 1850 && y <= currentYear + 1) return s;
  }
  return undefined;
}

function cleanDate(v, now) {
  const s = clean(v, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) return null; // 2026-02-30
  if (d.getUTCFullYear() < 1950) return null;
  if (d.getTime() > now.getTime() + 86400000) return null; // a misread, not a purchase from the future
  return s;
}

/**
 * Reduce the model's reply to what the importer may receive. Everything is
 * re-checked here — the model is asked for this shape, but the reply is still
 * untrusted input: strings are length-capped and stripped of control
 * characters, numbers and dates are validated, and unknown values are dropped
 * rather than guessed.
 *
 * Returns { receipt: { documentType, store, purchaseDate, currency }, items, skipped, warnings }
 * where each item is a row in the importer's master format (utils/importMappers
 * on the frontend) carrying `quantity` — the client expands it into one row per
 * bottle — plus `receiptLine`, the line as printed, for the review screen.
 */
function buildReceiptResult(parsed, { now = new Date() } = {}) {
  if (!parsed || typeof parsed !== 'object' || parsed.isReceipt === false) {
    throw httpError(422, 'This does not look like a receipt or an order. Upload a photo or PDF of the purchase.', 'not_a_receipt');
  }

  const currentYear = now.getUTCFullYear();
  const warnings = new Set();

  const docRaw = clean(parsed.documentType, 20).toLowerCase();
  const documentType = DOCUMENT_TYPES.has(docRaw) ? docRaw : null;
  const store = clean(parsed.store, 100) || null;
  const purchaseDate = cleanDate(parsed.purchaseDate, now);
  const currencyRaw = clean(parsed.currency, 3).toUpperCase();
  const currency = SUPPORTED_CURRENCIES.includes(currencyRaw) ? currencyRaw : null;
  if (currencyRaw && !currency) warnings.add('currency_unsupported');

  const wines = Array.isArray(parsed.wines) ? parsed.wines : [];
  if (wines.length > MAX_WINES) warnings.add('too_many_lines');

  const items = [];
  for (const w of wines.slice(0, MAX_WINES)) {
    if (!w || typeof w !== 'object') continue;
    const receiptLine = clean(w.line, 160);
    let producer = clean(w.producer, 200);
    let wineName = clean(w.name, 200);
    // A line the model could not split still goes to review: the importer's
    // identification step can often resolve the printed text on its own.
    if (!producer && !wineName) {
      if (!receiptLine) continue;
      wineName = receiptLine;
    }
    // An estate wine is often printed by its estate alone ("CH BEL-AIR 2019").
    // The registry names such wines after the estate (name = producer), and
    // the importer's matcher weighs name and producer equally — with an empty
    // name a row could never reach the match threshold.
    if (producer && !wineName) wineName = producer;

    let quantity = Math.round(toNumber(w.quantity) ?? 1);
    if (quantity < 1) continue; // a return or a voided line was not bought
    if (quantity > MAX_QUANTITY) {
      quantity = MAX_QUANTITY;
      warnings.add('quantity_capped');
    }

    // The printed price per bottle, before discounts…
    let price = toNumber(w.unitPrice);
    const lineTotal = toNumber(w.lineTotal);
    if (price == null && lineTotal != null && lineTotal > 0) price = lineTotal / quantity;
    if (price != null && (price < 0 || price > MAX_UNIT_PRICE)) price = null;
    // …less a discount printed for this line. The model only REPORTS discount
    // amounts; the arithmetic is done here, where it is exact (a live test on
    // 2026-10-04 had the model's own spread of a Mix Six saving off by 1.6%).
    const lineDiscount = toNumber(w.lineDiscount);
    if (price != null && lineDiscount != null && lineDiscount > 0 && lineDiscount < price * quantity) {
      price = (price * quantity - lineDiscount) / quantity;
    }

    const item = { wineName, quantity };
    if (producer) item.producer = producer;
    const vintage = cleanVintage(w.vintage, currentYear);
    if (vintage) item.vintage = vintage;
    const size = normalizeBottleSize(toNumber(w.sizeMl));
    if (size) item.bottleSize = size;
    const type = clean(w.type, 12).toLowerCase();
    if (WINE_TYPES.includes(type)) item.type = type;
    if (price != null) item.price = price; // rounded below, after the multi-buy spread
    if (currency) item.currency = currency;
    if (purchaseDate) item.purchaseDate = purchaseDate;
    if (store) item.purchaseLocation = store;
    if (receiptLine) item.receiptLine = receiptLine;
    // A mixed case whose wines the document does not list: one row the user
    // has to sort out after the import (its contents are never guessed).
    if (w.mixedCase === true) {
      item.mixedCase = true;
      warnings.add('mixed_case');
    }
    items.push(item);
  }

  // A multi-buy discount on wine ("Mix Six", "25% off 6 bottles") is one line
  // for several wines. Spread it over the priced wine lines in proportion to
  // what each cost, so a bottle's price is what was actually paid for it.
  // A discount larger than the wines themselves is a misread and is ignored.
  const wineDiscount = toNumber(parsed.wineDiscount);
  const pricedTotal = items.reduce((sum, i) => sum + (i.price != null ? i.price * i.quantity : 0), 0);
  if (wineDiscount != null && wineDiscount > 0 && pricedTotal > 0 && wineDiscount < pricedTotal) {
    const factor = 1 - wineDiscount / pricedTotal;
    for (const i of items) if (i.price != null) i.price *= factor;
    warnings.add('wine_discount_spread');
  }
  for (const i of items) if (i.price != null) i.price = round2(i.price);

  const skippedIn = Array.isArray(parsed.skipped) ? parsed.skipped : [];
  const skipped = [];
  for (const s of skippedIn.slice(0, MAX_SKIPPED)) {
    if (!s || typeof s !== 'object') continue;
    const line = clean(s.line, 120);
    if (!line) continue;
    const said = clean(s.reason, 20).toLowerCase();
    const reason = SKIP_REASON_ALIASES[said] || said;
    skipped.push({ line, reason: SKIP_REASONS.has(reason) ? reason : 'other' });
  }

  return { receipt: { documentType, store, purchaseDate, currency }, items, skipped, warnings: [...warnings] };
}

module.exports = {
  prepareReceiptContent,
  readReceipt,
  buildReceiptResult,
  // exported for tests
  planSlices,
  fitScale,
  countPdfPages,
  limits: {
    MAX_IMAGE_FILES, MAX_IMAGE_BYTES, MAX_PDF_BYTES, MAX_PDF_PAGES,
    MAX_LONG_EDGE, MAX_IMAGE_PIXELS, MAX_IMAGES_PER_SCAN, MAX_QUANTITY,
  },
};
