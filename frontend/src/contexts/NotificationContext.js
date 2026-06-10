import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from './AuthContext';

const NotificationContext = createContext(null);

export function useNotifications() {
  return useContext(NotificationContext);
}

export function NotificationProvider({ children }) {
  const { user, apiFetch } = useAuth();
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const intervalRef = useRef(null);
  const lastCountRef = useRef(0);

  const fetchNotifications = useCallback(async () => {
    if (!user) return;
    try {
      const res = await apiFetch('/api/notifications');
      if (res.ok) {
        const data = await res.json();
        setNotifications(data.notifications);
        setUnreadCount(data.unreadCount);
        lastCountRef.current = data.unreadCount;
      }
    } catch {
      // Silently ignore — network blip should not break the UI
    }
  }, [user, apiFetch]);

  // Lightweight poll: one indexed count instead of the full list. Only when
  // the count changes do we refetch the list — and hidden tabs skip entirely,
  // so N open tabs no longer multiply into N full fetches every 30s.
  const pollUnreadCount = useCallback(async () => {
    if (!user || document.hidden) return;
    try {
      const res = await apiFetch('/api/notifications/unread-count');
      if (res.ok) {
        const data = await res.json();
        setUnreadCount(data.unreadCount);
        if (data.unreadCount !== lastCountRef.current) {
          lastCountRef.current = data.unreadCount;
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
        lastCountRef.current = Math.max(0, lastCountRef.current - 1);
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
        lastCountRef.current = 0;
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
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }

    fetchNotifications();
    intervalRef.current = setInterval(pollUnreadCount, 60_000);

    // Catch up when the tab becomes active again — the interval skips
    // while document.hidden, so this is the "resume" signal.
    const handleWake = () => pollUnreadCount();
    window.addEventListener('focus', handleWake);
    document.addEventListener('visibilitychange', handleWake);

    return () => {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
      window.removeEventListener('focus', handleWake);
      document.removeEventListener('visibilitychange', handleWake);
    };
  }, [user, fetchNotifications, pollUnreadCount]);

  return (
    <NotificationContext.Provider value={{ notifications, unreadCount, markRead, markAllRead, refresh: fetchNotifications }}>
      {children}
    </NotificationContext.Provider>
  );
}
