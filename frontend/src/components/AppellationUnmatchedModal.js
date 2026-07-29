import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from './Modal';
import { adminGetUnmatchedAppellations, adminCreateTaxonomy } from '../api/admin';

/**
 * The appellation review queue (registry strategy 2026-07-29, R2).
 *
 * Wines carry appellations as free text; anything no curated Appellation doc
 * covers surfaces here with the majority spelling, wine count and suggested
 * country/region. "Add to taxonomy" promotes the row via the normal create
 * endpoint — from then on the write-time resolver adopts this spelling and
 * new variants stop forming. Unknown values are reviewed, never rejected:
 * adding a bottle is never blocked by taxonomy, which is why this queue
 * exists at all.
 *
 * The name is editable before promoting (the majority spelling of a rare
 * appellation can itself be the typo); country is required by the schema.
 * Styling matches its sibling review modals: generic classes + inline layout.
 *
 * Props: apiFetch (from useAuth()), countries (admin country list), onClose(),
 * onPromoted() — refresh the appellations tab.
 */
function AppellationUnmatchedModal({ apiFetch, countries, onClose, onPromoted }) {
  const { t } = useTranslation();
  const [items, setItems] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [drafts, setDrafts] = useState({});      // normalized → { name, countryId }
  const [pendingKey, setPendingKey] = useState(null);
  const [rowErrors, setRowErrors] = useState({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await adminGetUnmatchedAppellations(apiFetch);
      const data = await res.json();
      if (res.ok) setItems(data.items || []);
      else setError(data.error || t('admin.taxonomy.unmatched.loadError'));
    } catch {
      setError('Network error');
    } finally {
      setLoading(false);
    }
  }, [apiFetch, t]);

  useEffect(() => { load(); }, [load]);

  const draftFor = (item) => drafts[item.normalized] || { name: item.name, countryId: item.countryId || '' };
  const setDraft = (item, patch) =>
    setDrafts(prev => ({ ...prev, [item.normalized]: { ...draftFor(item), ...patch } }));

  const promote = async (item) => {
    const d = draftFor(item);
    if (!d.name?.trim() || !d.countryId) return;
    setPendingKey(item.normalized);
    setRowErrors(prev => ({ ...prev, [item.normalized]: null }));
    try {
      const res = await adminCreateTaxonomy(apiFetch, '/api/admin/taxonomy/appellations', {
        name: d.name.trim(),
        country: d.countryId,
        // The suggested region only holds for the suggested country.
        region: d.countryId === item.countryId ? item.regionId : null,
      });
      const data = await res.json();
      if (res.ok) {
        setItems(prev => prev.filter(i => i.normalized !== item.normalized));
        onPromoted?.();
      } else {
        setRowErrors(prev => ({ ...prev, [item.normalized]: data.error || t('admin.taxonomy.unmatched.promoteError') }));
      }
    } catch {
      setRowErrors(prev => ({ ...prev, [item.normalized]: 'Network error' }));
    } finally {
      setPendingKey(null);
    }
  };

  return (
    <Modal title={t('admin.taxonomy.unmatched.title')} onClose={onClose} wide>
      <p style={{ color: 'var(--color-text-muted)', fontSize: '0.85rem', marginTop: 0 }}>
        {t('admin.taxonomy.unmatched.explainer')}
      </p>

      {error && <div className="alert alert-error" style={{ marginBottom: 12 }}>{error}</div>}

      {loading || items === null ? (
        <div className="loading">{t('common.loading')}</div>
      ) : items.length === 0 ? (
        <div className="empty-state"><p>{t('admin.taxonomy.unmatched.empty')}</p></div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {items.map(item => {
            const d = draftFor(item);
            return (
              <div key={item.normalized} style={{ border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)', padding: '0.6rem 0.8rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <input
                    type="text"
                    value={d.name}
                    onChange={(e) => setDraft(item, { name: e.target.value })}
                    style={{ flex: '1 1 180px', minWidth: 140 }}
                    aria-label={t('admin.taxonomy.appellationNameLabel')}
                  />
                  <select
                    value={d.countryId}
                    onChange={(e) => setDraft(item, { countryId: e.target.value })}
                    style={{ flex: '0 1 170px' }}
                    aria-label={t('admin.requests.countryLabel')}
                  >
                    <option value="">{t('admin.taxonomy.selectCountry')}</option>
                    {countries.map(c => (
                      <option key={c._id} value={c._id}>{c.name}</option>
                    ))}
                  </select>
                  <span style={{ fontSize: '0.8rem', color: 'var(--color-text-muted)', whiteSpace: 'nowrap' }}>
                    {t('admin.taxonomy.wineCount', { count: item.wineCount })}
                    {item.regionName && d.countryId === item.countryId && ` · ${item.regionName}`}
                  </span>
                  <button
                    type="button"
                    className="btn btn-primary btn-small"
                    disabled={pendingKey === item.normalized || !d.name?.trim() || !d.countryId}
                    onClick={() => promote(item)}
                  >
                    {pendingKey === item.normalized ? t('admin.taxonomy.unmatched.promoting') : t('admin.taxonomy.unmatched.promote')}
                  </button>
                </div>
                {rowErrors[item.normalized] && (
                  <div className="alert alert-error" style={{ marginTop: 6, fontSize: '0.8rem', padding: '0.35rem 0.5rem' }}>
                    {rowErrors[item.normalized]}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Modal>
  );
}

export default AppellationUnmatchedModal;
