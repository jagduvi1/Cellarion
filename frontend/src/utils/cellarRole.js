// Who may change what a cellar holds: its owner and its editors.
//
// The answer for a cellar that has not loaded yet is no. A page decides which
// controls to show before the cellar arrives, and "not a viewer" is true of
// nothing at all, so a viewer would be offered Edit until the role came in.
export function canEditCellar(cellar) {
  return cellar?.userRole === 'owner' || cellar?.userRole === 'editor';
}
