import { useMemo } from 'react';
import { useLocation, useNavigationType } from 'react-router-dom';
import { isSafeInternalPath } from './postLoginRedirect';

// The pages a bottle page's back link can lead back to, by name. The label is
// looked up when the bottle page shows it (so it follows a language switch),
// and only these names are taken from the router state.
export const BACK_PLACES = {
  // The cellar's bottle list, as it was left: one cellar, or several when
  // "all my cellars" was chosen there.
  cellar: ['bottleDetail.backToCellar', 'Back to cellar'],
  racks: ['bottleDetail.backToRacks', 'Back to the racks'],
  room: ['bottleDetail.backToRoom', 'Back to the room'],
  pickList: ['bottleDetail.backToPickList', 'Back to the pick list'],
  statistics: ['bottleDetail.backToStatistics', 'Back to the statistics'],
  allBottles: ['bottleDetail.backToAllBottles', 'Back to all bottles'],
};

/** [i18n key, English fallback] for a handed-over place, or null. */
export const backPlaceLabel = (from) => (typeof from === 'string' && Object.hasOwn(BACK_PLACES, from) ? BACK_PLACES[from] : null);

// The state a link to a bottle carries so the bottle page's back link leads
// back to this page (BottleDetail reads location.state.backTo / backFrom and
// checks it is an in-app path).
export function useBackHere(from) {
  const { pathname, search } = useLocation();
  return useMemo(() => ({ backTo: pathname + search, backFrom: from }), [pathname, search, from]);
}

// The state an on-screen back link carries: following it is coming back, the
// same as the phone's Back.
export const RETURNING = { returning: true };

/**
 * The cellar list a visit started from, out of a page's router state, or
 * null. A bottle opened from the list carries it as its back place
 * ({ backTo, backFrom: 'cellar' }); a vintage page opened from the list
 * carries it as `cellarList` and hands it on to its bottles. Leaving for it
 * is coming back, so the list returns as it was left — "all my cellars" still
 * chosen if it was — even when the bottle lives in another cellar. In-app
 * cellar paths only.
 */
export function cellarListFrom(state) {
  const path = state?.cellarList ?? (state?.backFrom === 'cellar' ? state?.backTo : null);
  return isSafeInternalPath(path) && path.startsWith('/cellars/') ? path : null;
}

/**
 * Whether this page was come back to — Back/Forward, a reload, or a back link
 * — rather than opened fresh from a link. Lists restore where they were left
 * only then.
 */
export function useCameBack() {
  const type = useNavigationType();
  const { state } = useLocation();
  return type === 'POP' || state?.returning === true;
}
