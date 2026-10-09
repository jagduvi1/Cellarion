import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import PhotoCapture from '../components/PhotoCapture';
import { requestImageFor } from '../utils/requestImage';
import './WineRequests.css';

// Links a request may carry (#1460): the required source plus two more — a
// winery page and a review give the reviewer different evidence. The same
// bound as the server's (services/accountOps MAX_SOURCE_URLS).
const MAX_LINKS = 3;

// Every link of a request, oldest requests only knowing one.
const linksOf = (request) => (Array.isArray(request.sourceUrls) && request.sourceUrls.length
  ? request.sourceUrls
  : [request.sourceUrl]).filter(Boolean);

const EMPTY_FORM = { wineName: '', sourceUrl: '', image: '' };

function WineRequests() {
  const { t } = useTranslation();
  const { apiFetch } = useAuth();
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [formData, setFormData] = useState(EMPTY_FORM);
  const [extraUrls, setExtraUrls] = useState([]);
  const [imageFile, setImageFile] = useState(null);
  const [imageBgRemoved, setImageBgRemoved] = useState(null);
  const [processingBg, setProcessingBg] = useState(false);
  // The back label (#1460): a photo or a link, like the front, but it is
  // evidence for the reviewer, not a picture of the wine — no background
  // removal, nothing of it reaches the registry.
  const [backImageFile, setBackImageFile] = useState(null);
  const [backImageUrl, setBackImageUrl] = useState('');

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
    setImageBgRemoved(null);
    setProcessingBg(false);
  };

  const resetForm = () => {
    clearImage();
    setBackImageFile(null);
    setBackImageUrl('');
    setExtraUrls([]);
    setFormData(EMPTY_FORM);
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

  const removeBgPreview = async (file) => {
    setProcessingBg(true);
    setImageBgRemoved(null);
    try {
      const compressed = await compressImage(file);
      const res = await apiFetch('/api/images/remove-bg-preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: compressed })
      });
      if (res.ok) {
        const data = await res.json();
        setImageBgRemoved(data.processedImage);
      }
    } catch (err) {
      console.error('BG removal preview failed:', err);
    } finally {
      setProcessingBg(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      let imageValue = formData.image || null;
      if (imageFile) {
        // The background-removed preview (or the photo itself), re-encoded to
        // fit the server's cap — a raw PNG preview often did not (utils/requestImage).
        imageValue = await requestImageFor({ preview: imageBgRemoved, file: imageFile });
        if (!imageValue) {
          alert(t('wineRequests.photoTooLarge'));
          return;
        }
      }
      let backImageValue = backImageUrl.trim() || null;
      if (backImageFile) {
        backImageValue = await requestImageFor({ file: backImageFile });
        if (!backImageValue) {
          alert(t('wineRequests.photoTooLarge'));
          return;
        }
      }
      // sourceUrl stays the first link for the server and for older installs
      // that forward it; sourceUrls carries every link in the user's order.
      const sourceUrls = [formData.sourceUrl, ...extraUrls].map((u) => u.trim()).filter(Boolean);
      const res = await apiFetch('/api/wine-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...formData, sourceUrls, image: imageValue, backImage: backImageValue })
      });
      if (res.ok) {
        resetForm();
        setShowForm(false);
        fetchRequests();
      } else {
        // Say WHY: the server names the problem (a URL it refuses, a photo
        // it cannot read); a bare "failed" left the user nothing to fix.
        const data = await res.json().catch(() => ({}));
        alert(data.error ? t('wineRequests.submitFailedReason', { reason: data.error }) : t('wineRequests.submitFailed'));
      }
    } catch (err) {
      alert(t('wineRequests.submitFailed'));
    }
  };

  const handleCancel = () => {
    resetForm();
    setShowForm(false);
  };

  const setExtraUrl = (index, value) => setExtraUrls(extraUrls.map((u, i) => (i === index ? value : u)));
  const removeExtraUrl = (index) => setExtraUrls(extraUrls.filter((_, i) => i !== index));

  return (
    <div className="wine-requests-page">
      <div className="winerequest-header">
        <h1>{t('wineRequests.title')}</h1>
        <button onClick={() => setShowForm(!showForm)} className="btn btn-primary winerequest-desktop-create">
          {showForm ? t('common.cancel') : `+ ${t('wineRequests.newRequest')}`}
        </button>
      </div>

      <button className="fab winerequest-fab" onClick={() => setShowForm(!showForm)} aria-label="New Request">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      </button>

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

            {/* More links (#1460): a winery page AND a review, each worth having */}
            <div className="form-group">
              <label>{t('wineRequests.moreLinksLabel', 'More links')} <span className="label-optional">({t('common.optional', 'optional')})</span></label>
              <p className="field-hint">{t('wineRequests.linksHint', 'A winery page and a review each give the reviewer something different.')}</p>
              {extraUrls.map((url, index) => (
                <div className="extra-link-row" key={index}>
                  <input
                    type="url"
                    value={url}
                    onChange={(e) => setExtraUrl(index, e.target.value)}
                    placeholder="https://..."
                    aria-label={`${t('wineRequests.moreLinksLabel', 'More links')} ${index + 2}`}
                  />
                  <button type="button" className="btn btn-secondary btn-small" onClick={() => removeExtraUrl(index)}>
                    {t('wineRequests.removeLink', 'Remove')}
                  </button>
                </div>
              ))}
              {extraUrls.length < MAX_LINKS - 1 && (
                <button type="button" className="btn btn-secondary btn-small" onClick={() => setExtraUrls([...extraUrls, ''])}>
                  + {t('wineRequests.addLink', 'Add another link')}
                </button>
              )}
            </div>

            {/* Image field */}
            <div className="form-group">
              <label>{t('wineRequests.imageLabel', 'Image')} <span className="label-optional">({t('common.optional', 'optional')})</span></label>

              <PhotoCapture
                onCapture={(file) => {
                  setImageFile(file);
                  setFormData(prev => ({ ...prev, image: '' }));
                  removeBgPreview(file);
                }}
                onRemove={clearImage}
                processedUrl={imageBgRemoved}
                processing={processingBg}
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

            {/* Back label (#1460): evidence for the reviewer, never the wine's picture */}
            <div className="form-group">
              <label>{t('wineRequests.backImageLabel', 'Back label')} <span className="label-optional">({t('common.optional', 'optional')})</span></label>
              <p className="field-hint">{t('wineRequests.backImageHint', 'The back label often names the producer, the appellation and the importer.')}</p>
              <PhotoCapture
                onCapture={(file) => {
                  setBackImageFile(file);
                  setBackImageUrl('');
                }}
                onRemove={() => setBackImageFile(null)}
                processedUrl={null}
                processing={false}
              />
              {!backImageFile && (
                <div className="image-input-row" style={{ marginTop: '0.5rem' }}>
                  <span className="image-or">{t('common.or', 'or')}</span>
                  <input
                    type="url"
                    value={backImageUrl}
                    onChange={(e) => setBackImageUrl(e.target.value)}
                    placeholder={t('wineRequests.imageUrlPlaceholder', 'Paste image URL…')}
                    className="image-url-input"
                  />
                </div>
              )}
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
                <div className="request-title-row">
                  <h3>{request.wineName}</h3>
                  {request.requestType === 'grape_suggestion' && (
                    <span className="request-type-badge">{t('wineRequests.grapeSuggestion', 'Grape suggestion')}</span>
                  )}
                </div>
                <span className={`status-badge status-${request.status}`}>
                  {request.status}
                </span>
              </div>
              {request.requestType === 'grape_suggestion' ? (
                request.suggestedGrapes?.length > 0 && (
                  <p className="request-grapes">
                    <strong>{t('wineRequests.suggestedGrapes', 'Suggested')}: </strong>
                    {request.suggestedGrapes.join(', ')}
                  </p>
                )
              ) : (
                <p className="request-links"><strong>{t('common.source')}:</strong>{' '}
                  {linksOf(request).map((url, index) => (
                    <span key={url}>
                      {index > 0 && ' · '}
                      <a href={url} target="_blank" rel="noopener noreferrer">{url}</a>
                    </span>
                  ))}
                </p>
              )}
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
