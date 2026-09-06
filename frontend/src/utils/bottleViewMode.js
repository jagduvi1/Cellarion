// The bottle list remembers list vs card per browser. 'table' was a third
// mode until the analytics table moved to the Dashboard page (support ticket
// 2026-09-05: the cellar page's own search bar and filters sat above a table
// they did not filter). A stored 'table' now falls back to the list, so
// nobody opens a cellar into a mode that no longer exists there.
export const VIEW_MODES = ['list', 'card'];
export const VIEW_MODE_KEY = 'cellarion_bottle_view';

export function readBottleViewMode(storage = globalThis.localStorage) {
  try {
    const v = storage ? storage.getItem(VIEW_MODE_KEY) : null;
    return VIEW_MODES.includes(v) ? v : 'list';
  } catch {
    return 'list';
  }
}

export function storeBottleViewMode(mode, storage = globalThis.localStorage) {
  try {
    if (storage) storage.setItem(VIEW_MODE_KEY, mode);
  } catch {
    // Private mode / quota — the preference just does not persist.
  }
}
