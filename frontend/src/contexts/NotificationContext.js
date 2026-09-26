import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from './AuthContext';

const NotificationContext = createContext(null);

// How often a visible tab asks whether anything changed. Returning to the tab
// asks at once (see the wake handler), so this only matters to someone who
// keeps looking at the same page.
export const POLL_MS = 3 * 60 * 1000;
// Checks closer together than this are skipped. Every switch back to the
// browser window fires focus, and someone flicking between windows would
// otherwise ask on each one.
export const MIN_CHECK_GAP_MS = 60 * 1000;

export function useNotifications() {
  return useContext(NotificationContext);
}

export function NotificationProvider({ children }) {
  const { user, apiFetch } = useAuth();
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  // What the list on screen was built from. A probe that answers differently
  // means the list is out of date.
  const shownRef = useRef({ unreadCount: 0, newestId: null });
  const lastCheckRef = useRef(0);

  const fetchNotifications = useCallback(async () => {
    if (!user) return;
    lastCheckRef.current = Date.now();
    try {
      const res = await apiFetch('/api/notifications');
      if (res.ok) {
        const data = await res.json();
        setNotifications(data.notifications);
        setUnreadCount(data.unreadCount);
        shownRef.current = { unreadCount: data.unreadCount, newestId: data.notifications[0]?._id ?? null };
      }
    } catch {
      // Silently ignore — network blip should not break the UI
    }
  }, [user, apiFetch]);

  // The probe: the unread count and the newest notification's id instead of
  // the whole list, which is fetched only when either differs from what is
  // shown. The id catches what the count alone can't: one read on another
  // device while a new one arrives leaves the count equal. Hidden tabs never
  // ask. A server that doesn't send newestId yet (mid-deploy) reads as
  // "changed", so the list is refetched rather than left stale.
  const checkForChanges = useCallback(async () => {
    if (!user || document.hidden) return;
    if (Date.now() - lastCheckRef.current < MIN_CHECK_GAP_MS) return;
    lastCheckRef.current = Date.now();
    try {
      const res = await apiFetch('/api/notifications/unread-count');
      if (res.ok) {
        const data = await res.json();
        setUnreadCount(data.unreadCount);
        const shown = shownRef.current;
        if (data.unreadCount !== shown.unreadCount || (data.newestId ?? null) !== shown.newestId) {
          fetchNotifications();
        }
      }
    } catch {
      // ignore
    }
  }, [user, apiFetch, fetchNotifications]);

  const markRead = useCallback(async (id) => {
    try {
      const res = await apiFetch(`/api/notifications/${id}/read`, { method: 'PUT' });
      if (res.ok) {
        setNotifications(prev =>
          prev.map(n => n._id === id ? { ...n, read: true } : n)
        );
        setUnreadCount(prev => Math.max(0, prev - 1));
        const shown = shownRef.current;
        shownRef.current = { ...shown, unreadCount: Math.max(0, shown.unreadCount - 1) };
      }
    } catch {
      // ignore
    }
  }, [apiFetch]);

  const markAllRead = useCallback(async () => {
    try {
      const res = await apiFetch('/api/notifications/read-all', { method: 'PUT' });
      if (res.ok) {
        setNotifications(prev => prev.map(n => ({ ...n, read: true })));
        setUnreadCount(0);
        shownRef.current = { ...shownRef.current, unreadCount: 0 };
      }
    } catch {
      // ignore
    }
  }, [apiFetch]);

  // Start/stop polling based on login state
  useEffect(() => {
    if (!user) {
      setNotifications([]);
      setUnreadCount(0);
      shownRef.current = { unreadCount: 0, newestId: null };
      return undefined;
    }

    fetchNotifications();
    const timer = setInterval(checkForChanges, POLL_MS);

    // Returning to the tab is when a stale list is most likely, so check at
    // once, with the probe rather than the whole list. Returning fires BOTH
    // visibilitychange and focus, so debounce to coalesce that burst into a
    // single check.
    let wakeTimer = null;
    const handleWake = () => {
      if (document.hidden) return;
      clearTimeout(wakeTimer);
      wakeTimer = setTimeout(checkForChanges, 250);
    };
    window.addEventListener('focus', handleWake);
    document.addEventListener('visibilitychange', handleWake);

    return () => {
      clearInterval(timer);
      clearTimeout(wakeTimer);
      window.removeEventListener('focus', handleWake);
      document.removeEventListener('visibilitychange', handleWake);
    };
  }, [user, fetchNotifications, checkForChanges]);

  return (
    <NotificationContext.Provider value={{ notifications, unreadCount, markRead, markAllRead, refresh: fetchNotifications }}>
      {children}
    </NotificationContext.Provider>
  );
}
