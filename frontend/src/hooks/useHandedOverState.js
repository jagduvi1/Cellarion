import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';

/**
 * A value another page handed over in the navigation's router state
 * (`navigate(to, { state: { [key]: value } })`), read ONCE: kept in this
 * component's state, then taken off the history entry, so Back, Forward or a
 * reload never hands it over again (an Undo for a bottle already undone).
 *
 * Taken off with history.replaceState rather than a router navigation: a
 * second navigation in the same commit as the page's own URL clean-up (the
 * cellar page clears its filter params on mount) could put back what that
 * one removed, and would re-run every effect keyed on the location. The
 * router keeps its state under history.state.usr; under a MemoryRouter there
 * is nothing there and this does nothing.
 */
// The other channel: a value handed over to a page reached by going BACK
// (router state cannot ride a pop) — one item in sessionStorage naming the
// key and the page's path, read once, and only within a minute.
const STORE = 'cellarion.handOver';
const MAX_AGE_MS = 60 * 1000;

/** Leave `value` for the page at `path` that is about to be reached by Back. */
export function handOverBack(key, path, value) {
  try { sessionStorage.setItem(STORE, JSON.stringify({ key, path, value, at: Date.now() })); } catch { /* no storage: no notice */ }
}

function peekHandedBack(key, path) {
  try {
    const item = JSON.parse(sessionStorage.getItem(STORE) || 'null');
    if (!item || item.key !== key || item.path !== path || !(Date.now() - item.at < MAX_AGE_MS)) return null;
    return item.value ?? null;
  } catch { return null; }
}

export default function useHandedOverState(key) {
  const location = useLocation();
  // Peeked here, removed in the effect: StrictMode calls this twice.
  const [value, setValue] = useState(() => location.state?.[key] ?? peekHandedBack(key, location.pathname));
  useEffect(() => {
    try {
      if (peekHandedBack(key, location.pathname) !== null) sessionStorage.removeItem(STORE);
    } catch { /* nothing to take off */ }
    try {
      const entry = window.history.state;
      if (!entry?.usr || entry.usr[key] === undefined) return;
      const { [key]: _handedOver, ...rest } = entry.usr;
      window.history.replaceState({ ...entry, usr: Object.keys(rest).length ? rest : null }, '');
    } catch { /* history not writable — the worst case is the notice once more */ }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return [value, setValue];
}
