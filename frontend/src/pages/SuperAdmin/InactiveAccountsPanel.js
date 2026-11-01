import { useState, useEffect } from 'react';
import { adminGetInactiveAccounts, adminSaveInactiveAccounts } from '../../api/admin';

// Deleting accounts nobody uses (backend services/inactiveAccounts): the rule
// the Privacy Policy states, off until turned on here. Before turning it on,
// "What it would do today" shows the effect; turning it on restarts every
// timeline, so nobody gets less than the full 30 days' notice.
export default function InactiveAccountsPanel({ apiFetch }) {
  const [state, setState] = useState(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);

  useEffect(() => {
    adminGetInactiveAccounts(apiFetch)
      .then(async (r) => {
        // An error page (a proxy's 502) is not JSON: say it failed, not why it would not parse.
        const d = await r.json().catch(() => ({}));
        // An error body is not a state: no switch is shown for it.
        if (!r.ok) throw new Error(d?.error || 'Failed to load');
        setState(d);
      })
      .catch((err) => setMsg({ ok: false, text: err?.message || 'Failed to load' }));
  }, [apiFetch]);

  const toggle = async () => {
    setSaving(true);
    setMsg(null);
    try {
      const res = await adminSaveInactiveAccounts(apiFetch, !state.enabled);
      const d = await res.json();
      if (!res.ok) {
        setMsg({ ok: false, text: d.error || 'Save failed' });
      } else {
        setState(prev => ({ ...prev, ...d }));
        setMsg({ ok: true, text: d.enabled ? 'Turned on' : 'Turned off' });
      }
    } catch {
      setMsg({ ok: false, text: 'Network error' });
    } finally {
      setSaving(false);
    }
  };

  const rule = state?.rule;
  const today = state?.today || {};
  const last = state?.last30Days || {};

  return (
    <div className="sa-panel" style={{ marginTop: 16 }}>
      <div className="sa-panel-header">
        <span className="sa-panel-title">Inactive accounts</span>
        {state && (
          <button className="sa-btn" onClick={toggle} disabled={saving}>
            {saving ? 'Saving...' : state.enabled ? 'Turn off' : 'Turn on'}
          </button>
        )}
      </div>
      <div className="sa-panel-body">
        {rule && (
          <div style={{ fontSize: 11, color: 'var(--sa-text-dim)', marginBottom: 12 }}>
            Accounts nobody has used for {rule.monthsWithContent} months ({rule.monthsEmpty} months when they never
            held a bottle, a wishlist entry or a journal entry) get an email {rule.firstNoticeDays} days and
            again {rule.finalNoticeDays} days before they are deleted. Signing in once keeps the account. Never
            deleted: paying supporters, staff, demo accounts, and the owner of a shared cellar a member still
            uses. A notice that fails to send is retried the next day, and nothing is deleted on a day a notice
            failed. Runs daily at 09:13 UTC. Turning it on restarts every timeline.
          </div>
        )}
        {state && (
          <div className="sa-kv">
            <div className="sa-kv-row">
              <span className="sa-kv-key">Status</span>
              <span>{state.enabled
                ? `On since ${new Date(state.since).toLocaleString()}`
                : 'Off'}</span>
            </div>
            {state.trackedSince && (
              <div className="sa-kv-row">
                <span className="sa-kv-key">Use recorded since</span>
                <span>
                  {new Date(state.trackedSince).toLocaleDateString()}: nobody counts as unused from earlier, so no
                  account can be deleted before {new Date(state.earliestDeletion).toLocaleDateString()}
                </span>
              </div>
            )}
            <div className="sa-kv-row">
              <span className="sa-kv-key">What it would do today</span>
              <span>
                {today.first ?? 0} first notices · {today.final ?? 0} final notices · {today.delete ?? 0} deletions
                {' '}({today.exempt ?? 0} exempt · {state.onTimeline ?? 0} accounts on a timeline in all)
              </span>
            </div>
            <div className="sa-kv-row">
              <span className="sa-kv-key">Last 30 days</span>
              <span>{last.firstNotices ?? 0} first notices · {last.finalNotices ?? 0} final notices · {last.deleted ?? 0} deleted</span>
            </div>
            {!state.mailConfigured && (
              <div className="sa-kv-row">
                <span className="sa-kv-key">Mail</span>
                <span style={{ color: 'var(--sa-red)' }}>Not configured: nothing runs, because nobody may be deleted without notice</span>
              </div>
            )}
          </div>
        )}
        {msg && <div style={{ marginTop: 8, fontSize: 11, color: msg.ok ? 'var(--sa-green)' : 'var(--sa-red)' }}>{msg.text}</div>}
      </div>
    </div>
  );
}
