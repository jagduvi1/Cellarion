import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { getRecentlyDeleted, restoreRecentlyDeleted } from '../api/bottles';
import Modal from './Modal';
import { bottleLine } from '../utils/bulkSelection';
// Why a bottle could not come back (POST /api/bottles/trash/restore reasons).
import { RESTORE_SKIP_KEYS as SKIP_KEYS } from '../utils/trash';

const DAY_MS = 24 * 60 * 60 * 1000;
// Rows shown per deletion before "Show all".
const ROWS_COLLAPSED = 8;

const daysLeft = (purgeAt) => Math.max(0, Math.ceil((new Date(purgeAt).getTime() - Date.now()) / DAY_MS));

/**
 * A cellar's "Recently deleted": the bottles a bulk delete moved out, grouped
 * by the delete they came from, newest first. Each comes back on its own or
 * with its whole batch, under its old id — photos, notes and list entries
 * included — and back in its rack slot if that is still free. Opened from the
 * cellar's ⋮ menu; `onClose(restoredAny)` lets the page refresh only when
 * something came back.
 */
export default function RecentlyDeletedModal({ cellarId, onClose }) {
  const { t, i18n } = useTranslation();
  const { apiFetch } = useAuth();
  const [items, setItems] = useState(null); // null while loading
  const [retentionDays, setRetentionDays] = useState(30);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(null); // the row id or `batch:<id>` being restored
  const [message, setMessage] = useState(null); // { restored, skipped: [reason] }
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(() => new Set());
  const restoredAny = useRef(false);

  const load = useCallback(async () => {
    setLoadError('');
    try {
      const res = await getRecentlyDeleted(apiFetch, cellarId);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || t('trash.loadError'));
      setItems(data.items || []);
      if (data.retentionDays) setRetentionDays(data.retentionDays);
    } catch (err) {
      setLoadError(err.message || t('trash.loadError'));
      setItems([]);
    }
  }, [apiFetch, cellarId, t]);

  useEffect(() => { load(); }, [load]);

  const restore = async (key, { ids, batchId }) => {
    if (busy) return;
    setBusy(key);
    setError('');
    setMessage(null);
    try {
      const res = await restoreRecentlyDeleted(apiFetch, cellarId, { ids, batchId });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || t('trash.restoreFailed'));
      if (data.restored > 0) restoredAny.current = true;
      setMessage({ restored: data.restored ?? 0, skipped: (data.skipped || []).map((s) => s.reason) });
      await load();
    } catch (err) {
      setError(err.message || t('trash.restoreFailed'));
    } finally {
      setBusy(null);
    }
  };

  // Rows arrive newest first; keep that order and group by the delete.
  const batches = [];
  for (const item of items || []) {
    const last = batches[batches.length - 1];
    if (last && last.batchId === item.batchId) last.rows.push(item);
    else batches.push({ batchId: item.batchId, deletedAt: item.deletedAt, purgeAt: item.purgeAt, rows: [item] });
  }

  const labelOf = (row) => {
    const l = row.label || {};
    return bottleLine({ ...l, name: l.name || (l.producer ? '' : t('common.unknownWine')) });
  };
  const when = (date) => new Date(date).toLocaleString(i18n.language, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const close = () => onClose(restoredAny.current);

  return (
    <Modal title={t('trash.title')} onClose={close} showClose trapFocus wide>
      <p className="trash-intro">{t('trash.intro', { days: retentionDays })}</p>

      {message && (
        <div className="trash-message" role="status">
          {message.restored > 0 && <p>{t('trash.restoredInfo', { count: message.restored })}</p>}
          {[...new Set(message.skipped)].map((reason) => (
            <p key={reason} className="move-bottle-skipped">
              {t(SKIP_KEYS[reason] || 'trash.restoreSkipped', { count: message.skipped.filter((r) => r === reason).length })}
            </p>
          ))}
        </div>
      )}
      {error && <p className="error-message" role="alert">{error}</p>}

      {items === null && <p className="trash-empty">{t('common.loading')}</p>}
      {loadError && <p className="error-message" role="alert">{loadError}</p>}
      {items !== null && !loadError && batches.length === 0 && <p className="trash-empty">{t('trash.empty')}</p>}

      {batches.map((b) => {
        const open = expanded.has(b.batchId) || b.rows.length <= ROWS_COLLAPSED;
        const rows = open ? b.rows : b.rows.slice(0, ROWS_COLLAPSED);
        const left = daysLeft(b.purgeAt);
        return (
          <section key={b.batchId} className="trash-batch">
            <header className="trash-batch-head">
              <div>
                <strong>{t('trash.batchHeading', { date: when(b.deletedAt), count: b.rows.length })}</strong>
                <span className="trash-batch-left">{t('trash.daysLeft', { count: left })}</span>
              </div>
              {b.rows.length > 1 && (
                <button
                  type="button"
                  className="btn btn-secondary btn-small"
                  onClick={() => restore(`batch:${b.batchId}`, { batchId: b.batchId })}
                  disabled={!!busy}
                >
                  {busy === `batch:${b.batchId}` ? t('trash.restoring') : t('trash.restoreAll', { count: b.rows.length })}
                </button>
              )}
            </header>
            <ul className="trash-rows">
              {rows.map((row) => (
                <li key={row.id} className="trash-row">
                  <span className="trash-row-label">{labelOf(row)}</span>
                  <button
                    type="button"
                    className="btn btn-secondary btn-small"
                    onClick={() => restore(row.id, { ids: [row.id] })}
                    disabled={!!busy}
                    aria-label={t('trash.restoreAria', { name: labelOf(row) })}
                  >
                    {busy === row.id ? t('trash.restoring') : t('trash.restore')}
                  </button>
                </li>
              ))}
            </ul>
            {!open && (
              <button
                type="button"
                className="bulk-bar-link trash-show-all"
                onClick={() => setExpanded((prev) => new Set(prev).add(b.batchId))}
              >
                {t('trash.showAll', { count: b.rows.length })}
              </button>
            )}
          </section>
        );
      })}

      <div className="modal-actions">
        <button type="button" className="btn btn-primary" onClick={close}>{t('bulk.close')}</button>
      </div>
    </Modal>
  );
}
