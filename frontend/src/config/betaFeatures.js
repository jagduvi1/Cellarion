/**
 * The words users read for each flagged feature (backend config/featureFlags
 * holds the keys and states): its name, what it changes, and where to find
 * it. Literal keys with English fallbacks, as everywhere else, so Weblate
 * sees them. A key this build does not know (a flag newer than the frontend
 * that is reading it) falls back to the bare key.
 */
export function betaFeatureText(t, key) {
  switch (key) {
    case 'vintagePage':
      return {
        name: t('earlyAccess.features.vintagePage.name', 'One page per wine and vintage'),
        description: t('earlyAccess.features.vintagePage.description', 'Tapping a wine in your cellar list opens one page for that wine and vintage, whether you have one bottle or twenty: the wine, then the vintage, then each bottle with its slot, size, price and shop. Drink, Edit vintage and Add sit in a bar that stays in reach.'),
        where: t('earlyAccess.features.vintagePage.where', 'In your cellar list: tap any wine.'),
      };
    case 'rackMoveBottles':
      return {
        name: t('earlyAccess.features.rackMoveBottles.name', "Move a rack's bottles to another rack"),
        description: t('earlyAccess.features.rackMoveBottles.description', 'Move every bottle in a rack to another rack in the same cellar in one go. They keep their order and fill the other rack from its first free slot. Handy when you replace a rack, for example with a wine cabinet.'),
        where: t('earlyAccess.features.rackMoveBottles.where', 'On the Racks page: open a rack, then ⋮ → Move bottles to another rack.'),
      };
    default:
      return { name: key, description: '', where: '' };
  }
}
