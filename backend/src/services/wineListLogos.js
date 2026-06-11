const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LOGO_DIR = '/app/uploads/wine-list-logos';

/** Create the logo directory. Called by the upload route at startup — not at
 *  import time, so merely requiring this module (e.g. in tests via the GDPR
 *  registry) never touches the filesystem. */
function ensureLogoDir() {
  try { fs.mkdirSync(LOGO_DIR, { recursive: true }); } catch { /* Docker volume may already exist */ }
}

/** Delete a stored logo file, ignoring missing files. */
function deleteLogoFile(logoUrl) {
  if (!logoUrl) return;
  const filename = path.basename(logoUrl);
  try { fs.unlinkSync(path.join(LOGO_DIR, filename)); } catch { /* already gone */ }
}

/**
 * Delete the logo files of every wine list matching `filter`.
 * Call BEFORE deleting the WineList docs — they hold the only references.
 */
async function deleteLogoFilesFor(WineList, filter) {
  const lists = await WineList.find({ ...filter, 'branding.logoUrl': { $ne: null } })
    .select('branding.logoUrl').lean();
  for (const wl of lists) {
    deleteLogoFile(wl.branding?.logoUrl);
  }
}

/**
 * Copy a stored logo file under a fresh name and return the new logoUrl —
 * used when duplicating a wine list, so the copy never shares a file with
 * the original (deleting one would break the other). Returns null when the
 * source file is missing.
 */
function copyLogoFile(logoUrl) {
  if (!logoUrl) return null;
  const ext = path.extname(logoUrl);
  const newName = `${crypto.randomUUID()}${ext}`;
  try {
    fs.copyFileSync(path.join(LOGO_DIR, path.basename(logoUrl)), path.join(LOGO_DIR, newName));
    return `wine-list-logos/${newName}`;
  } catch {
    return null; // source gone — the duplicate simply has no logo
  }
}

module.exports = { LOGO_DIR, ensureLogoDir, deleteLogoFile, deleteLogoFilesFor, copyLogoFile };
