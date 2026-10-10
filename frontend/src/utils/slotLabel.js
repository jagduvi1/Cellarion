/**
 * Where a bottle sits, in words: "Left wall · slot 7", the rack's name when
 * the slot has no number, or "Not in a rack". `rackInfo` is the
 * { rackName, position } the cellar routes attach to a bottle. One wording
 * for Drink one, the vintage page's rows and the bottle page's label.
 */
export function slotLabel(rackInfo, t) {
  if (!rackInfo) return t('drinkOne.unplaced', 'Not in a rack');
  return rackInfo.position != null
    ? t('drinkOne.slot', '{{rack}} · slot {{position}}', { rack: rackInfo.rackName, position: rackInfo.position })
    : rackInfo.rackName;
}
