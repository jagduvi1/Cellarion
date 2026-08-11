import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import Modal from './Modal';
import { sommGetPendingWines, sommFixPendingWine } from '../api/somm';

const PAGE_SIZE = 25;

/**
 * PENDING-IDENTITY queue — the web half of the feature whose whole point is
 * that a bottle with an unreadable label still saves. Sibling of
 * WineCrossFieldChecksModal / WineProducerInNameModal, but a different KIND of
 * queue: those flag data that looks wrong, this one holds rows that were never
 * complete. A wine here is invisible to every user except the one who added it
 * until a curator fills in the producer.
 *
 * Unlike the scan queues, this one lets the admin FIX in place — the whole
 * value is reading the label photo and typing what it says without leaving the
 * row. Saving a producer + name promotes the wine automatically (server-side
 * hook) and it disappears from the list.
 *
 * Deliberately NOT shown: who added the bottle. The queue is anonymised the
 * same way the owner-inquiry queue is — a curator judges a record, not a
 * person, and the same rows are served over MCP.
 *
 * Props:
 *   apiFetch  — from useAuth()
 *   onClose() — close the modal
 */
function WinePendingIdentityModal({ apiFetch, onClose }) {
  const { t } = useTranslation();

  const [wines, setWines] = useState(null); // null = not yet loaded
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [viaFilter, setViaFilter] = useState('');
  const [viaOptions, setViaOptions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null);   // wineId being edited
  const [draft, setDraft] = useState(null);       // the edit form's values
  const [saving, setSaving] = useState(false);
  const [rowError, setRowError] = useState(null);
  const [successMsg, setSuccessMsg] = useState(null);

  const fetchPage = useCallback(async (p) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ page: p, limit: PAGE_SIZE });
      if (viaFilter) params.set('createdVia', viaFilter);
      const res = await sommGetPendingWines(apiFetch, params);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || `Failed to load (${res.status})`);
        setWines([]);
        return;
      }
      setWines(data.wines || []);
      setTotal(data.total || 0);
      setPages(data.pages || 1);
      setViaOptions(data.createdViaOptions || []);
    } catch {
      setError(t('common.networkError'));
      setWines([]);
    } finally {
      setLoading(false);
    }
  }, [apiFetch, t, viaFilter]);

  useEffect(() => { fetchPage(page); }, [fetchPage, page]);

  const startEdit = (w) => {
    setRowError(null);
    setEditing(w._id);
    setDraft({
      producer: w.producer || '',
      name: w.name || '',
      appellation: w.appellation || '',
      regionName: w.regionName || '',
      countryName: w.countryName || '',
      grapeNames: (w.grapeNames || []).join(', '),
    });
  };

  const cancelEdit = () => { setEditing(null); setDraft(null); setRowError(null); };

  const save = async (wineId) => {
    setSaving(true);
    setRowError(null);
    try {
      // Only send what the curator actually typed — an untouched field must
      // not be echoed back as a "change" (and an empty producer would be
      // refused by the server anyway).
      const patch = {};
      if (draft.producer.trim()) patch.producer = draft.producer.trim();
      if (draft.name.trim()) patch.name = draft.name.trim();
      patch.appellation = draft.appellation.trim();
      patch.regionName = draft.regionName.trim();
      if (draft.countryName.trim()) patch.countryName = draft.countryName.trim();
      patch.grapeNames = draft.grapeNames.split(',').map(g => g.trim()).filter(Boolean);

      const res = await sommFixPendingWine(apiFetch, wineId, patch);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setRowError(data.error || `Failed to save (${res.status})`);
        return;
      }
      setSuccessMsg(data.message);
      cancelEdit();
      await fetchPage(page);
    } catch {
      setRowError(t('common.networkError'));
    } finally {
      setSaving(false);
    }
  };

  const thStyle = {
    textAlign: 'left',
    padding: '0.4rem 0.5rem',
    fontSize: '0.8rem',
    color: 'var(--color-text-secondary, #666)',
    borderBottom: '1px solid var(--color-border, #e5e5e5)',
    whiteSpace: 'nowrap',
  };
  const tdStyle = {
    padding: '0.45rem 0.5rem',
    borderBottom: '1px solid var(--color-border, #eee)',
    verticalAlign: 'top',
  };
  const thumbStyle = {
    width: 56,
    height: 56,
    objectFit: 'cover',
    borderRadius: 4,
    border: '1px solid var(--color-border, #e5e5e5)',
    marginRight: 4,
    background: 'var(--color-surface, #f4f4f4)',
  };

  // The bytes are served by the unauthenticated random-UUID static mount, so a
  // plain <img> works — but an <img> cannot send the Authorization header, so
  // the queue payload carries the URLs rather than making the client resolve
  // each id through /api/images/:id.
  const thumbSrc = (w, id) => (w.imageUrls || {})[id] || null;

  return (
    <Modal title={t('admin.wines.pendingIdentity.title')} onClose={onClose} showClose wide>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
        <span style={{ fontSize: '0.85rem', color: 'var(--color-text-secondary, #666)' }}>
          {t('admin.wines.pendingIdentity.intro')}
        </span>
        <label style={{ fontSize: '0.85rem' }}>
          {t('admin.wines.pendingIdentity.sourceLabel')}:{' '}
          <select
            value={viaFilter}
            onChange={e => { setViaFilter(e.target.value); setPage(1); }}
            disabled={loading || saving}
          >
            <option value="">{t('admin.wines.pendingIdentity.allSources')}</option>
            {viaOptions.map(v => <option key={v} value={v}>{v}</option>)}
          </select>
        </label>
      </div>

      {successMsg && <div className="alert alert-success">{successMsg}</div>}
      {error && <div className="alert alert-error">{error}</div>}
      {loading && <p>{t('common.loading')}</p>}
      {wines !== null && !loading && wines.length === 0 && !error && (
        <p>{t('admin.wines.pendingIdentity.empty')}</p>
      )}

      {wines !== null && !loading && wines.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={thStyle}>{t('admin.wines.pendingIdentity.imagesCol')}</th>
                <th style={thStyle}>{t('admin.wines.pendingIdentity.wineCol')}</th>
                <th style={thStyle}>{t('admin.wines.pendingIdentity.placeCol')}</th>
                <th style={thStyle}>{t('admin.wines.pendingIdentity.sourceCol')}</th>
                <th style={thStyle}></th>
              </tr>
            </thead>
            <tbody>
              {wines.map(w => {
                const imageIds = [w.scanImageId, ...(w.bottleImageIds || [])]
                  .filter(Boolean)
                  .filter(id => thumbSrc(w, id));
                return (
                  <tr key={w._id}>
                    <td style={tdStyle}>
                      {imageIds.length === 0
                        ? <span style={{ fontSize: '0.8rem', color: 'var(--color-text-secondary, #888)' }}>
                            {t('admin.wines.pendingIdentity.noImages')}
                          </span>
                        : imageIds.map(id => (
                          <a key={id} href={thumbSrc(w, id)} target="_blank" rel="noreferrer">
                            <img src={thumbSrc(w, id)} alt="" style={thumbStyle} />
                          </a>
                        ))}
                    </td>
                    <td style={tdStyle}>
                      {editing === w._id ? (
                        <div style={{ display: 'grid', gap: 4, minWidth: 240 }}>
                          <input
                            type="text"
                            value={draft.producer}
                            placeholder={t('admin.wines.pendingIdentity.producerPlaceholder')}
                            onChange={e => setDraft(d => ({ ...d, producer: e.target.value }))}
                          />
                          <input
                            type="text"
                            value={draft.name}
                            placeholder={t('admin.wines.pendingIdentity.namePlaceholder')}
                            onChange={e => setDraft(d => ({ ...d, name: e.target.value }))}
                          />
                          <input
                            type="text"
                            value={draft.appellation}
                            placeholder={t('admin.wines.pendingIdentity.appellationPlaceholder')}
                            onChange={e => setDraft(d => ({ ...d, appellation: e.target.value }))}
                          />
                          <input
                            type="text"
                            value={draft.grapeNames}
                            placeholder={t('admin.wines.pendingIdentity.grapesPlaceholder')}
                            onChange={e => setDraft(d => ({ ...d, grapeNames: e.target.value }))}
                          />
                        </div>
                      ) : (
                        <>
                          <Link to={`/wines/${w._id}`} target="_blank" rel="noreferrer">{w.name}</Link>
                          <div style={{ fontSize: '0.8rem', color: 'var(--color-text-secondary, #666)' }}>
                            {w.producer || <em>{t('admin.wines.pendingIdentity.noProducer')}</em>}
                            {w.appellation ? ` · ${w.appellation}` : ''}
                          </div>
                        </>
                      )}
                    </td>
                    <td style={tdStyle}>
                      {editing === w._id ? (
                        <div style={{ display: 'grid', gap: 4, minWidth: 160 }}>
                          <input
                            type="text"
                            value={draft.countryName}
                            placeholder={t('admin.wines.pendingIdentity.countryPlaceholder')}
                            onChange={e => setDraft(d => ({ ...d, countryName: e.target.value }))}
                          />
                          <input
                            type="text"
                            value={draft.regionName}
                            placeholder={t('admin.wines.pendingIdentity.regionPlaceholder')}
                            onChange={e => setDraft(d => ({ ...d, regionName: e.target.value }))}
                          />
                        </div>
                      ) : (
                        <span style={{ fontSize: '0.85rem' }}>
                          {[w.countryName, w.regionName].filter(Boolean).join(' · ') || '—'}
                        </span>
                      )}
                    </td>
                    <td style={{ ...tdStyle, fontSize: '0.8rem', whiteSpace: 'nowrap' }}>
                      {w.createdVia || '—'}
                      <div style={{ color: 'var(--color-text-secondary, #888)' }}>
                        {t('admin.wines.pendingIdentity.bottles', { n: w.bottleCount })}
                      </div>
                    </td>
                    <td style={{ ...tdStyle, whiteSpace: 'nowrap' }}>
                      {editing === w._id ? (
                        <>
                          <button className="btn btn-primary btn-sm" disabled={saving} onClick={() => save(w._id)}>
                            {saving ? t('common.saving') : t('common.save')}
                          </button>{' '}
                          <button className="btn btn-secondary btn-sm" disabled={saving} onClick={cancelEdit}>
                            {t('common.cancel')}
                          </button>
                          {rowError && <div className="alert alert-error" style={{ marginTop: 6 }}>{rowError}</div>}
                        </>
                      ) : (
                        <button className="btn btn-secondary btn-sm" onClick={() => startEdit(w)}>
                          {t('admin.wines.pendingIdentity.fixBtn')}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {pages > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12 }}>
          <button className="btn btn-secondary btn-sm" disabled={page <= 1 || loading} onClick={() => setPage(p => p - 1)}>
            {t('common.previous')}
          </button>
          <span style={{ fontSize: '0.85rem' }}>{t('admin.audit.page', { page, pages })}</span>
          <button className="btn btn-secondary btn-sm" disabled={page >= pages || loading} onClick={() => setPage(p => p + 1)}>
            {t('common.next')}
          </button>
          <span style={{ fontSize: '0.8rem', color: 'var(--color-text-secondary, #888)' }}>
            {t('admin.wines.pendingIdentity.found', { n: total })}
          </span>
        </div>
      )}
    </Modal>
  );
}

export default WinePendingIdentityModal;
