import { useSyncExternalStore } from 'react';
import { API_URL } from '../api/apiConstants';

/**
 * Whether this server reviews contributions before they go live (public
 * GET /api/site/review; backend config/contributionReview). The texts that
 * promise "a curator reviews it" say so only where one does: on a server
 * whose admin turned review off, a photo, a fix or a value goes live as it
 * is made (discussion #1778).
 *
 * Fetched once per page load and shared by every component. Until the answer
 * arrives — or without one — it reads as reviewed, the setting every server
 * starts with. The admin switch updates it at once (setContributionReviewed).
 */

let reviewed = true;
let loading = null;
const listeners = new Set();

function emit() {
  for (const l of listeners) l();
}

function load() {
  if (loading) return loading;
  try {
    loading = fetch(`${API_URL}/api/site/review`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data && typeof data.reviewed === 'boolean' && data.reviewed !== reviewed) {
          reviewed = data.reviewed;
          emit();
        }
      })
      .catch(() => { /* offline or down: keep the safe default */ });
  } catch {
    loading = Promise.resolve();
  }
  return loading;
}

function subscribe(listener) {
  listeners.add(listener);
  load();
  return () => listeners.delete(listener);
}

/** After the admin switch: the texts follow without a reload. */
export function setContributionReviewed(value) {
  reviewed = value !== false;
  emit();
}

/** True when contributions wait for a curator (the default). */
export function useContributionReviewed() {
  return useSyncExternalStore(subscribe, () => reviewed, () => true);
}

// Tests only: forget the cached answer.
export function resetContributionReviewForTests() {
  reviewed = true;
  loading = null;
}
