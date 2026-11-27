/**
 * The words users read for each flagged feature (backend config/featureFlags
 * holds the keys and states): its name, what it changes, and where to find
 * it. Literal keys with English fallbacks, as everywhere else, so Weblate
 * sees them. A key this build does not know (a flag newer than the frontend
 * that is reading it) falls back to the bare key.
 */
export function betaFeatureText(t, key) {
  switch (key) {
    case 'pickLists':
      return {
        name: t('earlyAccess.features.pickLists.name', 'Pick lists'),
        description: t('earlyAccess.features.pickLists.description', 'Make a list of the bottles you are about to fetch — for a dinner, a tasting, or what to drink next — and see the cellar, rack and slot of each, in the order you walk past them. Tick bottles off as you pick them, print the list, and mark the picked ones as drunk in one go.'),
        where: t('earlyAccess.features.pickLists.where', 'In your cellar, tap Select, pick bottles and choose Pick list, or use ⋮ → Add to pick list on a bottle\'s page. Your lists are under Pick lists in the menu.'),
      };
    case 'maturityTimeline':
      return {
        name: t('earlyAccess.features.maturityTimeline.name', 'Drink window as a timeline'),
        description: t('earlyAccess.features.maturityTimeline.description', 'See a wine\'s drink window as one bar — early, peak and late — with a marker on this year, so you can tell at a glance how far the wine has come. The exact years stay listed below it.'),
        where: t('earlyAccess.features.maturityTimeline.where', 'On a bottle\'s page and a vintage\'s page, under Aging & Maturity.'),
      };
    case 'wallRack':
      return {
        name: t('earlyAccess.features.wallRack.name', 'A wall built from boxes'),
        description: t('earlyAccess.features.wallRack.description', 'Draw a whole wall of shelving as one rack. The wall is a grid of cells, and each box in it holds what yours does: an X of four triangles, a diagonal, a rack of single slots, shelves, an open bin, or a closed cupboard. A box can be several cells wide or high.'),
        where: t('earlyAccess.features.wallRack.where', 'On a cellar\'s Racks page, choose New rack and pick the type Wall.'),
      };
    default:
      return { name: key, description: '', where: '' };
  }
}
