import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { adminGetImages, adminApproveImage, adminRejectImage, adminAssignImageToWine } from '../api/admin';
import AuthImage from '../components/AuthImage';
import './AdminImages.css';

const API_URL = process.env.REACT_APP_API_URL || '';

function AdminImages() {
  const { t } = useTranslation();
  const { apiFetch } = useAuth();
  const [images, setImages] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('processed');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState(null);
  const [assignWineId, setAssignWineId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const limit = 20;

  const statusLabels = [
    { value: 'processed', label: t('admin.images.filterReady') },
    { value: 'uploaded',  label: t('admin.images.filterUploading') },
    { value: 'approved',  label: t('admin.images.filterApproved') },
    { value: 'rejected',  label: t('admin.images.filterRejected') },
    { value: '',          label: t('admin.images.filterAll') }
  ];

  useEffect(() => {
    fetchImages();
  }, [statusFilter, page, apiFetch]);

  const fetchImages = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page, limit });
      if (statusFilter) params.append('status', statusFilter);

      const res = await adminGetImages(apiFetch, params);
      const data = await res.json();
      if (res.ok) {
        setImages(data.images);
        setTotal(data.total);
      }
    } catch (err) {
      console.error('Failed to fetch images:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleApprove = async () => {
    if (!selected) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await adminApproveImage(apiFetch, selected._id);
      const data = await res.json();
      if (res.ok) {
        setSelected(data.image);
        fetchImages();
      } else {
        setError(data.error);
      }
    } catch (err) {
      setError('Network error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleReject = async () => {
    if (!selected) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await adminRejectImage(apiFetch, selected._id);
      const data = await res.json();
      if (res.ok) {
        setSelected(data.image);
        fetchImages();
      } else {
        setError(data.error);
      }
    } catch (err) {
      setError('Network error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleAssignToWine = async () => {
    if (!selected) return;
    const wineDefId = assignWineId || selected.wineDefinition?._id;
    if (!wineDefId) {
      setError('Please enter a wine definition ID');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await adminAssignImageToWine(apiFetch, selected._id, { wineDefinitionId: wineDefId });
      const data = await res.json();
      if (res.ok) {
        setSelected(data.image);
        fetchImages();
        setAssignWineId('');
      } else {
        setError(data.error);
      }
    } catch (err) {
      setError('Network error');
    } finally {
      setSubmitting(false);
    }
  };

  const totalPages = Math.ceil(total / limit);

  return (
    <div className="admin-images-page">
      <div className="page-header">
        <h1>{t('admin.images.title')}</h1>
        <span className="image-count">{t('admin.images.image', { count: total })}</span>
      </div>

      <div className="admin-layout">
        {/* Left panel: image list */}
        <div className="images-panel">
          <div className="panel-filters">
            {statusLabels.map(s => (
              <button
                key={s.value || 'all'}
                className={`filter-btn ${statusFilter === s.value ? 'active' : ''}`}
                onClick={() => { setStatusFilter(s.value); setPage(1); }}
              >
                {s.label}
              </button>
            ))}
          </div>

          {loading ? (
            <div className="loading">{t('common.loading')}</div>
          ) : images.length === 0 ? (
            <div className="empty-state"><p>{t('admin.images.noImages')}</p></div>
          ) : (
            <>
              <div className="images-list">
                {images.map(img => (
                  <div
                    key={img._id}
                    className={`image-item ${selected?._id === img._id ? 'active' : ''}`}
                    onClick={() => { setSelected(img); setError(null); setAssignWineId(''); }}
                  >
                    <div className="image-item-thumb">
                      <AuthImage
                        src={`${API_URL}${img.processedUrl || img.originalUrl}`}
                        alt="Bottle"
                        onError={(e) => { e.target.style.display = 'none'; }}
                      />
                    </div>
                    <div className="image-item-info">
                      <div className="image-item-header">
                        <span className="image-item-wine">
                          {img.wineDefinition?.name || img.bottle?.wineDefinition?.name || t('admin.images.noWineLinked')}
                        </span>
                        <span className={`status-badge status-${img.status}`}>{img.status}</span>
                      </div>
                      <div className="image-item-meta">
                        <span>By: {img.uploadedBy?.username}</span>
                        <span>{new Date(img.createdAt).toLocaleDateString()}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {totalPages > 1 && (
                <div className="pagination">
                  <button
                    disabled={page <= 1}
                    onClick={() => setPage(p => p - 1)}
                  >
                    Previous
                  </button>
                  <span>Page {page} of {totalPages}</span>
                  <button
                    disabled={page >= totalPages}
                    onClick={() => setPage(p => p + 1)}
                  >
                    Next
                  </button>
                </div>
              )}
            </>
          )}
        </div>

        {/* Right panel: detail & actions */}
        <div className="action-panel">
          {!selected ? (
            <div className="empty-state"><p>{t('admin.images.selectImage')}</p></div>
          ) : (
            <div>
              <div className="image-detail card">
                <h2>{t('admin.images.imageDetail')}</h2>

                <div className="image-comparison">
                  <div className="image-compare-item">
                    <h3>{t('admin.images.original')}</h3>
                    <AuthImage
                      src={`${API_URL}${selected.originalUrl}`}
                      alt="Original"
                      className="detail-image"
                    />
                  </div>
                  {selected.processedUrl && (
                    <div className="image-compare-item">
                      <h3>{t('admin.images.backgroundRemoved')}</h3>
                      <div className="processed-image-container">
                        <AuthImage
                          src={`${API_URL}${selected.processedUrl}`}
                          alt="Processed"
                          className="detail-image"
                        />
                      </div>
                    </div>
                  )}
                </div>

                <div className="image-meta">
                  <p><strong>{t('admin.images.statusLabel')}</strong> <span className={`status-badge status-${selected.status}`}>{selected.status}</span></p>
                  <p><strong>{t('admin.images.uploadedBy')}</strong> {selected.uploadedBy?.username}</p>
                  <p><strong>{t('admin.images.dateLabel')}</strong> {new Date(selected.createdAt).toLocaleString()}</p>
                  {selected.wineDefinition && (
                    <p><strong>{t('admin.images.wineLabel')}</strong> {selected.wineDefinition.name} ({selected.wineDefinition.producer})</p>
                  )}
                  {selected.reviewedBy && (
                    <p><strong>{t('admin.images.reviewedBy')}</strong> {selected.reviewedBy.username} on {new Date(selected.reviewedAt).toLocaleString()}</p>
                  )}
                  {selected.assignedToWine && (
                    <p className="assigned-badge">{t('admin.images.assignedBadge')}</p>
                  )}
                </div>
              </div>

              {error && <div className="alert alert-error">{error}</div>}

              {/* Actions for processed/uploaded images */}
              {['processed', 'uploaded'].includes(selected.status) && (
                <div className="review-actions card">
                  <h3>{t('admin.images.reviewActions')}</h3>
                  <div className="form-actions">
                    <button
                      onClick={handleApprove}
                      className="btn btn-success"
                      disabled={submitting}
                    >
                      {submitting ? t('admin.images.processing') : t('admin.images.approve')}
                    </button>
                    <button
                      onClick={handleReject}
                      className="btn btn-danger"
                      disabled={submitting}
                    >
                      {t('admin.requests.reject')}
                    </button>
                  </div>
                </div>
              )}

              {/* Assign to wine for approved images */}
              {selected.status === 'approved' && !selected.assignedToWine && (
                <div className="assign-panel card">
                  <h3>{t('admin.images.assignToWine')}</h3>
                  <p className="help-text">
                    {t('admin.images.assignHint')}
                  </p>
                  {selected.wineDefinition ? (
                    <p>
                      {t('admin.images.linkedWine')} <strong>{selected.wineDefinition.name}</strong> ({selected.wineDefinition.producer})
                    </p>
                  ) : (
                    <div className="form-group">
                      <label>{t('admin.images.wineDefIdLabel')}</label>
                      <input
                        type="text"
                        value={assignWineId}
                        onChange={(e) => setAssignWineId(e.target.value)}
                        placeholder={t('admin.images.wineDefIdPlaceholder')}
                      />
                    </div>
                  )}
                  <button
                    onClick={handleAssignToWine}
                    className="btn btn-primary"
                    disabled={submitting}
                  >
                    {submitting ? t('admin.images.assigning') : t('admin.images.assignBtn')}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default AdminImages;
