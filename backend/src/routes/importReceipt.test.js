/**
 * POST /api/bottles/import/receipt — the receipt scan route.
 *
 * WHY THIS TEST EXISTS:
 * A scan is a paid vision call on the shared AI budget, so the route must
 * charge exactly when a call completed: an unreadable upload costs nothing, a
 * provider outage is refunded, a completed-but-useless reply is not. It must
 * also refuse a second concurrent scan before buffering the upload, and log
 * counts only — the receipt's contents are personal data.
 */
process.env.JWT_SECRET = 'test-secret';

jest.mock('../services/receiptScan', () => ({
  prepareReceiptContent: jest.fn(),
  readReceipt: jest.fn(),
  buildReceiptResult: jest.fn(),
  limits: { MAX_IMAGE_FILES: 5, MAX_IMAGE_BYTES: 12 * 1024 * 1024, MAX_PDF_BYTES: 10 * 1024 * 1024 },
}));
jest.mock('../services/aiBudget', () => ({
  tryDebitAi: jest.fn(),
  isRefundableScanError: (err) => err?.status !== 422,
}));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../services/receiptArchive', () => ({ archiveReceiptScan: jest.fn(async () => ({ _id: 'kept' })) }));
jest.mock('../config/rateLimits', () => ({ get: () => ({ aiBurst: { max: 1000 } }) }));
// requireAuth confirms a demo session is still live; say it is.
jest.mock('../models/User', () => ({ exists: jest.fn(() => Promise.resolve(true)) }));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const receiptScan = require('../services/receiptScan');
const { tryDebitAi } = require('../services/aiBudget');
const { logAudit } = require('../services/audit');
const { archiveReceiptScan } = require('../services/receiptArchive');
const router = require('./importReceipt');

const USER = '64b000000000000000000001';
const token = (claims = {}) => jwt.sign({ id: USER, roles: ['user'], ...claims }, 'test-secret', { algorithm: 'HS256' });

let server;
let baseUrl;
beforeAll((done) => {
  const app = express();
  app.use('/api/bottles/import/receipt', router);
  server = http.createServer(app);
  server.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.closeAllConnections(); server.close(done); });

const refund = jest.fn();
beforeEach(() => {
  jest.clearAllMocks();
  router._inFlightForTests.clear();
  receiptScan.prepareReceiptContent.mockResolvedValue({ blocks: [{ type: 'image' }], stats: { pdf: false, files: 1, images: 2 }, archive: [{ buffer: Buffer.from('jpg'), mediaType: 'image/jpeg' }] });
  receiptScan.readReceipt.mockResolvedValue({ parsed: { isReceipt: true, wines: [] }, raw: '{"isReceipt":true}', model: 'claude-sonnet-5' });
  receiptScan.buildReceiptResult.mockReturnValue({
    receipt: { documentType: 'receipt', store: 'Shop', purchaseDate: '2026-10-03', currency: 'SEK' },
    items: [{ wineName: 'A', quantity: 2 }, { wineName: 'B', quantity: 1 }],
    skipped: [{ line: 'PANT', reason: 'deposit' }],
    warnings: [],
  });
  tryDebitAi.mockResolvedValue({ ok: true, refund });
});

const post = (files = 1, headers = { Authorization: `Bearer ${token()}` }) => {
  const fd = new FormData();
  for (let i = 0; i < files; i++) fd.append('files', new Blob([Buffer.from('fake-image')], { type: 'image/jpeg' }), `r${i}.jpg`);
  return fetch(`${baseUrl}/api/bottles/import/receipt`, { method: 'POST', headers, body: fd });
};

test('reads a receipt, charges one AI unit, and logs counts only', async () => {
  const res = await post(2);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.items).toHaveLength(2);
  expect(receiptScan.prepareReceiptContent.mock.calls[0][0]).toHaveLength(2);
  expect(tryDebitAi).toHaveBeenCalledTimes(1);
  expect(refund).not.toHaveBeenCalled();
  expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'import.receipt_scan', { type: 'user', id: USER }, {
    pdf: false, files: 1, images: 2, wineLines: 2, bottles: 3, skippedLines: 1,
  });
  expect(JSON.stringify(logAudit.mock.calls[0][3])).not.toContain('Shop');
  // Beta: the receipt, the model's reply and what was read are kept.
  expect(receiptScan.buildReceiptResult).toHaveBeenCalledWith({ isReceipt: true, wines: [] });
  expect(archiveReceiptScan).toHaveBeenCalledWith(expect.objectContaining({
    userId: USER, outcome: 'read', rawReply: '{"isReceipt":true}', model: 'claude-sonnet-5',
    files: [{ buffer: Buffer.from('jpg'), mediaType: 'image/jpeg' }],
    result: expect.objectContaining({ items: expect.any(Array) }),
  }));
});

test('a read is still answered when keeping the receipt fails', async () => {
  archiveReceiptScan.mockResolvedValueOnce(null); // archiveReceiptScan never throws; null = not kept
  const res = await post();
  expect(res.status).toBe(200);
});

test('requires a signed-in, non-demo account', async () => {
  expect((await post(1, {})).status).toBe(401);
  expect((await post(1, { Authorization: `Bearer ${token({ isDemo: true })}` })).status).toBe(403);
  expect(tryDebitAi).not.toHaveBeenCalled();
});

test('an unreadable upload costs nothing', async () => {
  receiptScan.prepareReceiptContent.mockRejectedValue(Object.assign(new Error('The photo could not be read.'), { status: 400, code: 'unreadable_image' }));
  const res = await post();
  expect(res.status).toBe(400);
  expect((await res.json()).code).toBe('unreadable_image');
  expect(tryDebitAi).not.toHaveBeenCalled();
});

test('refuses more files than allowed before reading them', async () => {
  const res = await post(6);
  expect(res.status).toBe(400);
  expect((await res.json()).code).toBe('bad_upload');
  expect(receiptScan.prepareReceiptContent).not.toHaveBeenCalled();
});

test('answers the budget refusal without calling the model', async () => {
  tryDebitAi.mockResolvedValue({ ok: false, reason: 'user_budget', retryAfterSeconds: 3600 });
  const res = await post();
  expect(res.status).toBe(429);
  expect((await res.json()).code).toBe('ai_budget_exhausted');
  expect(receiptScan.readReceipt).not.toHaveBeenCalled();
});

test('refunds when the provider is not configured, keeps the charge for a completed unreadable reply', async () => {
  receiptScan.readReceipt.mockRejectedValueOnce(Object.assign(new Error('no key'), { status: 503 }));
  let res = await post();
  expect(res.status).toBe(503);
  expect((await res.json()).code).toBe('ai_unavailable');
  expect(refund).toHaveBeenCalledTimes(1);
  expect(archiveReceiptScan).not.toHaveBeenCalled(); // no read happened: nothing to keep

  refund.mockClear();
  receiptScan.readReceipt.mockRejectedValueOnce(Object.assign(new Error('The receipt could not be read.'), { status: 422, code: 'unreadable', raw: 'garbled', model: 'm' }));
  res = await post();
  expect(res.status).toBe(422);
  expect((await res.json()).code).toBe('unreadable');
  expect(refund).not.toHaveBeenCalled();
  // An unreadable answer is exactly what the beta archive is for.
  expect(archiveReceiptScan).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'unreadable', rawReply: 'garbled', result: null }));
});

test('a document that is not a purchase is a 422', async () => {
  receiptScan.buildReceiptResult.mockImplementation(() => { throw Object.assign(new Error('not a receipt'), { status: 422, code: 'not_a_receipt' }); });
  const res = await post();
  expect(res.status).toBe(422);
  expect((await res.json()).code).toBe('not_a_receipt');
  expect(archiveReceiptScan).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'not_a_receipt' }));
});

test('refuses a second scan while the first is still being read', async () => {
  let finish;
  receiptScan.readReceipt.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const first = post();
  await new Promise((r) => setTimeout(r, 100)); // the first request is now inside the model call
  const second = await post();
  expect(second.status).toBe(429);
  expect((await second.json()).code).toBe('scan_busy');
  finish({ parsed: { isReceipt: true, wines: [] }, raw: '{}', model: 'm' });
  expect((await first).status).toBe(200);
  expect(router._inFlightForTests.size).toBe(0);
});
