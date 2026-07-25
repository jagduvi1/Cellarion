import React, { createContext, useState, useContext, useEffect, useRef, useCallback } from 'react';
import { LOCALE_CODES } from 'virtual:locale-coverage';
import { createApiFetch } from '../utils/apiFetch';
import i18n from '../i18n';

const AuthContext = createContext();

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

  // Keep a ref to the latest token so apiFetch always reads the current value
  // without needing to be recreated on every token change
  const tokenRef = useRef(token);
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
    // An explicit account preference is honoured even for an incomplete
    // ("beta") language — the beta rule only governs automatic detection, never
    // a choice the user made. A code whose locale no longer exists (translation
    // withdrawn, or set from another install) is ignored rather than applied,
    // so the session falls back to English instead of a stale half-language.
    const preferred = userData?.preferences?.language;
    if (preferred && LOCALE_CODES.includes(String(preferred).split('-')[0])) {
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
  // the backend stores a single rotating token hash — two tabs refreshing at
  // once (typical after browser session-restore reopens several Cellarion
  // tabs) race the rotation and the loser is spuriously logged out. The Web
  // Locks API serializes across tabs of the same origin: the waiter re-runs
  // with the cookie its predecessor just rotated in, which is valid.
  const doRefresh = async () => {
    const res = await fetch('/api/auth/refresh', {
      method: 'POST',
      credentials: 'include' // sends the httpOnly refresh cookie
    });
    if (!res.ok) return null;
    const data = await res.json();
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

  const logout = useCallback(async () => {
    try {
      // Tell the server to clear the refresh token hash + cookie
      await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'include',
        headers: tokenRef.current
          ? { 'Authorization': `Bearer ${tokenRef.current}` }
          : {}
      });
    } catch {
      // Best-effort; clear client state regardless
    }
    // Wipe per-tab user state so chat history etc. don't bleed across logins.
    // Only sessionStorage — localStorage holds theme / language / persisted token.
    try { sessionStorage.clear(); } catch { /* noop */ }
    clearToken();
    setUser(null);
  }, []);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const apiFetch = useCallback(
    createApiFetch(() => tokenRef.current, handleRefresh, logout),
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
      const newToken = await handleRefresh();
      if (newToken) {
        await fetchUserProfile(newToken);
      } else {
        setLoading(false);
      }
    };
    restoreSession();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchUserProfile = async (authToken) => {
    try {
      const response = await fetch('/api/auth/me', {
        headers: { 'Authorization': `Bearer ${authToken}` },
        credentials: 'include'
      });

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
      setUser(data.user);
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
      if (data?.user) setUser(data.user);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  };

  const value = {
    user,
    token,
    loading,
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
