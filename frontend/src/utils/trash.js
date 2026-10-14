// How long "Recently deleted" keeps a bottle — services/bottleTrash TRASH_DAYS.
// Its own small module so a screen that only needs the number does not pull in
// the (lazy-loaded) BulkDeleteModal with it.
export const TRASH_DAYS = 30;

// Why a bottle could not come back (POST /api/bottles/trash/restore reasons) →
// the plural message family that says so.
export const RESTORE_SKIP_KEYS = {
  wine_gone: 'trash.skippedWineGone',
  cellar_gone: 'trash.skippedCellarGone',
  exists: 'trash.skippedExists',
};
