// Bottles on order: bought, not delivered yet (status 'ordered'). The
// expected arrival is a MONTH, stored by the server as the 1st of that month
// at noon UTC (backend utils/onOrder), so every helper here reads it in UTC.

export const ORDERED_STATUS = 'ordered';

export const isOnOrder = (bottle) => bottle?.status === ORDERED_STATUS;

/** 'YYYY-MM' for an <input type="month">, or '' when there is no date. */
export function toMonthInput(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** "March 2027" in the reader's language; '' when there is no date. */
export function formatArrivalMonth(value, locale) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(locale || undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** The expected month has fully passed: an order due in March is late from 1 April. */
export function isArrivalLate(value, now = new Date()) {
  if (!value) return false;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return false;
  return now.getTime() >= Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

/**
 * One row per delivery: same wine, vintage, size and expected month. The
 * server sends the bottles soonest-expected first, undated last; groups keep
 * that order (a group sits where its first bottle does).
 */
export function groupOnOrder(bottles) {
  const groups = new Map();
  for (const b of bottles || []) {
    const wine = b.wineDefinition?._id || b.pendingWineRequest?._id || b._id;
    const key = [wine, b.vintage || 'NV', b.bottleSize || '750ml', toMonthInput(b.expectedArrival)].join('|');
    if (!groups.has(key)) groups.set(key, { key, bottles: [] });
    groups.get(key).bottles.push(b);
  }
  return [...groups.values()];
}

/** Sum of prices per currency: [{ currency, total }] (bottles without a price are left out). */
export function totalsByCurrency(bottles) {
  const sums = new Map();
  for (const b of bottles || []) {
    const price = Number(b.price);
    if (!Number.isFinite(price) || price <= 0) continue;
    const cur = b.currency || 'USD';
    sums.set(cur, (sums.get(cur) || 0) + price);
  }
  return [...sums.entries()].map(([currency, total]) => ({ currency, total }));
}

/** Today as 'YYYY-MM-DD' in the reader's own zone (for a date input's default). */
export function todayInput() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
