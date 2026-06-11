import { useState, useEffect } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { superadminGetAnnouncement, superadminSaveAnnouncement } from '../../api/admin';

const TEXTAREA_STYLE = {
  width: '100%',
  minHeight: 70,
  background: 'var(--sa-bg)',
  border: '1px solid var(--sa-border)',
  color: 'var(--sa-text)',
  padding: '6px 8px',
  borderRadius: 3,
  fontFamily: 'inherit',
  fontSize: 12,
  boxSizing: 'border-box',
  resize: 'vertical',
};

export default function TabAnnouncement() {
  const { apiFetch } = useAuth();
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    superadminGetAnnouncement(apiFetch)
      .then(r => r.json())
      .then(d => setForm({
        enabled: d.config.enabled,
        message: d.config.message || '',
        messageSv: d.config.messageSv || '',
        type: d.config.type || 'info',
      }))
      .catch(() => setError('Failed to load announcement'));
  }, [apiFetch]);

  const save = async () => {
    setSaving(true); setMsg(null);
    try {
      const res = await superadminSaveAnnouncement(apiFetch, form);
      const d = await res.json();
      if (!res.ok) setMsg({ ok: false, text: d.error || 'Save failed' });
      else setMsg({ ok: true, text: form.enabled ? 'Saved — banner is live for all users' : 'Saved — banner is hidden' });
    } catch { setMsg({ ok: false, text: 'Network error' }); }
    finally { setSaving(false); }
  };

  if (error) return <div className="sa-panel" style={{ marginTop: 16, padding: 12, color: 'var(--sa-danger)' }}>{error}</div>;
  if (!form) return <div className="sa-loading">Loading announcement...</div>;

  return (
    <div className="sa-panel" style={{ marginTop: 16 }}>
      <div className="sa-panel-header">
        <span className="sa-panel-title">Site Announcement Banner</span>
        <button className="sa-btn" onClick={save} disabled={saving}>{saving ? 'Saving...' : 'Save'}</button>
      </div>
      <div className="sa-panel-body">
        <div style={{ fontSize: 11, color: 'var(--sa-text-dim)', marginBottom: 12 }}>
          Shown at the top of the app for every user — use it to announce planned
          maintenance in advance. Editing the text re-shows the banner to users
          who dismissed the previous one. The public maintenance page takes over
          automatically once the server actually goes down.
        </div>
        <div className="sa-kv">
          <div className="sa-kv-row">
            <span className="sa-kv-key">Enabled</span>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={e => setForm(f => ({ ...f, enabled: e.target.checked }))}
              />
              <span style={{ fontSize: 11 }}>Show banner to all users</span>
            </label>
          </div>
          <div className="sa-kv-row">
            <span className="sa-kv-key">Style</span>
            <select
              value={form.type}
              onChange={e => setForm(f => ({ ...f, type: e.target.value }))}
              style={{ background: 'var(--sa-bg)', border: '1px solid var(--sa-border)', color: 'var(--sa-text)', padding: '2px 6px', borderRadius: 3, fontSize: 12 }}
            >
              <option value="info">Info (blue)</option>
              <option value="warning">Warning (amber)</option>
            </select>
          </div>
          <div className="sa-kv-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 4 }}>
            <span className="sa-kv-key">
              Message (English)
              <span style={{ marginLeft: 6, color: 'var(--sa-text-dim)', fontSize: 10 }}>{form.message.length} / 500</span>
            </span>
            <textarea
              value={form.message}
              maxLength={500}
              onChange={e => setForm(f => ({ ...f, message: e.target.value }))}
              placeholder="e.g. Planned maintenance tonight 22:00–22:15 CET — Cellarion will be briefly unavailable."
              style={TEXTAREA_STYLE}
            />
          </div>
          <div className="sa-kv-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 4 }}>
            <span className="sa-kv-key">
              Message (Swedish, optional — falls back to English)
              <span style={{ marginLeft: 6, color: 'var(--sa-text-dim)', fontSize: 10 }}>{form.messageSv.length} / 500</span>
            </span>
            <textarea
              value={form.messageSv}
              maxLength={500}
              onChange={e => setForm(f => ({ ...f, messageSv: e.target.value }))}
              placeholder="t.ex. Planerat underhåll ikväll 22:00–22:15 — Cellarion är otillgängligt en kort stund."
              style={TEXTAREA_STYLE}
            />
          </div>
        </div>
        {msg && (
          <div style={{ marginTop: 10, fontSize: 11, color: msg.ok ? 'var(--sa-accent)' : 'var(--sa-danger)' }}>{msg.text}</div>
        )}
      </div>
    </div>
  );
}
