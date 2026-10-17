// "Move back to cellar" (POST /api/bottles/:id/restore) undoes an accidental
// drink, gift or sale — only within two days, the server's RESTORE_WINDOW_MS
// (services/bottleOps). One rule for the bottle page and the history cards.
export const RESTORE_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;

/**
 * Whether a bottle taken out of the cellar can still be moved back. The window
 * counts from when the take-out was logged (a backdated bulk "mark as drunk"
 * stays undoable); rows from before that field only have consumedAt.
 */
export function withinRestoreWindow(bottle, now = Date.now()) {
  const anchor = bottle?.consumedLoggedAt || bottle?.consumedAt;
  if (!anchor) return false;
  return now - new Date(anchor).getTime() <= RESTORE_WINDOW_MS;
}
