// The bottle list remembers list vs card per browser. 'table' is not a mode
// here (the analytics table lives on the Dashboard page): a stored 'table'
// falls back to the list, so nobody opens a cellar into a mode that does
// not exist there.
export const VIEW_MODES = ['list', 'card'];
export const VIEW_MODE_KEY = 'cellarion_bottle_view';

// Without `storage` (the app) this browser's localStorage is used. It is looked
// up inside the try: with site data blocked, the getter itself throws.
const storageOrDefault = (storage) => (storage === undefined ? globalThis.localStorage : storage);

export function readBottleViewMode(storage) {
  try {
    const store = storageOrDefault(storage);
    const v = store ? store.getItem(VIEW_MODE_KEY) : null;
    return VIEW_MODES.includes(v) ? v : 'list';
  } catch {
    return 'list';
  }
}

export function storeBottleViewMode(mode, storage) {
  try {
    const store = storageOrDefault(storage);
    if (store) store.setItem(VIEW_MODE_KEY, mode);
  } catch {
    // Private mode / quota — the preference just does not persist.
  }
}
