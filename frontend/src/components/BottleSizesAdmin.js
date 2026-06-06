import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { bottleSizeLabel } from '../config/bottleSizes';

/**
 * Admin panel (rendered as a tab inside AdminTaxonomy) for auditing and fixing
 * the bottle-size values stored on bottles: lists distinct values + counts,
 * flags non-canonical ones, and lets an admin remap a value to a canonical
 * code or normalize the whole collection in one click.
 */
export default function BottleSizesAdmin({ apiFetch }) {
  const { t } = useTranslation();
  const [sizes, setSizes] = useState([]);
  const [canonical, setCanonical] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [targets, setTargets] = useState({}); // stored value -> chosen target code

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch('/api/admin/taxonomy/bottle-sizes');
      const data = await res.json();
      if (res.ok) {
        setSizes(data.sizes || []);
        setCanonical(data.canonical || []);
      }
    } catch { /* ignore */ } finally {
      setLoading(false);
    }
  }, [apiFetch]);

  useEffect(() => { load(); }, [load]);

  const normalizeAll = async () => {
    setBusy(true); setMsg(null);
    try {
      const res = await apiFetch('/api/admin/taxonomy/bottle-sizes/normalize-all', { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        setMsg(t('admin.bottleSizes.normalized', { defaultValue: '{{count}} bottle(s) normalized.', count: data.changed }));
        await load();
      }
    } catch { /* ignore */ } finally {
      setBusy(false);
    }
  };

  const remap = async (from) => {
    const to = targets[from];
    if (!to) return;
    setBusy(true); setMsg(null);
    try {
      const res = await apiFetch('/api/admin/taxonomy/bottle-sizes/remap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to }),
      });
      const data = await res.json();
      if (res.ok) {
        setMsg(t('admin.bottleSizes.remapped', { defaultValue: '{{count}} bottle(s) remapped.', count: data.modified }));
        await load();
      } else {
        setMsg(data.error || 'Remap failed');
      }
    } catch { /* ignore */ } finally {
      setBusy(false);
    }
  };

  if (loading) return <div className="loading">{t('common.loading')}</div>;

  const nonCanonical = sizes.filter((s) => !s.canonical).length;

  return (
    <div className="bottle-sizes-admin">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <p style={{ margin: 0, color: '#9A9484' }}>
          {t('admin.bottleSizes.intro', { defaultValue: '{{count}} non-standard value(s) in use.', count: nonCanonical })}
        </p>
        <button className="btn btn-primary btn-small" onClick={normalizeAll} disabled={busy || nonCanonical === 0}>
          {t('admin.bottleSizes.normalizeAll', 'Normalize all')}
        </button>
      </div>

      {msg && <div className="alert alert-success">{msg}</div>}

      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ textAlign: 'left', color: '#9A9484', fontSize: 13 }}>
            <th style={{ padding: '6px 8px' }}>{t('admin.bottleSizes.stored', 'Stored value')}</th>
            <th style={{ padding: '6px 8px' }}>{t('admin.bottleSizes.count', 'Bottles')}</th>
            <th style={{ padding: '6px 8px' }}>{t('admin.bottleSizes.status', 'Status')}</th>
            <th style={{ padding: '6px 8px' }}>{t('admin.bottleSizes.remapTo', 'Remap to')}</th>
          </tr>
        </thead>
        <tbody>
          {sizes.map((s) => (
            <tr key={s.value == null ? '(empty)' : s.value} style={{ borderTop: '1px solid #252525' }}>
              <td style={{ padding: '6px 8px', fontFamily: 'monospace' }}>
                {s.value == null ? <em>(empty)</em> : s.value}
              </td>
              <td style={{ padding: '6px 8px' }}>{s.count}</td>
              <td style={{ padding: '6px 8px' }}>
                {s.canonical
                  ? `✓ ${bottleSizeLabel(s.value, t)}`
                  : s.suggested
                    ? `→ ${bottleSizeLabel(s.suggested, t)}`
                    : t('admin.bottleSizes.unrecognized', 'unrecognized')}
              </td>
              <td style={{ padding: '6px 8px' }}>
                {!s.canonical && s.value != null && (
                  <span style={{ display: 'inline-flex', gap: 6 }}>
                    <select
                      value={targets[s.value] || s.suggested || ''}
                      onChange={(e) => setTargets({ ...targets, [s.value]: e.target.value })}
                    >
                      <option value="" disabled>{t('admin.bottleSizes.choose', 'Choose…')}</option>
                      {canonical.map((c) => (
                        <option key={c.code} value={c.code}>{bottleSizeLabel(c.code, t)}</option>
                      ))}
                    </select>
                    <button className="btn btn-secondary btn-small" disabled={busy} onClick={() => remap(s.value)}>
                      {t('admin.bottleSizes.apply', 'Apply')}
                    </button>
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
