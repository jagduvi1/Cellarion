/**
 * Write a file so that no reader ever sees it half-written.
 *
 * The kept photos and uploads land in folders that are served publicly with a
 * year-long immutable cache (middleware/uploadsStatic): a request that raced a
 * plain writeFile could read — and a CDN cache — a truncated image forever
 * (release audit 2026-09-27, L). The bytes go to a temp name in the same
 * folder first and are renamed into place; rename is atomic on the same
 * filesystem, so the final name either does not exist yet or is complete.
 */
const fs = require('fs');

const tmpNameFor = (filePath) => `${filePath}.${process.pid}.${Date.now()}.${Math.floor(Math.random() * 1e6)}.tmp`;

async function writeFileAtomic(filePath, data) {
  const tmp = tmpNameFor(filePath);
  try {
    await fs.promises.writeFile(tmp, data);
    await fs.promises.rename(tmp, filePath);
  } catch (err) {
    await fs.promises.unlink(tmp).catch(() => {});
    throw err;
  }
}

function writeFileAtomicSync(filePath, data) {
  const tmp = tmpNameFor(filePath);
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* never written */ }
    throw err;
  }
}

module.exports = { writeFileAtomic, writeFileAtomicSync };
