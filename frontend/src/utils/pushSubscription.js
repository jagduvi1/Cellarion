/**
 * Web Push subscription helpers.
 * Uses the Push API + Service Worker to subscribe/unsubscribe the browser.
 */

export function isPushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

export function getPushPermissionState() {
  if (!('Notification' in window)) return 'unsupported';
  return Notification.permission; // 'default' | 'granted' | 'denied'
}

/**
 * Convert a base64 VAPID public key to a Uint8Array for the subscribe call.
 */
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

/**
 * Subscribe to push notifications.
 * 1. Requests notification permission
 * 2. Subscribes via the service worker's PushManager
 * 3. Sends the subscription to the backend
 *
 * @param {Function} apiFetch - Authenticated fetch from useAuth()
 * @param {string} vapidPublicKey - VAPID public key from /api/settings
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function subscribeToPush(apiFetch, vapidPublicKey) {
  if (!isPushSupported()) {
    return { success: false, error: 'Push notifications are not supported in this browser' };
  }

  if (!vapidPublicKey) {
    return { success: false, error: 'Push notifications are not configured on this server' };
  }

  // Request permission
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    return { success: false, error: 'Notification permission denied' };
  }

  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidPublicKey)
    });

    const subJson = subscription.toJSON();
    const res = await apiFetch('/api/push-subscriptions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        endpoint: subJson.endpoint,
        keys: subJson.keys
      })
    });

    if (!res.ok) {
      return { success: false, error: 'Failed to save subscription on server' };
    }

    return { success: true };
  } catch (err) {
    return { success: false, error: err.message || 'Failed to subscribe to push' };
  }
}

/**
 * Unsubscribe from push notifications.
 *
 * @param {Function} apiFetch - Authenticated fetch from useAuth()
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function unsubscribeFromPush(apiFetch) {
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();

    if (subscription) {
      const endpoint = subscription.endpoint;
      await subscription.unsubscribe();

      await apiFetch('/api/push-subscriptions', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint })
      });
    }

    return { success: true };
  } catch (err) {
    return { success: false, error: err.message || 'Failed to unsubscribe' };
  }
}
