import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import PhotoCapture from '../components/PhotoCapture';
import './WineRequests.css';

function WineRequests() {
  const { t } = useTranslation();
  const { apiFetch } = useAuth();
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [formData, setFormData] = useState({ wineName: '', sourceUrl: '', image: '' });
  const [imageFile, setImageFile] = useState(null);

  useEffect(() => {
    fetchRequests();
  }, [apiFetch]);

  const fetchRequests = async () => {
    try {
      const res = await apiFetch('/api/wine-requests');
      const data = await res.json();
      if (res.ok) setRequests(data.requests);
    } catch (err) {
      console.error('Failed to fetch requests:', err);
    } finally {
      setLoading(false);
    }
  };

  const clearImage = () => {
    setImageFile(null);
  };

  const compressImage = (file) => {
    return new Promise((resolve) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        const MAX = 900;
        let w = img.naturalWidth;
        let h = img.naturalHeight;
        if (w > MAX || h > MAX) {
          if (w > h) { h = Math.round(h * MAX / w); w = MAX; }
          else { w = Math.round(w * MAX / h); h = MAX; }
        }
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL('image/jpeg', 0.82));
      };
      img.src = url;
    });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      let imageValue = formData.image || null;
      if (imageFile) {
        imageValue = await compressImage(imageFile);
      }
      const res = await apiFetch('/api/wine-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...formData, image: imageValue })
      });
      if (res.ok) {
        setFormData({ wineName: '', sourceUrl: '', image: '' });
        clearImage();
        setShowForm(false);
        fetchRequests();
      }
    } catch (err) {
      alert('Failed to submit request');
    }
  };

  const handleCancel = () => {
    clearImage();
    setFormData({ wineName: '', sourceUrl: '', image: '' });
    setShowForm(false);
  };

  return (
    <div className="wine-requests-page">
      <div className="page-header">
        <h1>{t('wineRequests.title')}</h1>
        <button onClick={() => setShowForm(!showForm)} className="btn btn-primary">
          {showForm ? t('common.cancel') : t('wineRequests.newRequest')}
        </button>
      </div>

      {showForm && (
        <div className="card">
          <h2>{t('wineRequests.requestTitle')}</h2>
          <form onSubmit={handleSubmit}>
            <div className="form-group">
              <label>{t('wineRequests.wineNameLabel')}</label>
              <input
                type="text"
                value={formData.wineName}
                onChange={(e) => setFormData({ ...formData, wineName: e.target.value })}
                required
                placeholder={t('wineRequests.wineNamePlaceholder')}
              />
            </div>
            <div className="form-group">
              <label>{t('wineRequests.sourceUrlLabel')}</label>
              <input
                type="url"
                value={formData.sourceUrl}
                onChange={(e) => setFormData({ ...formData, sourceUrl: e.target.value })}
                required
                placeholder="https://..."
              />
            </div>

            {/* Image field */}
            <div className="form-group">
              <label>{t('wineRequests.imageLabel', 'Image')} <span className="label-optional">({t('common.optional', 'optional')})</span></label>

              <PhotoCapture
                onCapture={(file) => {
                  setImageFile(file);
                  setFormData(prev => ({ ...prev, image: '' }));
                }}
                onRemove={clearImage}
              />
              {!imageFile && (
                <div className="image-input-row" style={{ marginTop: '0.5rem' }}>
                  <span className="image-or">{t('common.or', 'or')}</span>
                  <input
                    type="url"
                    value={formData.image}
                    onChange={(e) => setFormData({ ...formData, image: e.target.value })}
                    placeholder={t('wineRequests.imageUrlPlaceholder', 'Paste image URL…')}
                    className="image-url-input"
                  />
                </div>
              )}

              <p className="image-public-notice">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0, marginTop: '1px' }}>
                  <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
                </svg>
                {t('wineRequests.imageNotice', 'Images are reviewed by an admin before being added to the shared wine registry, where they will be visible to all Cellarion users.')}
              </p>
            </div>

            <div className="form-actions">
              <button type="submit" className="btn btn-success">{t('wineRequests.submitRequest')}</button>
              <button type="button" onClick={handleCancel} className="btn btn-secondary">
                {t('common.cancel')}
              </button>
            </div>
          </form>
        </div>
      )}

      {loading ? (
        <div className="loading">{t('wineRequests.loadingRequests')}</div>
      ) : requests.length === 0 ? (
        <div className="empty-state">
          <p>{t('wineRequests.noRequests')}</p>
        </div>
      ) : (
        <div className="requests-list">
          {requests.map(request => (
            <div key={request._id} className="request-card">
              <div className="request-header">
                <h3>{request.wineName}</h3>
                <span className={`status-badge status-${request.status}`}>
                  {request.status}
                </span>
              </div>
              <p><strong>{t('common.source')}:</strong> <a href={request.sourceUrl} target="_blank" rel="noopener noreferrer">
                {request.sourceUrl}
              </a></p>
              {request.status === 'resolved' && request.linkedWineDefinition && (
                <div className="resolution">
                  <strong>{t('wineRequests.linkedTo')}</strong> {request.linkedWineDefinition.name} by {request.linkedWineDefinition.producer}
                </div>
              )}
              {request.adminNotes && (
                <div className="admin-notes">
                  <strong>{t('wineRequests.adminNotes')}</strong> {request.adminNotes}
                </div>
              )}
              <div className="request-footer">
                <small>{t('wineRequests.submitted', { date: new Date(request.createdAt).toLocaleDateString() })}</small>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default WineRequests;
