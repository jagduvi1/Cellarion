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

/**
 * Which (tier, interval) pairs actually have a Stripe Price configured, so the
 * page never offers a button that cannot complete checkout. Booleans only.
 */
export const getAvailability = (apiFetch) => apiFetch('/api/stripe/availability');

/** Create a Stripe Customer Portal session and return the redirect URL. */
export const createPortal = (apiFetch) =>
  apiFetch('/api/stripe/portal', { method: 'POST' });
