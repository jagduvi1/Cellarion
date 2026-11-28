// The photo links of the import file in hand, kept in this browser only.
//
// A Ma Cave à Vins export links each wine to the photo its owner took in that
// app, and each link carries the owner's access token to it. A link never
// leaves the browser before the owner asked for the photos: the parsed rows
// carry an opaque reference instead (`photoRef`), which is what /validate
// echoes and a saved draft keeps; the link itself is put back only into the
// /confirm items, and only when the box is ticked
// (utils/importPayload applyImportPhotoChoice). Each file read starts a new
// set, so a reference from another file — results still on screen, a resumed
// draft — resolves to nothing.
//
// The photo stores mirror backend config/importPhotoSources, which decides;
// here they only keep links the server would refuse out of the count and the
// box.

const PHOTO_STORES = [
  { host: 'firebasestorage.googleapis.com', pathPrefix: '/v0/b/ma-cave-a-vins-app.appspot.com/o/' },
];

let refByLink = new Map();
let linkByRef = new Map();
let setId = '';
let next = 0;

/** True for an https link on one of the photo stores an import may copy from. */
export function isImportPhotoLink(value) {
  if (typeof value !== 'string') return false;
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.port || url.username || url.password) return false;
  return PHOTO_STORES.some((s) => url.hostname === s.host && url.pathname.startsWith(s.pathPrefix));
}

/** Start the links of a new file; the references of the one before resolve to nothing. */
export function startPhotoLinks() {
  refByLink = new Map();
  linkByRef = new Map();
  setId = Math.random().toString(36).slice(2, 10);
  next = 0;
}

/**
 * The reference for one photo link (the same link, the same reference), or
 * undefined for a link no photo store would serve.
 */
export function photoRefFor(link) {
  if (!isImportPhotoLink(link)) return undefined;
  const key = link.trim();
  if (!refByLink.has(key)) {
    next += 1;
    const ref = `photo-${setId}-${next}`;
    refByLink.set(key, ref);
    linkByRef.set(ref, key);
  }
  return refByLink.get(key);
}

/** The link behind a reference of the file in hand, or undefined. */
export function photoLinkFor(ref) {
  return typeof ref === 'string' ? linkByRef.get(ref) : undefined;
}
