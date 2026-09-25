import { useEffect, useRef, useState } from 'react';

/**
 * One collapsible group on the Settings page (Account, Preferences, AI &
 * connections, Your data, Delete account): a heading with a one-line summary of
 * what is inside, the cards below. Built on <details>, so it is keyboard- and
 * screen-reader-accessible with no library.
 *
 * - Which groups are open is remembered per browser (a convenience only).
 * - A link to /settings#<id> — or to one of the aliases below, e.g.
 *   #notifications, #mcp, #api-tokens — opens that group and scrolls to it.
 */
const STORE_KEY = 'cellarion-settings-open';

// Hash → group id: links name what they are about, not how the page is grouped.
export const SETTINGS_HASH_GROUP = {
  account: 'account', profile: 'account', password: 'account', supporter: 'account',
  preferences: 'preferences', display: 'preferences', notifications: 'preferences', offline: 'preferences',
  connections: 'connections', ai: 'connections', mcp: 'connections', 'api-tokens': 'connections',
  bridge: 'connections', climate: 'connections',
  data: 'data', export: 'data', portability: 'data',
  danger: 'danger', 'delete-account': 'danger',
};

function hashGroup() {
  try {
    const h = decodeURIComponent((window.location.hash || '').slice(1)).toLowerCase();
    return SETTINGS_HASH_GROUP[h] || null;
  } catch {
    return null;
  }
}

function readStored() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {}; } catch { return {}; }
}

function store(id, open) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify({ ...readStored(), [id]: open })); } catch { /* noop */ }
}

export default function SettingsGroup({ id, title, summary, defaultOpen = false, forceOpen = false, danger = false, children }) {
  const ref = useRef(null);
  const [open, setOpen] = useState(() => {
    if (forceOpen || hashGroup() === id) return true;
    const stored = readStored()[id];
    return typeof stored === 'boolean' ? stored : defaultOpen;
  });

  // Something needs attention inside (e.g. an account deletion is scheduled).
  useEffect(() => { if (forceOpen) setOpen(true); }, [forceOpen]);

  // /settings#notifications etc.: open this group and bring it into view.
  useEffect(() => {
    const go = () => {
      if (hashGroup() !== id) return;
      setOpen(true);
      requestAnimationFrame(() => {
        const el = ref.current;
        if (!el) return;
        // Clear the sticky top bar, whose height varies (the admin menu wraps
        // onto several rows), so the group's heading is never hidden under it.
        const bar = document.querySelector('.navbar');
        const barBottom = bar && getComputedStyle(bar).position === 'sticky' ? bar.getBoundingClientRect().bottom : 0;
        if (typeof window.scrollTo === 'function' && barBottom > 0) {
          window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - barBottom - 12, behavior: 'smooth' });
        } else {
          el.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
        }
      });
    };
    go();
    window.addEventListener('hashchange', go);
    return () => window.removeEventListener('hashchange', go);
  }, [id]);

  return (
    <section id={id} ref={ref} className={`settings-group${danger ? ' settings-group--danger' : ''}`}>
      <details
        open={open}
        onToggle={(e) => {
          const now = e.currentTarget.open;
          if (now !== open) { setOpen(now); store(id, now); }
        }}
      >
        <summary className="settings-group-summary">
          <span className="settings-group-heading">
            <span className="settings-group-title">{title}</span>
            {summary && <span className="settings-group-desc">{summary}</span>}
          </span>
          <span className="settings-group-chevron" aria-hidden="true" />
        </summary>
        <div className="settings-group-body">{children}</div>
      </details>
    </section>
  );
}
