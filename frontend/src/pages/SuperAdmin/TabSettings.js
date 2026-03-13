import { useState, useEffect } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { adminGetRateLimits, adminSaveRateLimits, adminGetContactEmail, adminSaveContactEmail } from '../../api/admin';

function RateLimitsPanel({ apiFetch }) {
  const LIMITERS = [
    { key: 'api',   label: 'General API',  hint: 'requests / 15 min per IP' },
    { key: 'write', label: 'Write actions', hint: 'requests / 15 min per IP' },
    { key: 'auth',  label: 'Auth / login',  hint: 'requests / 15 min per IP' },
  ];

  const [form,     setForm]     = useState(null);
  const [defaults, setDefaults] = useState(null);
  const [saving,   setSaving]   = useState(false);
  const [msg,      setMsg]      = useState(null);

  useEffect(() => {
    adminGetRateLimits(apiFetch)
      .then(r => r.json())
      .then(d => {
        setForm({ api: String(d.config.api.max), write: String(d.config.write.max), auth: String(d.config.auth.max) });
        setDefaults(d.defaults);
      })
      .catch(() => setMsg({ ok: false, text: 'Failed to load' }));
  }, [apiFetch]);

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      const body = {
        api:   { max: Number(form.api)   },
        write: { max: Number(form.write) },
        auth:  { max: Number(form.auth)  },
      };
      const res = await adminSaveRateLimits(apiFetch, body);
      if (!res.ok) {
        const d = await res.json();
        setMsg({ ok: false, text: d.error || 'Save failed' });
      } else {
        setMsg({ ok: true, text: 'Saved — takes effect immediately' });
      }
    } catch {
      setMsg({ ok: false, text: 'Network error' });
    } finally {
      setSaving(false);
    }
  };

  if (!form) return <div className="sa-loading">Loading rate limits...</div>;

  return (
    <div className="sa-panel" style={{ marginTop: 16 }}>
      <div className="sa-panel-header">
        <span className="sa-panel-title">Rate Limits</span>
        <button className="sa-btn" onClick={save} disabled={saving}>{saving ? 'Saving...' : 'Save'}</button>
      </div>
      <div className="sa-panel-body">
        <div style={{ fontSize: 11, color: 'var(--sa-text-dim)', marginBottom: 12 }}>
          Maximum requests per 15-minute window per IP address.
        </div>
        <div className="sa-kv">
          {LIMITERS.map(({ key, label, hint }) => (
            <div className="sa-kv-row" key={key}>
              <span className="sa-kv-key">
                {label}
                {defaults && (
                  <span style={{ marginLeft: 6, color: 'var(--sa-text-dim)', fontSize: 10 }}>
                    (default: {defaults[key].max})
                  </span>
                )}
              </span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input
                  type="number"
                  min="1"
                  max="10000"
                  value={form[key]}
                  onChange={e => setForm(v => ({ ...v, [key]: e.target.value }))}
                  style={{ width: 80, background: 'var(--sa-bg)', border: '1px solid var(--sa-border)', color: 'var(--sa-text)', padding: '2px 6px', borderRadius: 3, fontFamily: 'monospace', fontSize: 12 }}
                />
                <span style={{ fontSize: 10, color: 'var(--sa-text-dim)' }}>{hint}</span>
              </div>
            </div>
          ))}
        </div>
        {msg && (
          <div style={{ marginTop: 10, fontSize: 11, color: msg.ok ? 'var(--sa-accent)' : 'var(--sa-danger)' }}>{msg.text}</div>
        )}
      </div>
    </div>
  );
}

function ContactEmailPanel({ apiFetch }) {
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);

  useEffect(() => {
    adminGetContactEmail(apiFetch)
      .then(r => r.json())
      .then(d => setValue(d.contactEmail || ''))
      .catch(() => setMsg({ ok: false, text: 'Failed to load' }));
  }, [apiFetch]);

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      const res = await adminSaveContactEmail(apiFetch, value.trim());
      if (!res.ok) {
        const d = await res.json();
        setMsg({ ok: false, text: d.error || 'Save failed' });
      } else {
        setMsg({ ok: true, text: 'Saved' });
      }
    } catch {
      setMsg({ ok: false, text: 'Network error' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="sa-panel" style={{ marginTop: 16 }}>
      <div className="sa-panel-header">
        <span className="sa-panel-title">Contact Email</span>
        <button className="sa-btn" onClick={save} disabled={saving}>{saving ? 'Saving...' : 'Save'}</button>
      </div>
      <div className="sa-panel-body">
        <div style={{ fontSize: 11, color: 'var(--sa-text-dim)', marginBottom: 12 }}>
          Shown in beta notices and support prompts across the app.
        </div>
        <div className="sa-kv">
          <div className="sa-kv-row">
            <span className="sa-kv-key">Contact address</span>
            <input
              type="email"
              value={value}
              onChange={e => setValue(e.target.value)}
              placeholder="support@example.com"
              style={{ background: 'var(--sa-bg)', border: '1px solid var(--sa-border)', color: 'var(--sa-text)', padding: '2px 8px', borderRadius: 3, fontFamily: 'monospace', fontSize: 12, width: 240 }}
            />
          </div>
        </div>
        {msg && <div style={{ marginTop: 8, fontSize: 11, color: msg.ok ? 'var(--sa-green)' : 'var(--sa-red)' }}>{msg.text}</div>}
      </div>
    </div>
  );
}

export default function TabSettings() {
  const { apiFetch } = useAuth();
  return (
    <>
      <ContactEmailPanel apiFetch={apiFetch} />
      <RateLimitsPanel apiFetch={apiFetch} />
    </>
  );
}
