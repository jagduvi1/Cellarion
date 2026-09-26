import React, { createContext, useState, useContext, useEffect, useRef, useCallback } from 'react';
import { findLanguage } from '../config/locales';
import { createApiFetch } from '../utils/apiFetch';
import { clearApiCaches } from '../serviceWorkerRegistration';
import { saveOfflineUser, loadOfflineUser, clearOfflineUser, markPendingLogout, hasPendingLogout } from '../utils/offlineMode';
import { offlineAnswer, markLive, clearOfflineData } from '../utils/offlineSnapshot';
import { writeKeyFor, queueWrite } from '../utils/offlineQueue';

// A write succeeded somewhere in the app: OfflineSync refreshes the device's
// copy shortly after (components/OfflineSync.js).
export const API_MUTATION_EVENT = 'cellarion-api-mutation';
const notifyApiMutation = () => {
  try { window.dispatchEvent(new Event(API_MUTATION_EVENT)); } catch { /* noop */ }
};
import i18n, { hasLanguagePreview } from '../i18n';

const AuthContext = createContext();

// Refresh-in-flight marker (see doRefresh). Only a marker younger than
// REFRESH_MARK_TTL_MS counts; waiting is capped so a stale marker (a refresh
// that died with its page) costs at most REFRESH_WAIT_MAX_MS once.
const REFRESH_MARK = 'cellarion-refresh-inflight';
const REFRESH_MARK_TTL_MS = 5000;
export const REFRESH_WAIT_MAX_MS = 2500;

function markRefreshInFlight(on) {
  try {
    if (on) localStorage.setItem(REFRESH_MARK, String(Date.now()));
    else localStorage.removeItem(REFRESH_MARK);
  } catch { /* storage blocked — no guard, as before */ }
}

// Offline mode (#1355): how long a start waits for a refresh / profile on a
// weak signal before opening offline from the kept profile.
const START_WAIT_MS = 5000;
const TIMED_OUT = Symbol('timed-out');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * What a refresh answer says about the session. Only the server saying no
 * (401, or another 4xx that no retry can change) ends it. A 429 or a 5xx says
 * the server can't answer right now — a deploy restarting it (502/503 for a
 * few seconds), a hiccup, a rate limit — and used to sign people out exactly
 * like a rejection (scaling audit 2026-09-25).
 * @returns {'ok' | 'rejected' | 'unavailable'}
 */
export function refreshOutcome(status) {
  if (status >= 200 && status < 300) return 'ok';
  if (status === 408 || status === 425 || status === 429 || status >= 500) return 'unavailable';
  return 'rejected';
}

// A start whose refresh the server couldn't answer, with no device copy to
// open offline instead, tries again for a few seconds before showing the
// login page: a deploy is over by then.
export const START_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000];
const transientStatus = (status) => refreshOutcome(status) === 'unavailable';

/**
 * End this device's session on the server. The refresh cookie identifies it
 * (the bearer is optional), so this also works from an offline session. True
 * when the server answered; false with no network (then retried at next start).
 */
async function sendLogout(token) {
  try {
    const res = await Promise.race([
      fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'include',
        headers: token ? { 'Authorization': `Bearer ${token}` } : {},
      }),
      wait(8000).then(() => { throw new Error('timeout'); }),
    ]);
    return !!res && res.status < 500;
  } catch {
    return false;
  }
}

async function waitForUnloadedRefresh() {
  let started = NaN;
  try { started = Number(localStorage.getItem(REFRESH_MARK)); } catch { /* noop */ }
  const age = Date.now() - started;
  if (!Number.isFinite(age) || age < 0 || age >= REFRESH_MARK_TTL_MS) return;
  await new Promise((resolve) => setTimeout(resolve, Math.min(REFRESH_WAIT_MAX_MS, REFRESH_MARK_TTL_MS - age)));
}

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(null);
  const [loading, setLoading] = useState(true);
  // True while running on the profile kept for an offline start (offline mode,
  // utils/offlineMode.js): `user` is set but there is no token yet.
  const [offlineSession, setOfflineSession] = useState(false);
  // Whether the server says this device's session is a "remember me" one
  // (login / refresh responses). Only such a session may start offline.
  const sessionPersistentRef = useRef(false);
  // Bumped on logout: work still running for the old session (the offline
  // queue sending) checks it and stops, so it can't continue as someone else.
  const sessionGenRef = useRef(0);

  // Keep a ref to the latest token so apiFetch always reads the current value
  // without needing to be recreated on every token change
  const tokenRef = useRef(token);
  // The signed-in user's id for apiFetch's offline answers (the snapshot is
  // stored per account); kept in a ref so apiFetch stays a stable reference.
  const userIdRef = useRef(null);
  userIdRef.current = user ? String(user.id || user._id || '') || null : null;
  useEffect(() => { tokenRef.current = token; }, [token]);

  // ------------------------------------------------------------------
  // Token helpers — in-memory only (no localStorage/sessionStorage)
  // ------------------------------------------------------------------

  const storeToken = (newToken) => {
    setToken(newToken);
    tokenRef.current = newToken;
  };

  const clearToken = () => {
    // Clean up any legacy stored tokens from previous versions
    localStorage.removeItem('token');
    sessionStorage.removeItem('token');
    sessionStorage.removeItem('sessionOnly');
    setToken(null);
    tokenRef.current = null;
  };

  // ------------------------------------------------------------------
  // Shared session helper — stores token, sets user, applies language
  // ------------------------------------------------------------------

  const applySession = (token, userData) => {
    storeToken(token);
    setUser(userData);
    setOfflineSession(false); // a session applied from the server is a live one
    // An explicit account preference is honoured even for an incomplete
    // ("beta") language — the beta rule only governs automatic detection, never
    // a choice the user made. A code whose locale no longer exists (translation
    // withdrawn, or set from another install) is ignored rather than applied,
    // so the session falls back to English instead of a stale half-language.
    //
    // A `?lng=` preview outranks the stored preference: it is a choice made
    // just now, against one made months ago. Without this guard the detector
    // picks the preview at boot and this line reverts it a beat later, so the
    // page flashes the language and settles back — and since every screen worth
    // previewing (racks, bottle lists, a cellar) sits behind this login, the
    // preview TRANSLATING.md promises "on any page" would work only while
    // signed out, which is precisely backwards for a translator.
    if (hasLanguagePreview()) return;
    const preferred = userData?.preferences?.language;
    if (preferred && findLanguage(preferred)) {
      i18n.changeLanguage(preferred);
    }
  };

  // ------------------------------------------------------------------
  // Refresh: called automatically by apiFetch on 401
  // ------------------------------------------------------------------

  // Single-flight: the backend ROTATES the refresh token on every /refresh,
  // so two concurrent calls race — the first rotation invalidates the cookie
  // and the loser gets a 401, which apiFetch treats as "session dead" and
  // logs the user out. Parallel 401s (any page firing several requests after
  // the access token expires) must therefore share one in-flight refresh.
  const refreshInFlightRef = useRef(null);

  // The ref only guards THIS tab, but the refresh cookie is browser-wide and
  // the backend rotates ONE hash per browser session — two tabs refreshing at
  // once (typical after browser session-restore reopens several Cellarion
  // tabs) race the rotation and the loser is spuriously logged out. The Web
  // Locks API serializes across tabs of the same origin: the waiter re-runs
  // with the cookie its predecessor just rotated in, which is valid.
  // (Sessions are per DEVICE server-side since 2026-09-04, so signing in on
  // another device no longer invalidates this browser's cookie; the race
  // above is the only remaining way two refreshes can collide.)
  // How the last refresh ended: 'ok', 'rejected' (the server said no — the
  // session is dead), 'network' (no answer at all — the device is offline) or
  // 'unavailable' (the server answered but couldn't serve: a deploy, a 5xx,
  // a rate limit — see refreshOutcome). Only 'rejected' may end the session;
  // see onRefreshFailed below.
  const refreshOutcomeRef = useRef('ok');

  // A reload in the middle of a refresh used to sign the user out: the server
  // had already rotated the cookie, the page that asked was gone before the
  // response (and its new cookie) arrived, and the reloaded page presented
  // the rotated-away token — which the server answers with 401 and a cleared
  // cookie. Likely with offline mode (#1355): the app refreshes the moment the
  // signal returns, which is exactly when people pull to refresh. Two guards:
  //  - keepalive: the request outlives the page, so its cookie still lands;
  //  - a timestamp in localStorage while a refresh is in flight: a page that
  //    starts while one from a page that just unloaded may still be landing
  //    waits briefly for its cookie instead of racing it.
  const doRefresh = async () => {
    await waitForUnloadedRefresh();
    markRefreshInFlight(true);
    let res;
    try {
      res = await fetch('/api/auth/refresh', {
        method: 'POST',
        credentials: 'include', // sends the httpOnly refresh cookie
        keepalive: true,
      });
    } catch (err) {
      refreshOutcomeRef.current = 'network';
      throw err;
    } finally {
      markRefreshInFlight(false);
    }
    refreshOutcomeRef.current = refreshOutcome(res.status);
    if (!res.ok) return null;
    const data = await res.json();
    sessionPersistentRef.current = data.persistent === true;
    storeToken(data.token);
    return data.token;
  };

  const handleRefresh = useCallback(() => {
    if (refreshInFlightRef.current) return refreshInFlightRef.current;
    refreshInFlightRef.current = (async () => {
      try {
        if (navigator.locks?.request) {
          return await navigator.locks.request('cellarion-token-refresh', doRefresh);
        }
        return await doRefresh(); // pre-Web-Locks browsers: per-tab guard only
      } catch {
        return null;
      } finally {
        refreshInFlightRef.current = null;
      }
    })();
    return refreshInFlightRef.current;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ------------------------------------------------------------------
  // apiFetch — stable reference, used by all components instead of fetch
  // ------------------------------------------------------------------

  // keepQueue: an automatic sign-out (the session ended) keeps the user's
  // unsent offline changes, so they still go out once the same user signs
  // back in. A user-initiated logout deletes everything (Layout confirms first
  // when changes are waiting).
  const logout = useCallback(async ({ keepQueue = false } = {}) => {
    // Tell the server to end this device's session and clear its cookie. With
    // no network (offline mode) that can't happen now — remember it, and the
    // next start finishes it before anything else (restoreSession).
    const ended = await sendLogout(tokenRef.current);
    markPendingLogout(!ended);
    sessionGenRef.current += 1; // anything still running for this session stops (offline queue)
    // Wipe per-tab user state so chat history etc. don't bleed across logins.
    // Only sessionStorage — localStorage holds theme / language / persisted token.
    try { sessionStorage.clear(); } catch { /* noop */ }
    // …and the service worker's cached API responses (cellars, bottles, wines),
    // and the profile kept for an offline start.
    await clearApiCaches();
    clearOfflineUser();
    await clearOfflineData({ keepQueue }); // the saved cellar copy, its photos, queued changes
    clearToken();
    setOfflineSession(false);
    setUser(null);
  }, []);

  // A refresh that got NO answer (offline, a dead zone in the cellar) or one
  // the server couldn't serve (a deploy, a hiccup) is not a dead session:
  // logging out there would throw the user out — and wipe their offline data —
  // every time the signal drops or the server restarts. Only a real rejection
  // logs out; the caller's request fails and the next one tries again.
  const onRefreshFailed = useCallback(() => {
    if (refreshOutcomeRef.current !== 'rejected') return;
    logout({ keepQueue: true });
  }, [logout]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const apiFetch = useCallback(
    createApiFetch(() => tokenRef.current, handleRefresh, onRefreshFailed, {
      // Offline mode: reads the network can't answer come from the device's copy.
      offlineFallback: (url) => offlineAnswer(url, userIdRef.current),
      // …and writes it can't take are queued on the device (offline mode).
      offlineWriteKey: (url, method) => writeKeyFor(url, method, userIdRef.current),
      offlineWrite: (url, init, key) => queueWrite({ url, method: init.method, body: init.body, key, userId: userIdRef.current }),
      onLive: markLive,
      onMutation: notifyApiMutation,
    }),
    [] // stable: getToken via ref, callbacks are stable via useCallback
  );

  // ------------------------------------------------------------------
  // On mount: restore session from localStorage
  // ------------------------------------------------------------------

  useEffect(() => {
    // Migrate: clear any legacy stored tokens from previous versions
    localStorage.removeItem('token');
    sessionStorage.removeItem('token');
    sessionStorage.removeItem('sessionOnly');

    // On mount, attempt to restore session via httpOnly refresh cookie
    const restoreSession = async () => {
      // A logout that could not reach the server finishes first — otherwise
      // the refresh below would sign that account straight back in.
      if (hasPendingLogout()) {
        const ended = await sendLogout(null);
        if (!ended) { setLoading(false); return; } // still offline: stay signed out
        markPendingLogout(false);
      }

      const kept = loadOfflineUser(); // null unless offline mode + a recent "remember me" session
      const goOffline = () => {
        setOfflineSession(true);
        setUser(kept);
        setLoading(false);
      };
      const refresh = handleRefresh();
      // One bar of signal hangs rather than fails: with an offline profile,
      // don't wait for it — start offline; the refresh carries on and the
      // reconnect effect picks the session up when it lands.
      let newToken = kept
        ? await Promise.race([refresh, wait(START_WAIT_MS).then(() => TIMED_OUT)])
        : await refresh;
      if (newToken === TIMED_OUT) {
        refresh.then((tok) => { if (tok) window.dispatchEvent(new Event('online')); });
        goOffline();
        return;
      }
      // The server answered but couldn't serve (a deploy restarting it): with
      // no device copy to open instead, give it a few seconds before showing
      // the login page.
      if (!newToken && !kept && refreshOutcomeRef.current === 'unavailable') {
        for (const delay of START_RETRY_DELAYS_MS) {
          await wait(delay);
          newToken = await handleRefresh();
          if (newToken || refreshOutcomeRef.current !== 'unavailable') break;
        }
      }
      if (newToken) {
        const profile = fetchUserProfile(newToken);
        if (kept && (await Promise.race([profile.then(() => true), wait(START_WAIT_MS).then(() => TIMED_OUT)])) === TIMED_OUT) {
          goOffline(); // the profile call applies the session when it lands
        }
        return;
      }
      if (refreshOutcomeRef.current === 'rejected') {
        // The server ended this session (signed out elsewhere, expired,
        // account deleted): nothing of it may stay on this device.
        clearOfflineUser();
        await clearOfflineData({ keepQueue: true });
      } else if (kept) {
        // Offline start — no network, or a server that can't answer right
        // now: carry on as the last signed-in user, with no token, until it
        // answers again (reconnect effect below).
        goOffline();
        return;
      }
      setLoading(false);
    };
    restoreSession();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchUserProfile = async (authToken) => {
    try {
      const getMe = () => fetch('/api/auth/me', {
        headers: { 'Authorization': `Bearer ${authToken}` },
        credentials: 'include'
      });
      let response = await getMe();
      // The token is fresh: a server that can't answer right now (a deploy
      // mid-restart) gets the same few seconds as the refresh does.
      for (const delay of START_RETRY_DELAYS_MS) {
        if (!transientStatus(response.status)) break;
        await wait(delay);
        response = await getMe();
      }

      if (response.ok) {
        const data = await response.json();
        applySession(authToken, data.user);
      } else if (response.status === 401) {
        // Access token may have expired — try refresh before giving up
        const newToken = await handleRefresh();
        if (newToken) {
          const retry = await fetch('/api/auth/me', {
            headers: { 'Authorization': `Bearer ${newToken}` },
            credentials: 'include'
          });
          if (retry.ok) {
            const data = await retry.json();
            applySession(newToken, data.user);
            return;
          }
        }
        clearToken();
        setUser(null);
      } else {
        clearToken();
        setUser(null);
      }
    } catch (error) {
      console.error('Failed to fetch user profile:', error);
      clearToken();
      setUser(null);
    } finally {
      setLoading(false);
    }
  };

  // ------------------------------------------------------------------
  // Offline mode: keep the profile for an offline start, and leave the
  // offline session as soon as the server answers again
  // ------------------------------------------------------------------

  useEffect(() => {
    // No-op unless offline mode is on; a non-"remember me" session is not kept.
    if (user && !offlineSession) saveOfflineUser(user, { persistent: sessionPersistentRef.current });
  }, [user, offlineSession]);

  useEffect(() => {
    if (!offlineSession) return undefined;
    let cancelled = false;
    const reconnect = async () => {
      const newToken = await handleRefresh();
      if (cancelled) return;
      if (!newToken) {
        // Still no network: stay. The server rejected the session: end it.
        if (refreshOutcomeRef.current === 'rejected') logout({ keepQueue: true });
        return;
      }
      let res = null;
      try {
        res = await fetch('/api/auth/me', {
          headers: { 'Authorization': `Bearer ${newToken}` },
          credentials: 'include'
        });
      } catch { /* dropped again — the next attempt retries */ }
      if (cancelled || !res) return;
      if (res.ok) {
        const data = await res.json();
        if (cancelled) return;
        applySession(newToken, data.user);
        setOfflineSession(false);
      } else if (res.status === 401 || res.status === 404) {
        logout({ keepQueue: true });
      }
    };
    const onVisible = () => { if (document.visibilityState === 'visible') reconnect(); };
    window.addEventListener('online', reconnect);
    document.addEventListener('visibilitychange', onVisible);
    const timer = setInterval(reconnect, 30000);
    return () => {
      cancelled = true;
      window.removeEventListener('online', reconnect);
      document.removeEventListener('visibilitychange', onVisible);
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offlineSession]);

  // ------------------------------------------------------------------
  // register / login
  // ------------------------------------------------------------------

  const register = async (username, email, password, consentAccepted = false) => {
    try {
      const response = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          username, email, password,
          consentPrivacyPolicy: consentAccepted,
          consentDataProcessing: consentAccepted
        })
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Registration failed');

      if (data.token) {
        // Verification disabled — logged in immediately
        applySession(data.token, data.user);
        return { success: true };
      }

      // Verification enabled — user must confirm email before logging in
      return { success: true, email: data.email, requiresVerification: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  };

  const login = async (username, password, rememberMe = true) => {
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ username, password, rememberMe })
      });

      const data = await response.json();
      if (!response.ok) {
        const err = new Error(data.error || 'Login failed');
        err.code = data.code;
        err.email = data.email;
        throw err;
      }

      sessionPersistentRef.current = data.persistent === true;
      applySession(data.token, data.user);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message, code: error.code, email: error.email };
    }
  };

  // Start an ephemeral demo session — no signup. The backend creates a throwaway,
  // auto-expiring account with a populated (cloned) cellar and returns the same
  // { token, user } shape as login; user.isDemo drives the persistent banner and
  // hides restricted actions app-wide with no further plumbing.
  const demoLogin = async () => {
    try {
      const response = await fetch('/api/auth/demo-login', {
        method: 'POST',
        credentials: 'include'
      });
      // Parse defensively: a non-JSON proxy body (502/504 HTML during a deploy)
      // must not throw a raw SyntaxError that ends up rendered on the public
      // landing page. `serverIssued` tells the caller whether the backend
      // actually sent a message (surface it) or this was a transport/proxy
      // failure (use generic localized copy).
      let data = null;
      try { data = await response.json(); } catch { /* non-JSON body */ }
      if (!response.ok) {
        return { success: false, error: data?.error, code: data?.code, serverIssued: !!data?.error };
      }
      applySession(data.token, data.user);
      return { success: true };
    } catch {
      // Transport failure — fetch rejected; no server-issued message.
      return { success: false, error: null, serverIssued: false };
    }
  };

  const verifyEmail = async (token) => {
    try {
      // POST the token (security audit M-1): the endpoint verifies the email
      // and issues NO session, so the user logs in normally afterward — this
      // removes the old GET's login-CSRF/session-fixation and prefetch-burn.
      const response = await fetch('/api/auth/verify-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Verification failed');
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  };

  // Only GET /api/auth/me stamps isSuperAdmin (it checks the request's address
  // as well as the email); the other endpoints that echo the user don't. Keep
  // the stamp when one of those replaces the user, or the SuperAdmin link and
  // page would vanish after every preference save until the next reload.
  const replaceUser = (next) => setUser((prev) => (
    prev?.isSuperAdmin !== undefined && next?.isSuperAdmin === undefined
      ? { ...next, isSuperAdmin: prev.isSuperAdmin }
      : next
  ));

  // ------------------------------------------------------------------
  // updatePreferences (uses apiFetch for auto-refresh)
  // ------------------------------------------------------------------

  const updatePreferences = async (prefs) => {
    try {
      const response = await apiFetch('/api/users/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(prefs)
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to update preferences');
      replaceUser(data.user);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  };

  // ------------------------------------------------------------------
  // acceptPolicy — record re-consent after a privacy-policy version bump
  // ------------------------------------------------------------------

  const acceptPolicy = async () => {
    try {
      const response = await apiFetch('/api/users/me/accept-policy', { method: 'POST' });
      let data = null;
      try { data = await response.json(); } catch { /* non-JSON body (e.g. proxy 502) */ }
      if (!response.ok) {
        throw new Error((data && data.error) || "Couldn't save your acknowledgement. Please try again.");
      }
      // Refreshed user has requiresPolicyReconsent === false → modal unmounts.
      if (data?.user) replaceUser(data.user);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  };

  const value = {
    user,
    token,
    loading,
    offlineSession,
    // A number that changes when the session ends (logout) — long-running work
    // compares it to stop acting for a session that is gone.
    getSessionGeneration: () => sessionGenRef.current,
    register,
    login,
    demoLogin,
    logout,
    verifyEmail,
    updatePreferences,
    acceptPolicy,
    apiFetch,
    setUser
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};
