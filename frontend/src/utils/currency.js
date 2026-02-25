// Module-level frontend cache — avoids repeated API calls within the same session
let ratesCache = null;
let ratesFetchedAt = 0;
const FRONTEND_CACHE_TTL = 60 * 60 * 1000; // 1 hour
/**
 * Fetch USD-based exchange rates from open.er-api.com (CORS-enabled, free, no key).
 * Returns a rates object like { USD: 1, EUR: 0.92, SEK: 10.5, ... }
 * Returns null on error — callers should degrade gracefully.
 */
export async function fetchRates() {
  if (ratesCache && Date.now() - ratesFetchedAt < FRONTEND_CACHE_TTL) {
    return ratesCache;
  }
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/USD');
    if (!res.ok) return ratesCache;
    const data = await res.json();
    if (data.result !== 'success' || !data.rates) return ratesCache;
    ratesCache = data.rates; // already includes USD: 1
    ratesFetchedAt = Date.now();
    return ratesCache;
  } catch {
    return ratesCache; // return stale on network error, or null on first failure
  }
}

/**
 * Convert an amount from one currency to another using USD-base rates.
 * Returns null if conversion is not possible or not needed (same currency).
 */
export function convertAmount(amount, from, to, rates) {
  if (!rates || !from || !to || from === to) return null;
  const fromRate = rates[from];
  const toRate   = rates[to];
  if (!fromRate || !toRate) return null;
  const inUSD = amount / fromRate;
  return Math.round(inUSD * toRate * 100) / 100;
}

