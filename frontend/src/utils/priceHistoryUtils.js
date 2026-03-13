/**
 * Calculate the price change between two price history entries.
 *
 * @param {{ price: number }} latest  - Most recent price entry
 * @param {{ price: number }|null} previous - Previous price entry (or null)
 * @returns {{ diff: number, pct: string, up: boolean }|null}
 */
export function calculatePriceChange(latest, previous) {
  if (!previous || previous.price === 0) return null;
  const diff = latest.price - previous.price;
  const pct = ((diff / previous.price) * 100).toFixed(1);
  return { diff, pct, up: diff >= 0 };
}
