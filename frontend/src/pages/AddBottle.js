import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { searchWines } from '../api/wines';
import { CURRENCIES } from '../config/currencies';
import { monthToLastDay } from '../utils/drinkStatus';
import ImageUpload from '../components/ImageUpload';
import RatingInput from '../components/RatingInput';
import './AddBottle.css';

function AddBottle() {
  const { t } = useTranslation();
  const { id: cellarId } = useParams();
  const { apiFetch, user } = useAuth();
  const navigate = useNavigate();
  const [step, setStep] = useState(1); // 1 = select wine, 2 = enter details
  const [wines, setWines] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [selectedWine, setSelectedWine] = useState(null);
  const [numBottles, setNumBottles] = useState(1);
  const [bottleData, setBottleData] = useState({
    vintage: '',
    price: '',
    currency: user?.preferences?.currency || 'USD',
    bottleSize: '750ml (Standard)',
    purchaseDate: '',
    purchaseLocation: '',
    purchaseUrl: '',
    notes: '',
    rating: '',
    ratingScale: user?.preferences?.ratingScale || '5',
    drinkFrom: '',
    drinkBefore: '',
    dateAdded: ''
  });
  const [addToHistory, setAddToHistory] = useState(false);
  const [historyData, setHistoryData] = useState({
    consumedAt: '',
    consumedReason: 'drank',
    consumedNote: '',
    consumedRating: '',
    consumedRatingScale: user?.preferences?.ratingScale || '5'
  });
  const [uploadedImages, setUploadedImages] = useState([]);

  // ── Label-scan camera ──
  const [labelCam, setLabelCam] = useState({ open: false, error: null });
  const [labelScanning, setLabelScanning] = useState(false);
  const [labelFacing, setLabelFacing] = useState('environment');
  const labelVideoRef = useRef(null);
  const labelCanvasRef = useRef(null);
  const labelStreamRef = useRef(null);

  const stopLabelCamera = useCallback(() => {
    if (labelStreamRef.current) {
      labelStreamRef.current.getTracks().forEach(t => t.stop());
      labelStreamRef.current = null;
    }
    setLabelCam({ open: false, error: null });
  }, []);

  const startLabelCamera = useCallback(async () => {
    setLabelCam({ open: true, error: null });
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: labelFacing, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false
      });
      labelStreamRef.current = stream;
      requestAnimationFrame(() => {
        if (labelVideoRef.current) labelVideoRef.current.srcObject = stream;
      });
    } catch (err) {
      let msg = 'Could not access camera.';
      if (err.name === 'NotAllowedError') msg = 'Camera access denied. Please allow camera permissions.';
      else if (err.name === 'NotFoundError') msg = 'No camera found on this device.';
      setLabelCam({ open: true, error: msg });
    }
  }, [labelFacing]);

  // Restart camera when facing mode changes while camera is open
  useEffect(() => {
    if (labelCam.open && !labelCam.error) {
      if (labelStreamRef.current) labelStreamRef.current.getTracks().forEach(t => t.stop());
      startLabelCamera();
    }
  }, [labelFacing]); // eslint-disable-line react-hooks/exhaustive-deps

  // Stop camera on unmount
  useEffect(() => {
    return () => {
      if (labelStreamRef.current) labelStreamRef.current.getTracks().forEach(t => t.stop());
    };
  }, []);

  const captureLabelPhoto = useCallback(async () => {
    const video = labelVideoRef.current;
    const canvas = labelCanvasRef.current;
    if (!video || !canvas) return;

    // Resize to max 800px to keep API cost low
    const MAX_DIM = 800;
    let vw = video.videoWidth;
    let vh = video.videoHeight;
    if (vw > MAX_DIM || vh > MAX_DIM) {
      if (vw >= vh) { vh = Math.round((vh / vw) * MAX_DIM); vw = MAX_DIM; }
      else { vw = Math.round((vw / vh) * MAX_DIM); vh = MAX_DIM; }
    }
    canvas.width = vw;
    canvas.height = vh;
    canvas.getContext('2d').drawImage(video, 0, 0, vw, vh);

    // Stop the stream right after capture
    if (labelStreamRef.current) {
      labelStreamRef.current.getTracks().forEach(t => t.stop());
      labelStreamRef.current = null;
    }
    setLabelScanning(true);

    canvas.toBlob(async (blob) => {
      if (!blob) {
        setLabelCam({ open: true, error: 'Capture failed. Please try again.' });
        setLabelScanning(false);
        return;
      }
      try {
        const base64 = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result.split(',')[1]);
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(blob);
        });

        const res = await apiFetch('/api/wines/scan-label', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image: base64, mediaType: 'image/jpeg' })
        });
        const data = await res.json();
        if (res.ok && data.query) {
          setSearch(data.query);
          stopLabelCamera();
        } else {
          setLabelCam({ open: true, error: data.error || 'Could not read label. Try again.' });
        }
      } catch {
        setLabelCam({ open: true, error: 'Scan failed. Please try again.' });
      } finally {
        setLabelScanning(false);
      }
    }, 'image/jpeg', 0.55);
  }, [apiFetch, stopLabelCamera]);

  // Debounce search: wait 300ms after the user stops typing before firing
  useEffect(() => {
    if (search.length === 0) { setWines([]); return; }
    const timer = setTimeout(() => {
      setLoading(true);
      searchWines(apiFetch, `search=${encodeURIComponent(search)}&limit=10`)
        .then(res => res.json())
        .then(data => { if (data.wines) setWines(data.wines); })
        .catch(err => console.error('Search failed:', err))
        .finally(() => setLoading(false));
    }, 300);
    return () => clearTimeout(timer);
  }, [search]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSelectWine = (wine) => {
    setSelectedWine(wine);
    setStep(2);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);

    try {
      const payload = {
        cellar: cellarId,
        wineDefinition: selectedWine._id,
        ...bottleData,
        price: bottleData.price ? parseFloat(bottleData.price) : undefined,
        rating: bottleData.rating ? parseFloat(bottleData.rating) : undefined,
        ratingScale: bottleData.ratingScale || '5',
        drinkFrom:   bottleData.drinkFrom   ? `${bottleData.drinkFrom}-01`          : undefined,
        drinkBefore: bottleData.drinkBefore ? monthToLastDay(bottleData.drinkBefore) : undefined,
        dateAdded: bottleData.dateAdded || undefined,
        addToHistory: addToHistory || undefined,
        ...(addToHistory ? {
          consumedAt: historyData.consumedAt || undefined,
          consumedReason: historyData.consumedReason,
          consumedNote: historyData.consumedNote || undefined,
          consumedRating: historyData.consumedRating ? parseFloat(historyData.consumedRating) : undefined,
          consumedRatingScale: historyData.consumedRatingScale || '5'
        } : {})
      };

      // Create N individual bottle records
      const createdBottles = [];
      for (let i = 0; i < numBottles; i++) {
        const res = await apiFetch('/api/bottles', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        const data = await res.json();
        if (!res.ok) {
          setError(data.error || 'Failed to add bottle');
          return;
        }
        createdBottles.push(data.bottle);
      }

      // Link uploaded images to the first bottle
      if (uploadedImages.length > 0 && createdBottles.length > 0) {
        apiFetch('/api/images/link-to-bottle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            bottleId: createdBottles[0]._id,
            imageIds: uploadedImages.map(img => img._id)
          })
        }).catch(err => console.error('Failed to link images:', err));
      }
      navigate(`/cellars/${cellarId}`);
    } catch (err) {
      setError('Network error');
    }
  };

  return (
    <div className="add-bottle-page">
      {/* Label-scan camera modal */}
      {labelCam.open && (
        <div className="camera-modal">
          <div className="camera-container">
            {labelCam.error ? (
              <div className="camera-error-overlay">
                <p>{labelCam.error}</p>
                <button type="button" className="btn btn-secondary" onClick={stopLabelCamera}>Close</button>
              </div>
            ) : (
              <>
                <video ref={labelVideoRef} autoPlay playsInline muted className="camera-video" />
                {labelScanning ? (
                  <div className="label-scan-overlay">
                    <div className="label-scan-spinner" />
                    <span>Reading label…</span>
                  </div>
                ) : (
                  <>
                    <div className="camera-overlay">
                      <p className="overlay-hint">Point at the wine label</p>
                    </div>
                    <div className="camera-controls">
                      <button type="button" className="camera-btn camera-btn-close" onClick={stopLabelCamera} title="Close">✕</button>
                      <button type="button" className="camera-btn camera-btn-capture" onClick={captureLabelPhoto} title="Scan Label">
                        <span className="capture-ring"></span>
                      </button>
                      <button type="button" className="camera-btn camera-btn-switch" onClick={() => setLabelFacing(f => f === 'environment' ? 'user' : 'environment')} title="Switch Camera">⟲</button>
                    </div>
                  </>
                )}
              </>
            )}
          </div>
          <canvas ref={labelCanvasRef} style={{ display: 'none' }} />
        </div>
      )}
      <div className="page-header">
        <div>
          <Link to={`/cellars/${cellarId}`} className="back-link">{t('addBottle.backToCellar')}</Link>
          <h1>{t('addBottle.title')}</h1>
        </div>
      </div>

      <div className="steps-indicator">
        <div className={`step ${step >= 1 ? 'active' : ''}`}>
          <div className="step-number">1</div>
          <span>{t('addBottle.stepSelectWine')}</span>
        </div>
        <div className="step-divider"></div>
        <div className={`step ${step >= 2 ? 'active' : ''}`}>
          <div className="step-number">2</div>
          <span>{t('addBottle.stepBottleDetails')}</span>
        </div>
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      {step === 1 && (
        <div className="card">
          <h2>{t('addBottle.searchForWine')}</h2>
          <div className="search-section">
            <div className="search-input-wrapper">
              <input
                type="text"
                placeholder={t('addBottle.searchPlaceholder')}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="search-input-large search-input-with-camera"
                autoFocus
              />
              <button
                type="button"
                className="search-camera-btn"
                onClick={startLabelCamera}
                disabled={labelCam.open}
                title="Scan wine label with camera"
                aria-label="Scan wine label with camera"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
                  <circle cx="12" cy="13" r="4"/>
                </svg>
              </button>
            </div>
            <p className="help-text">
              {t('addBottle.cantFindWine')} <Link to="/wine-requests">{t('addBottle.requestNewWine')}</Link>
            </p>
          </div>

          {loading && <p>{t('addBottle.searching')}</p>}

          {!loading && wines.length === 0 && (
            <div className="empty-state">
              <p>{search.length > 0 ? t('addBottle.noWinesMatched') : t('addBottle.startTyping')}</p>
            </div>
          )}

          {wines.length > 0 && (
            <>
              <div className="wines-list">
                {wines.map(wine => (
                  <div key={wine._id} className="wine-row" onClick={() => handleSelectWine(wine)}>
                    {wine.image ? (
                      <div className="wine-row-img-wrap">
                        <img
                          src={wine.image}
                          alt={wine.name}
                          className="wine-row-image"
                          onError={(e) => { e.target.style.display = 'none'; }}
                        />
                        {wine.imageCredit && <span className="wine-row-credit">{wine.imageCredit}</span>}
                      </div>
                    ) : (
                      <div className={`wine-row-placeholder ${wine.type}`}></div>
                    )}
                    <div className="wine-info">
                      <h3>{wine.name}</h3>
                      <p className="producer">{wine.producer}</p>
                      <div className="wine-meta">
                        <span>{wine.country?.name}</span>
                        {wine.region && <span>• {wine.region.name}</span>}
                        <span className={`wine-type-pill ${wine.type}`}>{wine.type}</span>
                      </div>
                      {wine.grapes?.length > 0 && (
                        <p className="wine-grapes">{wine.grapes.map(g => g.name).join(', ')}</p>
                      )}
                    </div>
                    <button className="btn btn-primary btn-small">{t('addBottle.selectBtn')}</button>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {step === 2 && selectedWine && (
        <div className="card">
          <div className="selected-wine">
            <h3>{t('addBottle.selectedWine')}</h3>
            <div className="wine-summary">
              {selectedWine.image && (
                <img
                  src={selectedWine.image}
                  alt={selectedWine.name}
                  className="selected-wine-image"
                  onError={(e) => { e.target.style.display = 'none'; }}
                />
              )}
              <div>
                <strong>{selectedWine.name}</strong>
                <span> by {selectedWine.producer}</span>
              </div>
              <button onClick={() => setStep(1)} className="btn btn-secondary btn-small">
                {t('addBottle.changeWine')}
              </button>
            </div>
          </div>

          <h2>{t('addBottle.bottleDetails')}</h2>
          <form onSubmit={handleSubmit}>
            <div className="grid-2">
              <div className="form-group">
                <label>{t('common.vintage')} *</label>
                <input
                  type="text"
                  value={bottleData.vintage}
                  onChange={(e) => setBottleData({ ...bottleData, vintage: e.target.value })}
                  placeholder={t('addBottle.vintagePlaceholder')}
                  required
                />
              </div>

              <div className="form-group">
                <label>{t('addBottle.numberOfBottles')}</label>
                <input
                  type="number"
                  value={numBottles}
                  onChange={(e) => setNumBottles(Math.max(1, parseInt(e.target.value) || 1))}
                  min="1"
                  required
                />
              </div>

              <div className="form-group">
                <label>{t('common.price')}</label>
                <input
                  type="number"
                  step="0.01"
                  value={bottleData.price}
                  onChange={(e) => setBottleData({ ...bottleData, price: e.target.value })}
                  placeholder="0.00"
                />
              </div>

              <div className="form-group">
                <label>{t('common.currency')}</label>
                <select
                  value={bottleData.currency}
                  onChange={(e) => setBottleData({ ...bottleData, currency: e.target.value })}
                >
                  {CURRENCIES.map(c => <option key={c}>{c}</option>)}
                </select>
              </div>

              <div className="form-group">
                <label>{t('addBottle.bottleSize')}</label>
                <select
                  value={bottleData.bottleSize}
                  onChange={(e) => setBottleData({ ...bottleData, bottleSize: e.target.value })}
                >
                  <option>375ml (Half)</option>
                  <option>750ml (Standard)</option>
                  <option>1.5L (Magnum)</option>
                  <option>3L (Double Magnum)</option>
                </select>
              </div>

              <div className="form-group">
                <label>{t('addBottle.ratingLabel')}</label>
                <RatingInput
                  value={bottleData.rating}
                  scale={bottleData.ratingScale}
                  onChange={v => setBottleData({ ...bottleData, rating: v ?? '' })}
                  onScaleChange={s => setBottleData({ ...bottleData, ratingScale: s, rating: '' })}
                  allowScaleOverride
                />
              </div>

              <div className="form-group">
                <label>{t('addBottle.purchaseDate')}</label>
                <input
                  type="date"
                  value={bottleData.purchaseDate}
                  onChange={(e) => setBottleData({ ...bottleData, purchaseDate: e.target.value })}
                />
              </div>

              <div className="form-group">
                <label>{t('addBottle.purchaseLocation')}</label>
                <input
                  type="text"
                  value={bottleData.purchaseLocation}
                  onChange={(e) => setBottleData({ ...bottleData, purchaseLocation: e.target.value })}
                  placeholder={t('addBottle.purchaseLocationPlaceholder')}
                />
              </div>

              <div className="form-group">
                <label>{t('addBottle.purchaseUrl')}</label>
                <input
                  type="url"
                  value={bottleData.purchaseUrl}
                  onChange={(e) => setBottleData({ ...bottleData, purchaseUrl: e.target.value })}
                  placeholder="https://..."
                />
              </div>

              <div className="form-group">
                <label>{t('addBottle.dateAdded')}</label>
                <input
                  type="date"
                  value={bottleData.dateAdded}
                  onChange={(e) => setBottleData({ ...bottleData, dateAdded: e.target.value })}
                />
                <p className="help-text">{t('addBottle.dateAddedHint')}</p>
              </div>
            </div>

            <div className="form-group">
              <label>{t('common.notes')}</label>
              <textarea
                value={bottleData.notes}
                onChange={(e) => setBottleData({ ...bottleData, notes: e.target.value })}
                placeholder={t('addBottle.notesPlaceholder')}
                rows="4"
              />
            </div>

            <div className="form-group drink-window-section">
              <label>{t('addBottle.drinkWindow')}</label>
              <p className="help-text">
                {t('addBottle.drinkWindowHint')}
              </p>
              <div className="drink-window-fields">
                <div>
                  <label className="sublabel">{t('addBottle.drinkFrom')}</label>
                  <input
                    type="month"
                    value={bottleData.drinkFrom}
                    onChange={(e) => setBottleData({ ...bottleData, drinkFrom: e.target.value })}
                  />
                </div>
                <div>
                  <label className="sublabel">{t('addBottle.drinkBefore')}</label>
                  <input
                    type="month"
                    value={bottleData.drinkBefore}
                    onChange={(e) => setBottleData({ ...bottleData, drinkBefore: e.target.value })}
                  />
                </div>
              </div>
            </div>

            <div className="form-group add-to-history-section">
              <label className="toggle-label">
                <input
                  type="checkbox"
                  checked={addToHistory}
                  onChange={(e) => setAddToHistory(e.target.checked)}
                />
                <span>{t('addBottle.addToHistory')}</span>
              </label>
              <p className="help-text">{t('addBottle.addToHistoryHint')}</p>

              {addToHistory && (
                <div className="history-fields">
                  <div className="grid-2">
                    <div className="form-group">
                      <label>{t('addBottle.consumedReason')}</label>
                      <select
                        value={historyData.consumedReason}
                        onChange={(e) => setHistoryData({ ...historyData, consumedReason: e.target.value })}
                      >
                        <option value="drank">{t('history.reasonDrank')}</option>
                        <option value="gifted">{t('history.reasonGifted')}</option>
                        <option value="sold">{t('history.reasonSold')}</option>
                        <option value="other">{t('history.reasonOther')}</option>
                      </select>
                    </div>

                    <div className="form-group">
                      <label>{t('addBottle.consumedDate')}</label>
                      <input
                        type="date"
                        value={historyData.consumedAt}
                        onChange={(e) => setHistoryData({ ...historyData, consumedAt: e.target.value })}
                      />
                    </div>

                    <div className="form-group">
                      <label>{t('addBottle.consumedRating')}</label>
                      <RatingInput
                        value={historyData.consumedRating}
                        scale={historyData.consumedRatingScale}
                        onChange={v => setHistoryData({ ...historyData, consumedRating: v ?? '' })}
                        onScaleChange={s => setHistoryData({ ...historyData, consumedRatingScale: s, consumedRating: '' })}
                        allowScaleOverride
                      />
                    </div>
                  </div>

                  <div className="form-group">
                    <label>{t('addBottle.consumedNote')}</label>
                    <textarea
                      value={historyData.consumedNote}
                      onChange={(e) => setHistoryData({ ...historyData, consumedNote: e.target.value })}
                      placeholder={t('addBottle.consumedNotePlaceholder')}
                      rows="3"
                    />
                  </div>
                </div>
              )}
            </div>

            <div className="form-group">
              <label>{t('addBottle.bottlePhotos')}</label>
              <p className="help-text">
                {t('addBottle.photosHint')}
              </p>
              <ImageUpload
                wineDefinitionId={selectedWine?._id}
                onUploadComplete={(img) => setUploadedImages(prev => [...prev, img])}
              />
              <p className="image-public-notice">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0, marginTop: '1px' }}>
                  <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
                </svg>
                {t('addBottle.photosNotice')}
              </p>
            </div>

            <div className="form-actions">
              <button type="submit" className="btn btn-success">
                {addToHistory ? t('addBottle.addToHistoryBtn') : t('addBottle.addBottleBtn')}
              </button>
              <button
                type="button"
                onClick={() => navigate(`/cellars/${cellarId}`)}
                className="btn btn-secondary"
              >
                {t('common.cancel')}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

export default AddBottle;
