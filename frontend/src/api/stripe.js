import { JSON_HEADERS } from './apiConstants';

/**
 * Create a Stripe Checkout session and return the redirect URL.
 * `interval` picks the billing cadence ('month' | 'year'); the tier granted is
 * the same either way.
 */
export const createCheckout = (apiFetch, plan, interval = 'month') =>
  apiFetch('/api/stripe/checkout', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ plan, interval })
  });

/** Create a Stripe Customer Portal session and return the redirect URL. */
export const createPortal = (apiFetch) =>
  apiFetch('/api/stripe/portal', { method: 'POST' });
