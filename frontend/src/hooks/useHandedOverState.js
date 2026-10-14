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
export default function useHandedOverState(key) {
  const location = useLocation();
  const [value, setValue] = useState(() => location.state?.[key] ?? null);
  useEffect(() => {
    try {
      const entry = window.history.state;
      if (!entry?.usr || entry.usr[key] === undefined) return;
      const { [key]: _handedOver, ...rest } = entry.usr;
      window.history.replaceState({ ...entry, usr: Object.keys(rest).length ? rest : null }, '');
    } catch { /* history not writable — the worst case is the notice once more */ }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return [value, setValue];
}
