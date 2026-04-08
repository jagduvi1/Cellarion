import { JSON_HEADERS } from './apiConstants';

/** Create a Stripe Checkout session and return the redirect URL. */
export const createCheckout = (apiFetch, plan) =>
  apiFetch('/api/stripe/checkout', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ plan })
  });

/** Create a Stripe Customer Portal session and return the redirect URL. */
export const createPortal = (apiFetch) =>
  apiFetch('/api/stripe/portal', { method: 'POST' });
