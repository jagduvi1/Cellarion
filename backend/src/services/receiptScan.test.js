/**
 * Receipt scan: preparing the document, the model call, and cleaning the reply.
 *
 * WHY THIS TEST EXISTS:
 * - A till receipt is long and narrow. Sent as one frame it is shrunk until the
 *   small print is unreadable, so tall photos are cut into overlapping slices;
 *   the cut must cover the whole receipt, and every frame must fit the model's
 *   per-image limits.
 * - Receipts carry personal data. The photo's metadata (GPS included) must not
 *   leave the server, and nothing but wine fields may come back from the reply.
 * - The reply is untrusted input that becomes import rows: vintages, dates,
 *   quantities, prices and currencies are validated, never passed through.
 */
jest.mock('./aiProvider', () => ({ providerName: jest.fn(() => 'anthropic'), getChatClient: jest.fn() }));
jest.mock('../config/aiConfig', () => ({ get: jest.fn(() => ({ labelScanModel: 'claude-sonnet-5', receiptScanPrompt: 'RECEIPT PROMPT' })) }));

const sharp = require('sharp');
const aiProvider = require('./aiProvider');
const {
  prepareReceiptContent, readReceipt, buildReceiptResult, planSlices, fitScale, countPdfPages, limits,
} = require('./receiptScan');

const png = (width, height) => sharp({ create: { width, height, channels: 3, background: '#ffffff' } }).png().toBuffer();
const file = (buffer, mimetype = 'image/png') => ({ buffer, mimetype, originalname: 'r' });

beforeEach(() => {
  jest.clearAllMocks();
  aiProvider.providerName.mockReturnValue('anthropic');
});

describe('planSlices', () => {
  it('leaves an ordinary photo whole', () => {
    expect(planSlices(1000, 1500)).toEqual([{ top: 0, height: 1500 }]);
    expect(planSlices(1000, 2900)).toEqual([{ top: 0, height: 2900 }]); // within 20% of one slice
  });

  it('cuts a long receipt into overlapping slices that cover it top to bottom', () => {
    const slices = planSlices(1000, 6000);
    expect(slices.length).toBe(3);
    expect(slices[0].top).toBe(0);
    const last = slices[slices.length - 1];
    expect(last.top + last.height).toBe(6000);
    for (let i = 1; i < slices.length; i++) {
      const prevEnd = slices[i - 1].top + slices[i - 1].height;
      expect(slices[i].top).toBeLessThan(prevEnd); // overlap: no line falls in a gap
    }
    for (const s of slices) expect(s.height).toBeLessThanOrEqual(2500);
  });

  it('grows the slices rather than exceeding the cap on a very long receipt', () => {
    const slices = planSlices(500, 20000);
    expect(slices.length).toBe(4);
    const last = slices[3];
    expect(last.top + last.height).toBe(20000);
  });
});

describe('fitScale', () => {
  it('fits the long edge and the pixel budget, and never enlarges', () => {
    expect(fitScale(800, 1000)).toBe(1);
    expect(Math.round(5152 * fitScale(1000, 5152))).toBeLessThanOrEqual(limits.MAX_LONG_EDGE);
    const s = fitScale(2500, 2500);
    expect(2500 * s * 2500 * s).toBeLessThanOrEqual(limits.MAX_IMAGE_PIXELS + 1);
  });
});

describe('prepareReceiptContent', () => {
  it('slices a tall photo into JPEG frames within the model limits', async () => {
    const { blocks, stats, archive } = await prepareReceiptContent([file(await png(800, 5000))]);
    expect(blocks.length).toBe(planSlices(800, 5000).length);
    expect(stats).toEqual({ pdf: false, files: 1, images: blocks.length });
    // One archived copy per uploaded photo, upright and whole (not the slices).
    expect(archive).toHaveLength(1);
    expect(archive[0].mediaType).toBe('image/jpeg');
    const whole = await sharp(archive[0].buffer).metadata();
    expect([whole.width, whole.height]).toEqual([800, 5000]);
    for (const b of blocks) {
      expect(b).toMatchObject({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg' } });
      const meta = await sharp(Buffer.from(b.source.data, 'base64')).metadata();
      expect(meta.format).toBe('jpeg');
      expect(Math.max(meta.width, meta.height)).toBeLessThanOrEqual(limits.MAX_LONG_EDGE);
      expect(meta.width * meta.height).toBeLessThanOrEqual(limits.MAX_IMAGE_PIXELS);
    }
  });

  it('drops the photo metadata (GPS included) before anything is sent', async () => {
    const withExif = await sharp({ create: { width: 400, height: 600, channels: 3, background: '#fff' } })
      .jpeg()
      .withMetadata({ exif: { IFD0: { Copyright: 'buyer-name' } } })
      .toBuffer();
    expect((await sharp(withExif).metadata()).exif).toBeDefined();
    const { blocks, archive } = await prepareReceiptContent([file(withExif, 'image/jpeg')]);
    const meta = await sharp(Buffer.from(blocks[0].source.data, 'base64')).metadata();
    expect(meta.exif).toBeUndefined();
    // …and none in the copy the beta archive keeps either.
    expect((await sharp(archive[0].buffer).metadata()).exif).toBeUndefined();
  });

  it('refuses what is not an image or a PDF, and too many photos', async () => {
    await expect(prepareReceiptContent([file(Buffer.from('not an image at all'))])).rejects.toMatchObject({ status: 400, code: 'unreadable_image' });
    await expect(prepareReceiptContent([])).rejects.toMatchObject({ status: 400, code: 'no_file' });
    const one = await png(100, 100);
    const many = Array.from({ length: limits.MAX_IMAGE_FILES + 1 }, () => file(one));
    await expect(prepareReceiptContent(many)).rejects.toMatchObject({ status: 400, code: 'too_many_files' });
  });

  it('sends a PDF as one document block on Anthropic', async () => {
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Page >> endobj\n%%EOF');
    const { blocks, stats, archive } = await prepareReceiptContent([file(pdf, 'application/pdf')]);
    expect(blocks).toEqual([{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf.toString('base64') } }]);
    expect(stats).toEqual({ pdf: true, files: 1, images: 0 });
    expect(archive).toEqual([{ buffer: pdf, mediaType: 'application/pdf' }]);
  });

  it('refuses a PDF on a provider without document input, a PDF mixed with photos, and a long PDF', async () => {
    const pdf = Buffer.from('%PDF-1.4\n%%EOF');
    aiProvider.providerName.mockReturnValue('openai');
    await expect(prepareReceiptContent([file(pdf)])).rejects.toMatchObject({ status: 400, code: 'pdf_unsupported' });
    aiProvider.providerName.mockReturnValue('anthropic');
    await expect(prepareReceiptContent([file(pdf), file(await png(100, 100))])).rejects.toMatchObject({ code: 'mixed_files' });
    const pages = '%PDF-1.4\n' + Array.from({ length: limits.MAX_PDF_PAGES + 1 }, (_, i) => `${i} 0 obj << /Type /Page >> endobj`).join('\n');
    await expect(prepareReceiptContent([file(Buffer.from(pages))])).rejects.toMatchObject({ code: 'too_many_pages' });
  });
});

describe('countPdfPages', () => {
  it('counts page objects, not the page tree', () => {
    expect(countPdfPages(Buffer.from('<< /Type /Pages /Kids [] >> << /Type /Page >> << /Type/Page >>'))).toBe(2);
    expect(countPdfPages(Buffer.from('%PDF-1.7 compressed'))).toBe(0);
  });
});

describe('readReceipt', () => {
  const reply = (text) => ({ content: [{ type: 'text', text }] });

  it('sends the instructions as the system block and parses the JSON reply', async () => {
    const text = '```json\n{"isReceipt":true,"wines":[]}\n```';
    const create = jest.fn().mockResolvedValue(reply(text));
    aiProvider.getChatClient.mockReturnValue({ messages: { create } });
    const blocks = [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } }];

    // The raw reply comes back too, for the beta archive.
    await expect(readReceipt(blocks)).resolves.toEqual({
      parsed: { isReceipt: true, wines: [] },
      raw: text,
      model: 'claude-sonnet-5',
    });
    expect(aiProvider.getChatClient).toHaveBeenCalledWith(expect.objectContaining({ feature: 'receipt_scan' }));
    const req = create.mock.calls[0][0];
    expect(req.model).toBe('claude-sonnet-5');
    expect(req.system).toBe('RECEIPT PROMPT');
    expect(req.thinking).toEqual({ type: 'disabled' });
    expect(req.messages[0].content[0]).toBe(blocks[0]);
    expect(req.messages[0].content[1].type).toBe('text');
  });

  it('puts the instructions in the message on the OpenAI-compatible provider', async () => {
    aiProvider.providerName.mockReturnValue('openai');
    const create = jest.fn().mockResolvedValue(reply('{"isReceipt":false}'));
    aiProvider.getChatClient.mockReturnValue({ messages: { create } });
    await readReceipt([]);
    const req = create.mock.calls[0][0];
    expect(req.system).toBeUndefined();
    expect(req.messages[0].content.at(-1).text).toBe('RECEIPT PROMPT');
  });

  it('throws 422 when the reply holds no JSON', async () => {
    aiProvider.getChatClient.mockReturnValue({ messages: { create: jest.fn().mockResolvedValue(reply('I cannot read this.')) } });
    // The reply rides on the error for the beta archive.
    await expect(readReceipt([])).rejects.toMatchObject({ status: 422, code: 'unreadable', raw: 'I cannot read this.', model: 'claude-sonnet-5' });
  });
});

describe('buildReceiptResult', () => {
  const NOW = new Date('2026-10-04T12:00:00Z');
  const build = (parsed) => buildReceiptResult(parsed, { now: NOW });

  it('turns wine lines into import rows carrying the shop, date and currency', () => {
    const out = build({
      isReceipt: true,
      documentType: 'receipt',
      store: 'Systembolaget Hötorget',
      purchaseDate: '2026-10-03',
      currency: 'sek',
      wines: [
        { line: 'FEVRE CHABLIS 22 75CL', producer: 'William Fèvre', name: 'Chablis', vintage: '2022', sizeMl: 750, quantity: 2, unitPrice: 189, lineTotal: 378, type: 'white' },
        { line: 'CASE BAROLO 6X75', name: 'Barolo', vintage: 2019, sizeMl: '750', quantity: 6, unitPrice: null, lineTotal: '2 394,00' },
      ],
      skipped: [{ line: 'PANT', reason: 'deposit' }, { line: 'BÄRKASSE', reason: 'bag' }, { line: '???', reason: 'weird' }],
    });
    expect(out.receipt).toEqual({ documentType: 'receipt', store: 'Systembolaget Hötorget', purchaseDate: '2026-10-03', currency: 'SEK' });
    expect(out.items).toEqual([
      {
        wineName: 'Chablis', producer: 'William Fèvre', vintage: '2022', bottleSize: '750ml', type: 'white', quantity: 2,
        price: 189, currency: 'SEK', purchaseDate: '2026-10-03', purchaseLocation: 'Systembolaget Hötorget', receiptLine: 'FEVRE CHABLIS 22 75CL',
      },
      {
        wineName: 'Barolo', vintage: '2019', bottleSize: '750ml', quantity: 6,
        price: 399, currency: 'SEK', purchaseDate: '2026-10-03', purchaseLocation: 'Systembolaget Hötorget', receiptLine: 'CASE BAROLO 6X75',
      },
    ]);
    expect(out.skipped).toEqual([
      { line: 'PANT', reason: 'deposit' },
      { line: 'BÄRKASSE', reason: 'packaging' },
      { line: '???', reason: 'other' },
    ]);
    expect(out.warnings).toEqual([]);
  });

  it('drops values it cannot trust instead of guessing', () => {
    const out = build({
      isReceipt: true,
      store: '  ',
      purchaseDate: '2026-11-30', // in the future
      currency: 'kr',
      documentType: 'something',
      wines: [
        { name: 'A', vintage: '19', sizeMl: -1, quantity: 1, unitPrice: -5, type: 'orange' },
        { name: 'B', vintage: '2031', quantity: 'two', unitPrice: 'abc' },
      ],
    });
    expect(out.receipt).toEqual({ documentType: null, store: null, purchaseDate: null, currency: null });
    expect(out.items).toEqual([{ wineName: 'A', quantity: 1 }, { wineName: 'B', quantity: 1 }]);
    expect(out.warnings).toContain('currency_unsupported');
  });

  it('spreads a multi-buy discount over the priced wines in proportion, exactly', () => {
    // 136.97 of wine with 13.70 off = 10% off every bottle.
    const out = build({
      isReceipt: true,
      wineDiscount: 13.7,
      wines: [
        { name: 'Bourgogne Pinot Noir', quantity: 2, unitPrice: 16.99 },
        { name: 'Sauvignon Blanc', quantity: 3, unitPrice: 26 },
        { name: 'Tawny', quantity: 1, unitPrice: 24.99 },
        { name: 'Unpriced', quantity: 1 },
      ],
    });
    expect(out.items.map((i) => i.price)).toEqual([15.29, 23.4, 22.49, undefined]);
    expect(out.warnings).toContain('wine_discount_spread');
  });

  it('takes a line discount off its own line, and ignores a discount bigger than the wines', () => {
    const out = build({ isReceipt: true, wines: [{ name: 'A', quantity: 2, unitPrice: 100, lineDiscount: 30 }] });
    expect(out.items[0].price).toBe(85);
    const misread = build({ isReceipt: true, wineDiscount: 500, wines: [{ name: 'A', quantity: 1, unitPrice: 100 }] });
    expect(misread.items[0].price).toBe(100);
    expect(misread.warnings).not.toContain('wine_discount_spread');
  });

  it('rejects an impossible calendar date', () => {
    expect(build({ isReceipt: true, purchaseDate: '2026-02-30', wines: [] }).receipt.purchaseDate).toBeNull();
  });

  it('keeps a line the model could not split, skips returns, caps quantities, flags mixed cases', () => {
    const out = build({
      isReceipt: true,
      wines: [
        { line: 'CH BEL-AIR 19', quantity: 1 },
        { name: 'Returned', quantity: -1 },
        { name: 'Huge', quantity: 9999 },
        { line: 'MIXED CASE 12', name: 'Mixed case', quantity: 12, mixedCase: true },
        'garbage',
      ],
    });
    expect(out.items.map((i) => i.wineName)).toEqual(['CH BEL-AIR 19', 'Huge', 'Mixed case']);
    expect(out.items[1].quantity).toBe(limits.MAX_QUANTITY);
    expect(out.items[2].mixedCase).toBe(true);
    expect(out.warnings).toEqual(expect.arrayContaining(['quantity_capped', 'mixed_case']));
  });

  it('names a producer-only line after the estate, as the registry does', () => {
    const out = build({ isReceipt: true, wines: [{ line: 'CH BEL-AIR 2019 75CL', producer: 'Château Bel-Air', name: null, quantity: 2 }] });
    expect(out.items[0]).toMatchObject({ producer: 'Château Bel-Air', wineName: 'Château Bel-Air', quantity: 2 });
  });

  it('strips control characters and caps lengths', () => {
    const out = build({ isReceipt: true, wines: [{ producer: 'Dom\u0000aine\nX', name: 'N'.repeat(500), quantity: 1 }] });
    expect(out.items[0].producer).toBe('Dom aine X');
    expect(out.items[0].wineName).toHaveLength(200);
  });

  it('says so when the document is not a purchase', () => {
    expect(() => build({ isReceipt: false, wines: [] })).toThrow(expect.objectContaining({ status: 422, code: 'not_a_receipt' }));
    expect(() => build(null)).toThrow(expect.objectContaining({ code: 'not_a_receipt' }));
  });
});
