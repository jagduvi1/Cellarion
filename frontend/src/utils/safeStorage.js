// Web storage that never throws. A browser that blocks site data throws a
// SecurityError from the localStorage / sessionStorage getters themselves, and
// some private modes throw on reads and writes. For the app that only means a
// choice is not remembered — never a screen that fails. `area` is 'local' (the
// default) or 'session'.

const storageArea = (area) => (area === 'session' ? window.sessionStorage : window.localStorage);

/** The stored string, or null when there is none or storage is blocked. */
export function readStored(key, area = 'local') {
  try { return storageArea(area).getItem(key); } catch { return null; }
}

/** Stores the value; with storage blocked it is simply not remembered. */
export function writeStored(key, value, area = 'local') {
  try { storageArea(area).setItem(key, value); } catch { /* not remembered */ }
}

export function removeStored(key, area = 'local') {
  try { storageArea(area).removeItem(key); } catch { /* nothing stored to remove */ }
}
