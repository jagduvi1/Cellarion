import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { adminGetImagesByWine, adminSetOfficialImage, adminRejectImage } from '../api/admin';
import AuthImage from '../components/AuthImage';
import { API_URL } from '../api/apiConstants';

const LIMIT = 12;

// Wine-centric image curation: wines that have 2+ images to choose between,
// each shown with all its images so an admin can pick the official one, spot
// duplicates (same photo uploaded/imported more than once), and remove images.
export default function AdminImagesByWine() {
  const { t } = useTranslation();
  const { apiFetch } = useAuth();
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);
  const [confirmRejectId, setConfirmRejectId] = useState(null);
  const [error, setError] = useState(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ page: String(page), limit: String(LIMIT) });
      const res = await adminGetImagesByWine(apiFetch, params);
      const data = await res.json();
      if (res.ok) {
        setItems(data.items || []);
        setTotal(data.total || 0);
      } else {
        setError(data.error || 'Failed to load');
      }
    } catch {
      setError('Network error');
    } finally {
      setLoading(false);
    }
  }, [apiFetch, page]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // An image is the wine's official one if it's flagged assignedToWine, or its
  // file URL matches the wine's stored image (belt-and-suspenders).
  const isOfficial = (wine, img) => {
    if (img.assignedToWine) return true;
    if (!wine.image) return false;
    return wine.image === img.processedUrl || wine.image === img.originalUrl;
  };

  const setOfficial = async (img) => {
    setBusyId(img._id);
    setError(null);
    try {
      const res = await adminSetOfficialImage(apiFetch, img._id);
      const data = await res.json();
      if (res.ok) await fetchData();
      else setError(data.error || 'Failed to set official image');
    } catch {
      setError('Network error');
    } finally {
      setBusyId(null);
    }
  };

  const rejectImage = async (img) => {
    setBusyId(img._id);
    setError(null);
    try {
      const res = await adminRejectImage(apiFetch, img._id);
      if (res.ok) {
        setConfirmRejectId(null);
        await fetchData();
      } else {
        const data = await res.json();
        setError(data.error || 'Failed to remove image');
      }
    } catch {
      setError('Network error');
    } finally {
      setBusyId(null);
    }
  };

  const totalPages = Math.ceil(total / LIMIT);

  if (loading) return <div className="loading">{t('common.loading')}</div>;

  return (
    <div className="by-wine">
      {error && <div className="alert alert-error">{error}</div>}

      {items.length === 0 ? (
        <div className="empty-state"><p>{t('admin.images.byWineEmpty')}</p></div>
      ) : (
        <>
          <p className="by-wine-count">{t('admin.images.byWineCount', { count: total })}</p>

          {items.map(({ wine, images, imageCount, bottleCount }) => {
            const hasOfficial = images.some(img => isOfficial(wine, img));
            // Same photo uploaded/imported more than once → identical content hash.
            const hashCount = {};
            for (const im of images) {
              if (im.contentHash) hashCount[im.contentHash] = (hashCount[im.contentHash] || 0) + 1;
            }
            const isDup = (im) => !!im.contentHash && hashCount[im.contentHash] > 1;
            const dupCount = images.filter(isDup).length;

            return (
              <div key={wine._id} className="by-wine-card">
                <div className="by-wine-head">
                  <div className="by-wine-title">
                    <h3>{wine.name}</h3>
                    <span className="by-wine-producer">{wine.producer}</span>
                  </div>
                  <div className="by-wine-stats">
                    {wine.type && <span className={`wine-type-pill ${wine.type}`}>{wine.type}</span>}
                    <span>{t('admin.images.bottleCount', { count: bottleCount })}</span>
                    <span>{t('admin.images.imageCountLabel', { count: imageCount })}</span>
                    {dupCount > 0 && (
                      <span className="by-wine-tag by-wine-tag--dup">{t('admin.images.duplicateCount', { count: dupCount })}</span>
                    )}
                    {hasOfficial
                      ? <span className="by-wine-tag by-wine-tag--ok">{t('admin.images.officialSet')}</span>
                      : <span className="by-wine-tag by-wine-tag--warn">{t('admin.images.noOfficial')}</span>}
                  </div>
                </div>

                <div className="by-wine-gallery">
                  {images.map(img => {
                    const official = isOfficial(wine, img);
                    const dup = isDup(img);
                    const busy = busyId === img._id;
                    return (
                      <div key={img._id} className={`by-wine-img${official ? ' is-official' : ''}${dup ? ' is-dup' : ''}`}>
                        <div className="by-wine-thumb">
                          <AuthImage
                            src={`${API_URL}${img.processedUrl || img.originalUrl}`}
                            alt={wine.name}
                            onError={(e) => { e.target.style.display = 'none'; }}
                          />
                          {official && <span className="by-wine-star" title={t('admin.images.official')}>★</span>}
                          {dup && <span className="by-wine-dup-flag" title={t('admin.images.duplicateHint')}>{t('admin.images.duplicate')}</span>}
                        </div>

                        <div className="by-wine-img-meta">
                          <span className="by-wine-uploader" title={img.uploadedBy?.username || ''}>
                            {img.uploadedBy?.username || '—'}
                          </span>
                          {img.status === 'approved' ? (
                            <span className={`vis-badge vis-${img.visibility}`}>
                              {img.visibility === 'public'
                                ? t('admin.images.visPublic')
                                : t('admin.images.visUploaderOnly')}
                            </span>
                          ) : (
                            <span className={`status-badge status-${img.status}`}>{img.status}</span>
                          )}
                        </div>

                        <div className="by-wine-img-actions">
                          {confirmRejectId === img._id ? (
                            <div className="by-wine-confirm">
                              <span className="by-wine-confirm-q">{t('admin.images.removeConfirm')}</span>
                              <div className="by-wine-confirm-btns">
                                <button
                                  type="button"
                                  className="btn btn-small btn-danger"
                                  onClick={() => rejectImage(img)}
                                  disabled={busy}
                                >
                                  {busy ? t('admin.images.removing') : t('admin.images.removeYes')}
                                </button>
                                <button
                                  type="button"
                                  className="btn btn-small btn-ghost"
                                  onClick={() => setConfirmRejectId(null)}
                                  disabled={busy}
                                >
                                  {t('common.cancel', 'Cancel')}
                                </button>
                              </div>
                            </div>
                          ) : (
                            <>
                              <button
                                type="button"
                                className="btn btn-small btn-primary by-wine-set"
                                onClick={() => setOfficial(img)}
                                disabled={official || busy}
                              >
                                {official
                                  ? t('admin.images.official')
                                  : busy
                                    ? t('admin.images.processing')
                                    : t('admin.images.setOfficial')}
                              </button>
                              <button
                                type="button"
                                className="btn btn-small btn-ghost by-wine-reject"
                                onClick={() => { setConfirmRejectId(img._id); setError(null); }}
                                disabled={busy}
                              >
                                {t('admin.images.reject')}
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}

          {totalPages > 1 && (
            <div className="pagination">
              <button disabled={page <= 1} onClick={() => setPage(p => p - 1)}>Previous</button>
              <span>Page {page} of {totalPages}</span>
              <button disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>Next</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
