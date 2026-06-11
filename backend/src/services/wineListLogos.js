const fs = require('fs');
const path = require('path');

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

module.exports = { LOGO_DIR, ensureLogoDir, deleteLogoFile, deleteLogoFilesFor };
