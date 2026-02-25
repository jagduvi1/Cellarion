const MS_PER_DAY = 86400000;

function today() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Returns drink status for a single bottle, or null if no dates are set.
 * status: 'overdue' | 'soon' | 'inWindow' | 'notReady'
 * daysLeft: positive = days remaining, negative = days overdue
 */
export function getDrinkStatus(bottle) {
  const { drinkFrom, drinkBefore } = bottle;
  if (!drinkFrom && !drinkBefore) return null;

  const now = today();
  const before = drinkBefore ? new Date(drinkBefore) : null;
  const from = drinkFrom ? new Date(drinkFrom) : null;

  if (before) {
    const daysLeft = Math.round((before - now) / MS_PER_DAY);
    if (daysLeft < 0) return { status: 'overdue', label: `${Math.abs(daysLeft)}d overdue`, daysLeft };
    if (daysLeft <= 90) return { status: 'soon', label: `Drink within ${daysLeft}d`, daysLeft };
  }

  if (from && now < from) {
    const daysUntil = Math.round((from - now) / MS_PER_DAY);
    return { status: 'notReady', label: `Ready in ${daysUntil}d`, daysLeft: daysUntil };
  }

  if (before) {
    const daysLeft = Math.round((before - now) / MS_PER_DAY);
    return { status: 'inWindow', label: `${daysLeft}d left in window`, daysLeft };
  }

  return { status: 'inWindow', label: 'In drinking window', daysLeft: null };
}

/**
 * Returns the most urgent drink status across a group of bottles.
 * Priority: overdue > soon > inWindow > notReady
 */
export function getGroupWorstStatus(bottles) {
  const statuses = bottles.map(getDrinkStatus).filter(Boolean);
  if (statuses.length === 0) return null;
  const priority = ['overdue', 'soon', 'inWindow', 'notReady'];
  for (const s of priority) {
    const found = statuses.find(x => x.status === s);
    if (found) return found;
  }
  return null;
}

/** Format a date string for display (e.g. "Mar 15, 2027") */
export function formatDrinkDate(dateStr) {
  if (!dateStr) return '';
  return new Date(dateStr).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

/** Convert a Date or ISO string to yyyy-mm-dd for date input value */
export function toInputDate(dateStr) {
  if (!dateStr) return '';
  return new Date(dateStr).toISOString().slice(0, 10);
}
