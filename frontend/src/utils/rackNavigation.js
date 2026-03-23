const DESKTOP_BREAKPOINT = 768;

/**
 * Build the correct URL for navigating to a rack/bottle location,
 * respecting the user's rackNavigation preference and screen size.
 *
 * @param {string} cellarId
 * @param {object} opts
 * @param {string}  [opts.rackId]       — rack to focus (used in room URL)
 * @param {string}  [opts.bottleId]     — bottle to highlight
 * @param {boolean} [opts.inRoom=false] — whether the rack is placed in the 3D room layout
 * @param {string}  [opts.preference='auto'] — user preference: 'auto' | 'room' | 'rack'
 * @returns {string} URL path with query string
 */
export function buildRackUrl(cellarId, { rackId, bottleId, inRoom = false, preference = 'auto' } = {}) {
  const useRoom = shouldUseRoom(inRoom, preference);

  if (useRoom && rackId) {
    const params = new URLSearchParams();
    params.set('focusRack', rackId);
    if (bottleId) params.set('highlight', bottleId);
    return `/cellars/${cellarId}/room?${params}`;
  }

  // Fallback: 2D rack view
  const params = new URLSearchParams();
  if (bottleId) {
    params.set('highlight', bottleId);
  } else if (rackId) {
    params.set('rack', rackId);
  }
  const qs = params.toString();
  return `/cellars/${cellarId}/racks${qs ? `?${qs}` : ''}`;
}

/**
 * Determine whether to navigate to the 3D room view.
 */
function shouldUseRoom(inRoom, preference) {
  if (!inRoom) return false;
  if (preference === 'room') return true;
  if (preference === 'rack') return false;
  // 'auto': desktop → room, mobile → rack
  return window.innerWidth >= DESKTOP_BREAKPOINT;
}
