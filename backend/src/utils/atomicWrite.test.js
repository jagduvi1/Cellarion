/**
 * utils/atomicWrite — a file lands complete or not at all (release audit
 * 2026-09-27, L: kept photos were written straight into a publicly served,
 * immutably cached folder).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeFileAtomic, writeFileAtomicSync } = require('./atomicWrite');

let dir;
beforeEach(async () => { dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'atomic-')); });
afterEach(async () => { await fs.promises.rm(dir, { recursive: true, force: true }); });

const files = () => fs.readdirSync(dir).sort();

test('async: the file has the bytes and no temp file is left', async () => {
  const target = path.join(dir, 'photo.webp');
  await writeFileAtomic(target, Buffer.from('bytes'));
  expect(fs.readFileSync(target).toString()).toBe('bytes');
  expect(files()).toEqual(['photo.webp']);
});

test('sync: the same', () => {
  const target = path.join(dir, 'photo.webp');
  writeFileAtomicSync(target, Buffer.from('bytes'));
  expect(fs.readFileSync(target).toString()).toBe('bytes');
  expect(files()).toEqual(['photo.webp']);
});

test('an existing file is replaced whole, never truncated first', async () => {
  const target = path.join(dir, 'photo.webp');
  fs.writeFileSync(target, 'old-and-longer');
  await writeFileAtomic(target, Buffer.from('new'));
  expect(fs.readFileSync(target).toString()).toBe('new');
  expect(files()).toEqual(['photo.webp']);
});

test('a failed write leaves neither the file nor its temp name behind', async () => {
  const target = path.join(dir, 'missing-folder', 'photo.webp');
  await expect(writeFileAtomic(target, Buffer.from('bytes'))).rejects.toThrow();
  expect(() => writeFileAtomicSync(target, Buffer.from('bytes'))).toThrow();
  expect(files()).toEqual([]);
});
