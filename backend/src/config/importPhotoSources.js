/**
 * Where an import may copy a photo from: the photo store of a cellar app whose
 * export links each wine to the photo its owner took in that app. Only these:
 * an import file is never a way to make the server fetch an address of the
 * file's choosing. A link is one of them when it is https on the default
 * port, on the host, and under the path prefix (compared as the URL parser
 * writes the path, so "../" cannot climb out of it).
 *
 * Used by services/importPhotos for the rows routes/import.js /confirm hands it.
 */
const MAX_PHOTO_URL_LENGTH = 2048;

const IMPORT_PHOTO_SOURCES = [
  // Ma Cave à Vins (frontend utils/importMaCave.js): a Firebase Storage
  // download link per wine, with the owner's access token in its query.
  { source: 'macave', host: 'firebasestorage.googleapis.com', pathPrefix: '/v0/b/ma-cave-a-vins-app.appspot.com/o/' },
];

/** The source a photo link belongs to, or null when it is not one we copy from. */
function importPhotoSource(url) {
  if (typeof url !== 'string' || url.length > MAX_PHOTO_URL_LENGTH) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.port || parsed.username || parsed.password) return null;
  return IMPORT_PHOTO_SOURCES.find((s) => parsed.hostname === s.host && parsed.pathname.startsWith(s.pathPrefix)) || null;
}

module.exports = { importPhotoSource, IMPORT_PHOTO_SOURCES };
