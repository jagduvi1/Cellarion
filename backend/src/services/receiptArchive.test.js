/**
 * Receipt-scan beta archive: keep a receipt for 5 days, then delete it.
 *
 * WHY THIS TEST EXISTS:
 * Users are promised that a kept receipt is deleted after 5 days and with
 * their account. A record deleted without its file (or a file left behind by a
 * failed save) would break that promise silently, on disk, where nobody looks.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'receipts-'));
process.env.RECEIPTS_DIR = TMP;

const rows = [];
jest.mock('../models/ReceiptScan', () => {
  const matches = (row, filter) => Object.entries(filter).every(([k, v]) => {
    if (v && typeof v === 'object' && '$lte' in v) return row[k] <= v.$lte;
    if (v && typeof v === 'object' && '$in' in v) return v.$in.includes(row[k]);
    return String(row[k]) === String(v);
  });
  return {
    create: jest.fn(async (doc) => { if (doc.user === 'explode') throw new Error('db down'); const row = { _id: `r${rows.length}`, ...doc }; rows.push(row); return row; }),
    find: jest.fn((filter) => ({ select: () => ({ lean: async () => rows.filter((r) => matches(r, filter)) }) })),
    deleteMany: jest.fn(async (filter) => {
      for (let i = rows.length - 1; i >= 0; i--) if (matches(rows[i], filter)) rows.splice(i, 1);
    }),
  };
});

const { archiveReceiptScan, runReceiptRetentionSweep, purgeUserReceiptScans, RECEIPT_RETENTION_DAYS } = require('./receiptArchive');

const DAY = 86400000;
const files = () => fs.readdirSync(TMP);

beforeEach(() => {
  rows.length = 0;
  for (const f of files()) fs.unlinkSync(path.join(TMP, f));
});
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

test('keeps the files privately and records them with a 5-day retention', async () => {
  const now = new Date('2026-10-04T12:00:00Z');
  const rec = await archiveReceiptScan({
    userId: 'u1', now, outcome: 'read', model: 'm', rawReply: 'x'.repeat(60000), result: { items: [] },
    files: [{ buffer: Buffer.from('jpeg-bytes'), mediaType: 'image/jpeg' }, { buffer: Buffer.from('%PDF-'), mediaType: 'application/pdf' }],
  });
  expect(RECEIPT_RETENTION_DAYS).toBe(5);
  expect(rec.retainUntil).toEqual(new Date(now.getTime() + 5 * DAY));
  expect(rec.rawReply).toHaveLength(50000);
  expect(rec.files.map((f) => f.mediaType)).toEqual(['image/jpeg', 'application/pdf']);
  expect(files().sort()).toEqual(rec.files.map((f) => f.name).sort());
  expect(rec.files[0].name).toMatch(/^[0-9a-f-]{36}\.jpg$/);
  if (process.platform !== 'win32') {
    expect(fs.statSync(path.join(TMP, rec.files[0].name)).mode & 0o777).toBe(0o600);
  }
});

test('a record that cannot be saved leaves no file behind, and never throws', async () => {
  await expect(archiveReceiptScan({ userId: 'explode', outcome: 'read', files: [{ buffer: Buffer.from('a'), mediaType: 'image/jpeg' }] })).resolves.toBeNull();
  expect(files()).toEqual([]);
});

test('the sweep deletes expired receipts with their files, and orphaned old files', async () => {
  const now = new Date('2026-10-10T12:00:00Z');
  const old = await archiveReceiptScan({ userId: 'u1', now: new Date(now.getTime() - 6 * DAY), outcome: 'read', files: [{ buffer: Buffer.from('old'), mediaType: 'image/jpeg' }] });
  const fresh = await archiveReceiptScan({ userId: 'u1', now: new Date(now.getTime() - 1 * DAY), outcome: 'read', files: [{ buffer: Buffer.from('new'), mediaType: 'image/jpeg' }] });
  // An orphan (no record) older than the retention, and a young one.
  const orphanOld = path.join(TMP, 'orphan-old.jpg');
  const orphanNew = path.join(TMP, 'orphan-new.jpg');
  fs.writeFileSync(orphanOld, 'x');
  fs.writeFileSync(orphanNew, 'y');
  const sixDaysAgo = (now.getTime() - 6 * DAY) / 1000;
  fs.utimesSync(orphanOld, sixDaysAgo, sixDaysAgo);
  fs.utimesSync(path.join(TMP, old.files[0].name), sixDaysAgo, sixDaysAgo);
  const today = now.getTime() / 1000;
  fs.utimesSync(orphanNew, today, today);
  fs.utimesSync(path.join(TMP, fresh.files[0].name), today, today);

  const out = await runReceiptRetentionSweep({ now });

  expect(out).toEqual({ deleted: 1, orphans: 1 });
  expect(rows.map((r) => r._id)).toEqual([fresh._id]);
  expect(files().sort()).toEqual([fresh.files[0].name, 'orphan-new.jpg'].sort());
});

test('account deletion removes every receipt of the user, files first', async () => {
  const mine = await archiveReceiptScan({ userId: 'u1', outcome: 'read', files: [{ buffer: Buffer.from('a'), mediaType: 'image/jpeg' }] });
  const theirs = await archiveReceiptScan({ userId: 'u2', outcome: 'read', files: [{ buffer: Buffer.from('b'), mediaType: 'image/jpeg' }] });
  expect(await purgeUserReceiptScans('u1')).toBe(1);
  expect(rows.map((r) => r.user)).toEqual(['u2']);
  expect(files()).toEqual([theirs.files[0].name]);
  expect(files()).not.toContain(mine.files[0].name);
});
