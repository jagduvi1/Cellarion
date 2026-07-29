import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from './Modal';
import { adminGetCanonicalCollisions, adminDismissDuplicateCluster } from '../api/admin';

/**
 * Admin review list for wines sharing one canonical identity key — the
 * strongest duplicate signal the registry computes (producer-spelling,
 * producer-in-name and appellation-tier variance all collapsed), detected
 * since the 2026-07-22 dup analysis but never surfaced in any UI until now
 * (strategy 2026-07-29, R5).
 *
 * Deliberately a REVIEW list, not an auto-merge: distinct wineries can
 * legitimately share a key (Domaine Chandon, Napa vs Bodegas Chandon,
 * Mendoza — the endpoint flags those DIFF-COUNTRY). "Not duplicates" records
 * every pair in the set so the whole set stops resurfacing here and in the
 * duplicate scanner; actual merging goes through the existing golden-record
 * merge in the duplicates scanner, where the keeper is chosen field by field.
 *
 * Styling follows its siblings (WineLowConfidenceModal): generic classes +
 * inline layout, no bespoke stylesheet.
 *
 * Props: apiFetch (from useAuth()), onClose().
 */
function WineCanonicalCollisionsModal({ apiFetch, onClose }) {
  const { t } = useTranslation();
  const [sets, setSets] = useState(null);
  const [scanned, setScanned] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [pendingKey, setPendingKey] = useState(null); // canonicalKey being dismissed

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await adminGetCanonicalCollisions(apiFetch);
      const data = await res.json();
      if (res.ok) {
        setSets(data.sets || []);
        setScanned(data.scannedCount || 0);
      } else {
        setError(data.error || t('admin.wines.canonicalCollisions.loadError'));
      }
    } catch {
      setError('Network error');
    } finally {
      setLoading(false);
    }
  }, [apiFetch, t]);

  useEffect(() => { load(); }, [load]);

  const dismissSet = async (set) => {
    setPendingKey(set.canonicalKey);
    setError(null);
    try {
      const res = await adminDismissDuplicateCluster(apiFetch, set.wines.map(w => w._id));
      const data = await res.json();
      if (res.ok) setSets(prev => prev.filter(s => s.canonicalKey !== set.canonicalKey));
      else setError(data.error || t('admin.wines.canonicalCollisions.dismissError'));
    } catch {
      setError('Network error');
    } finally {
      setPendingKey(null);
    }
  };

  const flagStyle = {
    fontSize: '0.7rem', fontWeight: 600, padding: '0.1rem 0.45rem',
    borderRadius: 'var(--radius-sm)', background: 'var(--color-warning-bg)',
    border: '1px solid var(--color-warning-border)',
  };

  return (
    <Modal title={t('admin.wines.canonicalCollisions.title')} onClose={onClose} wide>
      <p style={{ color: 'var(--color-text-muted)', fontSize: '0.85rem', marginTop: 0 }}>
        {t('admin.wines.canonicalCollisions.explainer')}
      </p>

      {error && <div className="alert alert-error" style={{ marginBottom: 12 }}>{error}</div>}

      {loading || sets === null ? (
        <div className="loading">{t('common.loading')}</div>
      ) : sets.length === 0 ? (
        <div className="empty-state">
          <p>{t('admin.wines.canonicalCollisions.empty', { scanned })}</p>
        </div>
      ) : (
        <>
          <p style={{ fontSize: '0.85rem' }}>
            {t('admin.wines.canonicalCollisions.count', { count: sets.length, scanned })}
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {sets.map(set => (
              <div
                key={set.canonicalKey}
                style={{ border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)', padding: '0.65rem 0.85rem' }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
                  <code
                    title={set.canonicalKey}
                    style={{ fontSize: '0.72rem', color: 'var(--color-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '45%' }}
                  >
                    {set.canonicalKey}
                  </code>
                  {set.flags.map(f => (
                    <span key={f} style={flagStyle}>
                      {f === 'DIFF-COUNTRY'
                        ? t('admin.wines.canonicalCollisions.flagDiffCountry')
                        : t('admin.wines.canonicalCollisions.flagDiffType')}
                    </span>
                  ))}
                  <button
                    type="button"
                    className="btn btn-secondary btn-small"
                    style={{ marginLeft: 'auto' }}
                    disabled={pendingKey === set.canonicalKey}
                    onClick={() => dismissSet(set)}
                    title={t('admin.wines.canonicalCollisions.dismissTitle')}
                  >
                    {pendingKey === set.canonicalKey
                      ? t('admin.wines.canonicalCollisions.dismissing')
                      : t('admin.wines.canonicalCollisions.dismiss')}
                  </button>
                </div>
                {set.wines.map(w => (
                  <div
                    key={w._id}
                    style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', padding: '0.25rem 0', borderTop: '1px solid var(--color-border)' }}
                  >
                    <span>
                      <strong>{w.producer}</strong> — {w.name}
                      {w.appellation && <em style={{ color: 'var(--color-text-muted)' }}> · {w.appellation}</em>}
                    </span>
                    <span style={{ display: 'flex', gap: 10, fontSize: '0.8rem', color: 'var(--color-text-muted)' }}>
                      {w.country && <span>{w.country}</span>}
                      <span>{w.type}</span>
                      {w.createdVia && <span>{w.createdVia}</span>}
                      <span>{t('admin.wines.canonicalCollisions.bottleCount', { count: w.bottleCount })}</span>
                    </span>
                  </div>
                ))}
              </div>
            ))}
          </div>
          <p style={{ color: 'var(--color-text-muted)', fontSize: '0.8rem', marginBottom: 0 }}>
            {t('admin.wines.canonicalCollisions.mergeHint')}
          </p>
        </>
      )}
    </Modal>
  );
}

export default WineCanonicalCollisionsModal;
