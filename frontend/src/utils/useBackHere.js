import { useMemo } from 'react';
import { useLocation } from 'react-router-dom';

// The state a link to a bottle carries so the bottle page's back link leads
// back to this page, with its label ("Back to the racks") — BottleDetail reads
// location.state.backTo / backLabel and checks it is an in-app path.
export function useBackHere(label) {
  const { pathname, search } = useLocation();
  return useMemo(() => ({ backTo: pathname + search, backLabel: label }), [pathname, search, label]);
}
