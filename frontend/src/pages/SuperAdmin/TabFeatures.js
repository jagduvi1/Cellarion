import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { superadminGetFeatures, superadminSaveFeature } from '../../api/admin';

const INPUT_STYLE = {
  background: 'var(--sa-bg)',
  border: '1px solid var(--sa-border)',
  color: 'var(--sa-text)',
  padding: '2px 6px',
  borderRadius: 3,
  fontSize: 12,
};

const STATES = [
  { value: 'off', label: 'Off — nobody' },
  { value: 'beta', label: 'Beta — early-access members' },
  { value: 'everyone', label: 'Everyone' },
];

const day = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—');

/**
 * SuperAdmin → Feature flags (backend config/featureFlags): every flagged
 * feature with its state, which can move between off / beta / everyone
 * without a deploy, the forum thread its testers are pointed to, and the
 * beta feedback that came in. Entering beta notifies the early-access members
 * and going out to everyone thanks whoever sent feedback — once each.
 */
export default function TabFeatures() {
  const { apiFetch } = useAuth();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [forum, setForum] = useState({});
  const [busy, setBusy] = useState(null);
  const [msg, setMsg] = useState(null);

  const load = useCallback(() => {
    superadminGetFeatures(apiFetch)
      .then(r => r.json())
      .then(d => {
        setData(d);
        setForum(Object.fromEntries((d.features || []).map(f => [f.key, f.forumPath || ''])));
      })
      .catch(() => setError('Failed to load feature flags'));
  }, [apiFetch]);

  useEffect(() => { load(); }, [load]);

  const save = async (key, patch, label) => {
    setBusy(key); setMsg(null);
    try {
      const res = await superadminSaveFeature(apiFetch, key, patch);
      const d = await res.json();
      if (!res.ok) {
        setMsg({ ok: false, text: d.error || 'Save failed' });
      } else {
        const sent = [];
        if (d.notified?.announced) sent.push(`announced to ${d.notified.announced} early-access member${d.notified.announced === 1 ? '' : 's'}`);
        if (d.notified?.thanked) sent.push(`thanked ${d.notified.thanked} feedback sender${d.notified.thanked === 1 ? '' : 's'}`);
        setMsg({ ok: true, text: `Saved — ${label}${sent.length ? ` (${sent.join(', ')})` : ''}` });
        load();
      }
    } catch { setMsg({ ok: false, text: 'Network error' }); }
    finally { setBusy(null); }
  };

  if (error) return <div className="sa-panel" style={{ marginTop: 16, padding: 12, color: 'var(--sa-danger)' }}>{error}</div>;
  if (!data) return <div className="sa-loading">Loading feature flags...</div>;

  return (
    <div className="sa-panel" style={{ marginTop: 16 }}>
      <div className="sa-panel-header">
        <span className="sa-panel-title">Feature flags · early access</span>
        <span style={{ fontSize: 11, color: 'var(--sa-text-dim)' }}>
          {data.optedIn} member{data.optedIn === 1 ? '' : 's'} try new features early
        </span>
      </div>
      <div className="sa-panel-body">
        <div style={{ fontSize: 11, color: 'var(--sa-text-dim)', marginBottom: 12 }}>
          A flagged feature is <strong>off</strong> (nobody sees it — unfinished work can ship dark),
          in <strong>beta</strong> (members who turned on “Try new features early” in Settings) or
          out for <strong>everyone</strong>. Changes apply without a deploy; browsers pick them up within a minute.
          Moving a feature into beta notifies the early-access members, and releasing it to everyone thanks
          whoever sent beta feedback on it — each only once. Remove a released flag from the code in a later cleanup.
        </div>
        {(data.features || []).map(f => (
          <div key={f.key} className="sa-kv" style={{ marginBottom: 14 }}>
            <div className="sa-kv-row">
              <span className="sa-kv-key">{f.title}</span>
              <code style={{ fontSize: 11, color: 'var(--sa-text-dim)' }}>{f.key}</code>
            </div>
            <div className="sa-kv-row">
              <span className="sa-kv-key">State</span>
              <select
                aria-label={`State of ${f.title}`}
                value={f.state}
                disabled={busy === f.key}
                onChange={e => save(f.key, { state: e.target.value }, `${f.title} is now ${e.target.value}`)}
                style={INPUT_STYLE}
              >
                {STATES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </div>
            <div className="sa-kv-row">
              <span className="sa-kv-key">Dates</span>
              <span style={{ fontSize: 11 }}>In beta since {day(f.betaAt)} · released {day(f.releasedAt)}</span>
            </div>
            <div className="sa-kv-row">
              <span className="sa-kv-key">Beta feedback</span>
              <span style={{ fontSize: 11 }}>
                {f.feedback?.total || 0} ticket{f.feedback?.total === 1 ? '' : 's'} · {f.feedback?.open || 0} not closed ·{' '}
                <Link to={`/admin/support?category=beta&feature=${encodeURIComponent(f.key)}`}>open in the support queue</Link>
              </span>
            </div>
            <div className="sa-kv-row">
              <span className="sa-kv-key">Forum thread</span>
              <span style={{ display: 'flex', gap: 6, alignItems: 'center', flex: 1 }}>
                <input
                  type="text"
                  aria-label={`Forum thread for ${f.title}`}
                  value={forum[f.key] ?? ''}
                  onChange={e => setForum(m => ({ ...m, [f.key]: e.target.value }))}
                  placeholder="/community/discussions/… or a full link to it"
                  style={{ ...INPUT_STYLE, flex: 1, minWidth: 0 }}
                />
                <button
                  className="sa-btn"
                  disabled={busy === f.key || (forum[f.key] ?? '') === (f.forumPath || '')}
                  onClick={() => save(f.key, { forumPath: forum[f.key] ?? '' }, 'forum thread updated')}
                >Save link</button>
              </span>
            </div>
          </div>
        ))}
        {msg && (
          <div style={{ marginTop: 10, fontSize: 11, color: msg.ok ? 'var(--sa-accent)' : 'var(--sa-danger)' }}>{msg.text}</div>
        )}
      </div>
    </div>
  );
}
