/**
 * The words users read for each flagged feature (backend config/featureFlags
 * holds the keys and states): its name, what it changes, and where to find
 * it. Literal keys with English fallbacks, as everywhere else, so Weblate
 * sees them. A key this build does not know (a flag newer than the frontend
 * that is reading it) falls back to the bare key.
 */
export function betaFeatureText(t, key) {
  switch (key) {
    case 'rackMoveBottles':
      return {
        name: t('earlyAccess.features.rackMoveBottles.name', "Move a rack's bottles to another rack"),
        description: t('earlyAccess.features.rackMoveBottles.description', 'Move every bottle in a rack to another rack in the same cellar in one go. They keep their order and fill the other rack from its first free slot. Handy when you replace a rack, for example with a wine cabinet.'),
        where: t('earlyAccess.features.rackMoveBottles.where', 'On the Racks page: open a rack, then ⋮ → Move bottles to another rack.'),
      };
    case 'cabinetHeadToTail':
      return {
        name: t('earlyAccess.features.cabinetHeadToTail.name', 'Wine cabinet bottles head to tail'),
        description: t('earlyAccess.features.cabinetHeadToTail.description', 'For a wine cabinet whose bottles lie one deep, base forward and neck forward in turn. The cabinet drawings then show every other bottle neck forward. The slot numbers stay the same, so you can switch it on for a cabinet that already holds bottles.'),
        where: t('earlyAccess.features.cabinetHeadToTail.where', 'On the Racks page: create or edit a wine cabinet, untick Two deep, then tick Bottles lie head to tail.'),
      };
    case 'cabinetSideways':
      return {
        name: t('earlyAccess.features.cabinetSideways.name', 'Wine cabinet bottles lying sideways'),
        description: t('earlyAccess.features.cabinetSideways.description', 'For each shelf of a wine cabinet, choose how its bottles lie: front to back, with one bottle lying across the front of the others (as in a slim fridge), or all lying across (as in a bottom bin). The cabinet drawings follow, including the 3D view. The slot numbers stay the same, so you can change it on a cabinet that already holds bottles. Includes a starting shape for the Kingsbottle Atelier Duo.'),
        where: t('earlyAccess.features.cabinetSideways.where', 'On the Racks page: create or edit a wine cabinet and pick how each shelf\'s bottles lie, or start from Kingsbottle → Atelier Duo.'),
      };
    case 'pickLists':
      return {
        name: t('earlyAccess.features.pickLists.name', 'Pick lists'),
        description: t('earlyAccess.features.pickLists.description', 'Make a list of the bottles you are about to fetch — for a dinner, a tasting, or what to drink next — and see the cellar, rack and slot of each, in the order you walk past them. Tick bottles off as you pick them, print the list, and mark the picked ones as drunk in one go.'),
        where: t('earlyAccess.features.pickLists.where', 'In your cellar, tap Select, pick bottles and choose Pick list, or use ⋮ → Add to pick list on a bottle\'s page. Your lists are under Pick lists in the menu.'),
      };
    case 'rackSlotMove':
      return {
        name: t('earlyAccess.features.rackSlotMove.name', 'Move a bottle by tapping'),
        description: t('earlyAccess.features.rackSlotMove.description', 'Move a bottle to another slot without dragging — made for phones, where dragging does not work. Tap the bottle, choose Move, then tap the slot it should go to. On a bottle in the same rack the two swap places.'),
        where: t('earlyAccess.features.rackSlotMove.where', 'On the Racks page: tap a bottle, then Move.'),
      };
    default:
      return { name: key, description: '', where: '' };
  }
}
