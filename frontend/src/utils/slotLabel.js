// The pile of a wall box, as a word. Literal keys, so the translators' tool sees them.
function sectionWord(section, t) {
  switch (section) {
    case 'top': return t('places.sectionTop', 'top');
    case 'left': return t('places.sectionLeft', 'left');
    case 'right': return t('places.sectionRight', 'right');
    case 'bottom': return t('places.sectionBottom', 'bottom');
    case 'upper': return t('places.sectionUpper', 'upper');
    case 'lower': return t('places.sectionLower', 'lower');
    default: return '';
  }
}

/**
 * The spot of a bottle in a wall rack, in words: "B2 left · 3" (the third
 * bottle from the bottom of the left pile of box B2), "A3 · 12" in an open
 * bin, "A1 · row 2, 3" in a rack box, "C1 · shelf 2, 3" on shelves. `wall`
 * is what the server sends with a slot of a wall rack (backend
 * utils/wallGeometry wallPlace) or what utils/wallLayout slotPlace works out
 * from the rack; '' when there is none.
 */
export function wallWords(wall, t) {
  if (!wall) return '';
  if (wall.row != null) {
    return wall.kind === 'shelves'
      ? t('places.shelf', '{{box}} · shelf {{row}}, {{n}}', { box: wall.box, row: wall.row, n: wall.col })
      : t('places.row', '{{box}} · row {{row}}, {{n}}', { box: wall.box, row: wall.row, n: wall.col });
  }
  if (!wall.section) return t('places.bin', '{{box}} · {{n}}', { box: wall.box, n: wall.slot });
  return t('places.pile', '{{box}} {{section}} · {{n}}', { box: wall.box, section: sectionWord(wall.section, t), n: wall.slot });
}

/**
 * Where a bottle sits, in words: "Left wall · slot 7", the rack's name when
 * the slot has no number, or "Not in a rack". `rackInfo` is the
 * { rackName, position } the cellar routes attach to a bottle. One wording
 * for Drink one, the vintage page's rows and the bottle page's label. In a
 * wall rack the slot number gives way to the box and the spot in it:
 * "Cellar wall · B2 left · 3".
 */
export function slotLabel(rackInfo, t) {
  if (!rackInfo) return t('drinkOne.unplaced', 'Not in a rack');
  if (rackInfo.wall) return t('places.inRack', '{{rack}} · {{place}}', { rack: rackInfo.rackName, place: wallWords(rackInfo.wall, t) });
  return rackInfo.position != null
    ? t('drinkOne.slot', '{{rack}} · slot {{position}}', { rack: rackInfo.rackName, position: rackInfo.position })
    : rackInfo.rackName;
}
