import React, { createContext, useState, useContext, useEffect, useRef, useCallback } from 'react';
import { getPlanConfig } from '../config/plans';
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

/**
 * Convenience hook that returns plan-related helpers for the current user.
 * Must be used inside an AuthProvider.
 */
export const usePlan = () => {
  const { user } = useAuth();
  const plan = user?.plan || 'free';
  const config = getPlanConfig(plan);
  return { plan, config };
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
    if (userData?.preferences?.language) {
      i18n.changeLanguage(userData.preferences.language);
    }
  };

  // ------------------------------------------------------------------
  // Refresh: called automatically by apiFetch on 401
  // ------------------------------------------------------------------

  const handleRefresh = useCallback(async () => {
    try {
      const res = await fetch('/api/auth/refresh', {
        method: 'POST',
        credentials: 'include' // sends the httpOnly refresh cookie
      });
      if (!res.ok) return null;
      const data = await res.json();
      storeToken(data.token);
      return data.token;
    } catch {
      return null;
    }
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

  const verifyEmail = async (token) => {
    try {
      const response = await fetch(`/api/auth/verify-email?token=${encodeURIComponent(token)}`, {
        credentials: 'include'
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Verification failed');

      applySession(data.token, data.user);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  };

  // ------------------------------------------------------------------
  // updatePreferences (uses apiFetch for auto-refresh)
  // ------------------------------------------------------------------

  const startTrial = async () => {
    try {
      const response = await apiFetch('/api/users/trial', { method: 'POST' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to start trial');
      setUser(data.user);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  };

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

  const value = {
    user,
    token,
    loading,
    register,
    login,
    logout,
    verifyEmail,
    updatePreferences,
    startTrial,
    apiFetch,
    setUser
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};
