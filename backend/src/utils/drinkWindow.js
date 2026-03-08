const { MS_PER_DAY } = require('../config/constants');

/**
 * Classify a drink window into one of five buckets.
 *
 * @param {Date|null} from   Start of the window (null = no lower bound)
 * @param {Date|null} before End of the window (null = no upper bound)
 * @param {Date}      now    Reference date (midnight)
 * @returns {'overdue'|'soon'|'inWindow'|'notReady'|'noWindow'}
 */
function classifyDrinkWindow(from, before, now) {
  if (!from && !before) return 'noWindow';
  if (before) {
    const daysLeft = Math.round((before - now) / MS_PER_DAY);
    if (daysLeft < 0)  return 'overdue';
    if (daysLeft <= 90) return 'soon';
    if (!from || now >= from) return 'inWindow';
    return 'notReady';
  }
  return now < from ? 'notReady' : 'inWindow';
}

module.exports = { classifyDrinkWindow };
