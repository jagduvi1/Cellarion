import { API_URL } from '../api/apiConstants';

// Module-level frontend cache — avoids repeated API calls within the same session
let ratesCache = null;
let ratesFetchedAt = 0;   // time of the last SUCCESSFUL fetch
let lastAttemptAt = 0;    // time of the last attempt (success or failure)
const FRONTEND_CACHE_TTL = 60 * 60 * 1000; // 1 hour on success
const FAILURE_BACKOFF = 5 * 60 * 1000;     // negative-cache window after a failure
/**
 * Fetch USD-based exchange rates from OUR backend (GET /api/exchange-rates),
 * which keeps one daily snapshot from its upstream provider. The browser no
 * longer talks to the provider itself, so no visitor IP leaves the site for
 * this (audit 2026-09 F03-4).
 * Returns a rates object like { USD: 1, EUR: 0.92, SEK: 10.5, ... }
 * Returns null on error — callers should degrade gracefully.
 */
export async function fetchRates() {
  const now = Date.now();
  if (ratesCache && now - ratesFetchedAt < FRONTEND_CACHE_TTL) {
    return ratesCache;
  }
  // Negative caching: after a failed/stale attempt, wait out the backoff before
  // hitting the (likely still-down) FX API again instead of retrying every call.
  if (now - lastAttemptAt < FAILURE_BACKOFF) {
    return ratesCache;
  }
  lastAttemptAt = now;
  try {
    const res = await fetch(`${API_URL}/api/exchange-rates`);
    if (!res.ok) return ratesCache;
    const data = await res.json();
    if (!data || typeof data.rates !== 'object' || !data.rates) return ratesCache;
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

/**
 * Convert using historically-anchored rates stored at the time of price entry.
 * Falls back to live rates when no historical snapshot is available.
 * This ensures that past values are never distorted by later exchange-rate movements.
 */
export function convertAmountHistorical(amount, from, to, historicalRates, fallbackRates = null) {
  if (!from || !to || from === to) return null;
  const result = convertAmount(amount, from, to, historicalRates);
  if (result !== null) return result;
  return convertAmount(amount, from, to, fallbackRates);
}

