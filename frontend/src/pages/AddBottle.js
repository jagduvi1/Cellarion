import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { searchWines, findOrCreateWine, identifyWineByText } from '../api/wines';
import { CURRENCIES } from '../config/currencies';
import { monthToLastDay } from '../utils/drinkStatus';
import ImageUpload from '../components/ImageUpload';
import RatingInput from '../components/RatingInput';
import './AddBottle.css';

const WINE_TYPES = ['red', 'white', 'rosé', 'sparkling', 'dessert', 'fortified'];

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
  const [showTextSearch, setShowTextSearch] = useState(false);
  const [aiSearching, setAiSearching] = useState(false);
  const [aiSearchError, setAiSearchError] = useState(null);
  const [aiResult, setAiResult] = useState(null); // AI-found wine awaiting user confirmation
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
  const [showDetails, setShowDetails] = useState(false);

  // ── Label-scan camera ──
  const [labelCam, setLabelCam] = useState({ open: false, error: null });
  const [labelScanning, setLabelScanning] = useState(false);
  const [labelFacing, setLabelFacing] = useState('environment');
  const labelVideoRef = useRef(null);
  const labelCanvasRef = useRef(null);
  const labelStreamRef = useRef(null);

  // ── Scan result state ──
  const [scanResult, setScanResult] = useState(null);  // { extracted, match, labelImage }
  const [labelImage, setLabelImage] = useState(null);  // bg-removed data URL for display
  const [showManualForm, setShowManualForm] = useState(false);
  const [pendingWineData, setPendingWineData] = useState(null);
  const [findingWine, setFindingWine] = useState(false);

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

        if (res.ok && data.extracted) {
          stopLabelCamera();
          setScanResult(data);
          setLabelImage(data.labelImage || null);
          setShowManualForm(false);
          setPendingWineData(null);
        } else {
          stopLabelCamera();
          setError(data.error || 'Could not read label. Try again.');
        }
      } catch {
        stopLabelCamera();
        setError('Scan failed. Please try again.');
      } finally {
        setLabelScanning(false);
      }
    }, 'image/jpeg', 0.55);
  }, [apiFetch, stopLabelCamera]);

  // Confirm scan result — find/create the wine, save label image, go to bottle details
  const handleConfirmScan = useCallback(async () => {
    const { extracted, match } = scanResult;
    // If there's a match, use the matched wine's canonical data for the lookup
    // so the normalizedKey lookup on the backend is instant and correct
    const wineData = match?.wine
      ? {
          name: match.wine.name,
          producer: match.wine.producer,
          country: match.wine.country?.name || extracted.country || '',
          region: match.wine.region?.name || extracted.region || '',
          appellation: match.wine.appellation || extracted.appellation || '',
          type: match.wine.type || extracted.type || 'red',
          grapes: (match.wine.grapes || []).map(g => g.name),
          labelImage: labelImage || undefined
        }
      : {
          name: extracted.name,
          producer: extracted.producer,
          country: extracted.country || '',
          region: extracted.region || '',
          appellation: extracted.appellation || '',
          type: extracted.type || 'red',
          grapes: extracted.grapes || [],
          labelImage: labelImage || undefined
        };

    setError(null);
    setFindingWine(true);
    try {
      const res = await findOrCreateWine(apiFetch, wineData);
      const data = await res.json();
      if (!res.ok) { setError(data.error || t('addBottle.scanFailedToSaveWine')); return; }
      setSelectedWine(data.wine);
      setBottleData(prev => ({ ...prev, vintage: extracted.vintage || '' }));
      setScanResult(null);
      setLabelImage(null);
      setShowManualForm(false);
      setPendingWineData(null);
      setStep(2);
    } catch {
      setError(t('addBottle.scanFailedToSaveWine'));
    } finally {
      setFindingWine(false);
    }
  }, [apiFetch, scanResult, labelImage, t]);

  // Switch to the editable manual form (user says "not the right wine")
  const handleNotRightWine = useCallback(() => {
    const { extracted } = scanResult;
    setPendingWineData({
      name: extracted.name || '',
      producer: extracted.producer || '',
      country: extracted.country || '',
      region: extracted.region || '',
      appellation: extracted.appellation || '',
      type: extracted.type || 'red',
      grapes: (extracted.grapes || []).join(', ')
    });
    setShowManualForm(true);
  }, [scanResult]);

  // Confirm from the manual edit form
  const handleConfirmManualWine = useCallback(async () => {
    if (!pendingWineData?.name?.trim() || !pendingWineData?.producer?.trim() || !pendingWineData?.country?.trim()) {
      setError(t('addBottle.scanNameProducerCountryRequired'));
      return;
    }
    setError(null);
    setFindingWine(true);
    try {
      const grapes = pendingWineData.grapes
        ? pendingWineData.grapes.split(',').map(g => g.trim()).filter(Boolean)
        : [];
      const res = await findOrCreateWine(apiFetch, {
        ...pendingWineData,
        grapes,
        labelImage: labelImage || undefined
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || t('addBottle.scanFailedToSaveWine')); return; }
      setSelectedWine(data.wine);
      setBottleData(prev => ({ ...prev, vintage: scanResult?.extracted?.vintage || '' }));
      setScanResult(null);
      setLabelImage(null);
      setShowManualForm(false);
      setPendingWineData(null);
      setStep(2);
    } catch {
      setError(t('addBottle.scanFailedToSaveWine'));
    } finally {
      setFindingWine(false);
    }
  }, [apiFetch, pendingWineData, scanResult, labelImage, t]);

  // Reset — back to search
  const handleScanReset = useCallback(() => {
    setScanResult(null);
    setLabelImage(null);
    setShowManualForm(false);
    setPendingWineData(null);
    setError(null);
  }, []);

  // Debounce search: wait 300ms after the user stops typing before firing
  const handleSearch = useCallback(() => {
    if (!search.trim()) { setWines([]); return; }
    setLoading(true);
    setAiSearchError(null);
    searchWines(apiFetch, `search=${encodeURIComponent(search.trim())}&limit=10`)
      .then(res => res.json())
      .then(data => { if (data.wines) setWines(data.wines); })
      .catch(err => console.error('Search failed:', err))
      .finally(() => setLoading(false));
  }, [search, apiFetch]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSearchKeyDown = (e) => {
    if (e.key === 'Enter') handleSearch();
  };

  const handleAiIdentify = async () => {
    if (!search.trim()) return;
    setAiSearching(true);
    setAiSearchError(null);
    setAiResult(null);
    try {
      const res = await identifyWineByText(apiFetch, search.trim());
      const data = await res.json();
      if (!res.ok) { setAiSearchError(data.error || 'AI identification failed'); return; }
      if (!data.wine) { setAiSearchError(t('addBottle.aiCouldNotIdentify')); return; }
      setAiResult(data.wine);
    } catch {
      setAiSearchError('Network error during AI identification.');
    } finally {
      setAiSearching(false);
    }
  };

  const handleAcceptAiResult = () => {
    if (aiResult) handleSelectWine(aiResult);
  };

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
                    <span>{t('addBottle.scanReading')}</span>
                  </div>
                ) : (
                  <>
                    <div className="camera-overlay">
                      <div className="label-guide-frame" />
                      <p className="overlay-hint">{t('addBottle.scanHint')}</p>
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

      <div className="add-bottle-header">
        <Link to={`/cellars/${cellarId}`} className="back-link">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
          {t('addBottle.backToCellar')}
        </Link>
        <h1>{t('addBottle.title')}</h1>
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
          {/* ── Scan result: unified wine card ──────────────────────────── */}
          {scanResult && !showManualForm && (
            <div className="scan-wine-card">
              <div className="scan-wine-image-wrap">
                {labelImage
                  ? <img src={labelImage} alt={scanResult.extracted.name} className="scan-wine-label-img" />
                  : <div className={`wine-row-placeholder scan-wine-placeholder ${scanResult.extracted.type || 'red'}`} />
                }
              </div>
              <div className="scan-wine-body">
                <h2 className="scan-wine-name">{scanResult.extracted.name}</h2>
                <p className="scan-wine-producer">{scanResult.extracted.producer}</p>
                {scanResult.extracted.confidence != null && (
                  <div style={{ marginBottom: '0.5rem' }}>
                    <span className="scan-confidence">
                      {Math.round(scanResult.extracted.confidence * 100)}% confident
                    </span>
                  </div>
                )}
                <div className="wine-meta" style={{ marginBottom: '0.5rem' }}>
                  {scanResult.extracted.country && <span>{scanResult.extracted.country}</span>}
                  {scanResult.extracted.region && <span>• {scanResult.extracted.region}</span>}
                  {scanResult.extracted.appellation && <span>• {scanResult.extracted.appellation}</span>}
                  <span className={`wine-type-pill ${scanResult.extracted.type || 'red'}`}>
                    {scanResult.extracted.type || 'red'}
                  </span>
                </div>
                {scanResult.extracted.grapes?.length > 0 && (
                  <p className="wine-grapes">{scanResult.extracted.grapes.join(', ')}</p>
                )}
                {scanResult.extracted.vintage && (
                  <p className="scan-vintage-note">
                    {t('addBottle.scanVintageDetected', { year: scanResult.extracted.vintage })}
                  </p>
                )}
                <div className="scan-wine-actions">
                  <button
                    type="button"
                    className="btn btn-success"
                    onClick={handleConfirmScan}
                    disabled={findingWine}
                  >
                    {findingWine ? t('addBottle.scanSaving') : t('addBottle.scanConfirmWine')}
                  </button>
                  <button type="button" className="btn-not-right" onClick={handleNotRightWine}>
                    {t('addBottle.scanNotRight')}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ── Scan result: manual edit form (user said "not the right wine") ── */}
          {scanResult && showManualForm && pendingWineData && (
            <div className="scan-result-panel">
              {labelImage && (
                <div className="scan-manual-image-wrap">
                  <img src={labelImage} alt="" className="scan-manual-label-img" />
                </div>
              )}
              <div className="grid-2">
                <div className="form-group">
                  <label>{t('addBottle.scanWineName')} *</label>
                  <input type="text" value={pendingWineData.name}
                    onChange={e => setPendingWineData(p => ({ ...p, name: e.target.value }))} required />
                </div>
                <div className="form-group">
                  <label>{t('addBottle.scanProducer')} *</label>
                  <input type="text" value={pendingWineData.producer}
                    onChange={e => setPendingWineData(p => ({ ...p, producer: e.target.value }))} required />
                </div>
                <div className="form-group">
                  <label>{t('addBottle.scanCountry')} *</label>
                  <input type="text" value={pendingWineData.country}
                    onChange={e => setPendingWineData(p => ({ ...p, country: e.target.value }))} required />
                </div>
                <div className="form-group">
                  <label>{t('addBottle.scanRegion')}</label>
                  <input type="text" value={pendingWineData.region}
                    onChange={e => setPendingWineData(p => ({ ...p, region: e.target.value }))} />
                </div>
                <div className="form-group">
                  <label>{t('addBottle.scanAppellation')}</label>
                  <input type="text" value={pendingWineData.appellation}
                    onChange={e => setPendingWineData(p => ({ ...p, appellation: e.target.value }))} />
                </div>
                <div className="form-group">
                  <label>{t('addBottle.scanType')}</label>
                  <select value={pendingWineData.type}
                    onChange={e => setPendingWineData(p => ({ ...p, type: e.target.value }))}>
                    {WINE_TYPES.map(wt => <option key={wt} value={wt}>{wt}</option>)}
                  </select>
                </div>
                <div className="form-group form-group-full">
                  <label>{t('addBottle.scanGrapes')}</label>
                  <input type="text" value={pendingWineData.grapes}
                    onChange={e => setPendingWineData(p => ({ ...p, grapes: e.target.value }))}
                    placeholder={t('addBottle.scanGrapesPlaceholder')} />
                </div>
              </div>
              <div className="scan-result-actions">
                <button type="button" className="btn btn-success" onClick={handleConfirmManualWine} disabled={findingWine}>
                  {findingWine ? t('addBottle.scanSaving') : t('addBottle.scanConfirmWine')}
                </button>
                <button type="button" className="btn btn-ghost" onClick={handleScanReset}>
                  {t('addBottle.scanSearchManually')}
                </button>
              </div>
            </div>
          )}

          {/* ── Camera-first prompt ──────────────────────────────────────── */}
          {!scanResult && !showTextSearch && !labelCam.open && (
            <div className="wine-select-default">
              <div className="camera-prompt-card">
                <svg className="camera-prompt-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
                  <circle cx="12" cy="13" r="4"/>
                </svg>
                <h2>{t('addBottle.scanPromptTitle', 'Scan the wine label')}</h2>
                <p className="camera-prompt-hint">
                  {t('addBottle.scanPromptHint', 'Take a photo of the label — AI will identify the wine and add it to the registry if it doesn\'t exist yet.')}
                </p>
                <button type="button" className="btn btn-primary" onClick={startLabelCamera}>
                  {t('addBottle.startCamera', 'Start Camera')}
                </button>
              </div>
              <button type="button" className="wine-select-manual-link" onClick={() => setShowTextSearch(true)}>
                {t('addBottle.searchManuallyInstead', 'No camera? Search manually instead →')}
              </button>
            </div>
          )}

          {/* ── Manual text search ───────────────────────────────────────── */}
          {!scanResult && showTextSearch && (
            <>
              <div className="wine-select-manual-header">
                <h2>{t('addBottle.searchForWine')}</h2>
                <button type="button" className="btn-link-muted" onClick={() => { setShowTextSearch(false); setSearch(''); setWines([]); setAiSearchError(null); }}>
                  ← {t('addBottle.useCameraInstead', 'Use camera instead')}
                </button>
              </div>
              <p className="wine-search-hint">
                {t('addBottle.searchHint', 'Be as specific as possible — include the wine name and producer. We\'ll check our library first; if no match is found, AI will identify and add the wine.')}
              </p>
              <div className="search-section">
                <div className="search-input-wrapper">
                  <input
                    type="text"
                    placeholder={t('addBottle.searchPlaceholder')}
                    value={search}
                    onChange={(e) => { setSearch(e.target.value); setWines([]); setAiSearchError(null); setAiResult(null); }}
                    onKeyDown={handleSearchKeyDown}
                    className="search-input-large"
                    autoFocus
                  />
                  <button type="button" className="btn btn-secondary search-submit-btn" onClick={handleSearch} disabled={loading}>
                    {loading ? '…' : t('addBottle.searchBtn', 'Search')}
                  </button>
                </div>
              </div>

              {loading && <p>{t('addBottle.searching')}</p>}

              {/* ── AI result preview card ── */}
              {aiResult && !aiSearching && (
                <div className="ai-result-card">
                  <div className="ai-result-badge">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2a4 4 0 0 1 4 4c0 1.95-1.4 3.58-3.25 3.93L12 22"/><path d="M8 6a4 4 0 0 1 8 0"/><path d="M17 12H7"/></svg>
                    {t('addBottle.aiFoundWine')}
                  </div>
                  <div className="ai-result-wine">
                    {aiResult.image ? (
                      <div className="wine-row-img-wrap">
                        <img src={aiResult.image} alt={aiResult.name} className="wine-row-image" onError={(e) => { e.target.style.display = 'none'; }} />
                      </div>
                    ) : (
                      <div className={`wine-row-placeholder ${aiResult.type}`}></div>
                    )}
                    <div className="wine-info">
                      <h3>{aiResult.name}</h3>
                      <p className="producer">{aiResult.producer}</p>
                      <div className="wine-meta">
                        <span>{aiResult.country?.name}</span>
                        {aiResult.region && <span>• {aiResult.region.name}</span>}
                        <span className={`wine-type-pill ${aiResult.type}`}>{aiResult.type}</span>
                      </div>
                      {aiResult.grapes?.length > 0 && (
                        <p className="wine-grapes">{aiResult.grapes.map(g => g.name).join(', ')}</p>
                      )}
                    </div>
                  </div>
                  <div className="ai-result-actions">
                    <button type="button" className="btn btn-success" onClick={handleAcceptAiResult}>
                      {t('addBottle.aiUseThisWine')}
                    </button>
                    <Link to="/wine-requests" className="btn btn-ghost">
                      {t('addBottle.requestWineInstead')}
                    </Link>
                  </div>
                </div>
              )}

              {/* ── Search results list ── */}
              {!aiResult && !aiSearching && wines.length > 0 && (
                <div className="wines-list">
                  {wines.map(wine => (
                    <div key={wine._id} className="wine-row" onClick={() => handleSelectWine(wine)}>
                      {wine.image ? (
                        <div className="wine-row-img-wrap">
                          <img src={wine.image} alt={wine.name} className="wine-row-image" onError={(e) => { e.target.style.display = 'none'; }} />
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
              )}

              {/* ── "Can't find your wine?" row — appears after search when no AI result is shown ── */}
              {!loading && search.trim() && !aiResult && !aiSearching && (
                <div className="ai-search-row" onClick={!aiSearching ? handleAiIdentify : undefined}>
                  <div className="ai-search-row-icon">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                      <path d="M11 8a3 3 0 0 1 3 3" opacity="0.5"/>
                    </svg>
                  </div>
                  <div className="ai-search-row-body">
                    <span className="ai-search-row-title">{t('addBottle.cantFindAiTitle')}</span>
                    <span className="ai-search-row-hint">{t('addBottle.cantFindAiHint')}</span>
                  </div>
                  <svg className="ai-search-row-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
                </div>
              )}

              {/* ── AI searching spinner ── */}
              {aiSearching && (
                <div className="ai-searching-state">
                  <div className="ai-searching-spinner" />
                  <p>{t('addBottle.aiSearching')}</p>
                </div>
              )}

              {/* ── AI error with request fallback ── */}
              {aiSearchError && !aiSearching && (
                <div className="ai-error-state">
                  <p className="error-text">{aiSearchError}</p>
                  <Link to="/wine-requests" className="btn btn-secondary btn-small">
                    {t('addBottle.submitWineRequest')}
                  </Link>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {step === 2 && selectedWine && (
        <div className="card">
          {/* Selected wine — compact summary bar */}
          <div className="selected-wine-bar">
            {selectedWine.image && (
              <img
                src={selectedWine.image}
                alt={selectedWine.name}
                className="selected-wine-bar-img"
                onError={(e) => { e.target.style.display = 'none'; }}
              />
            )}
            <div className="selected-wine-bar-info">
              <strong className="selected-wine-bar-name">{selectedWine.name}</strong>
              <span className="selected-wine-bar-producer">{selectedWine.producer}</span>
            </div>
            <button type="button" onClick={() => setStep(1)} className="btn btn-ghost btn-small">
              {t('addBottle.changeWine')}
            </button>
          </div>

          <form onSubmit={handleSubmit}>
            {/* ── Core fields ── */}
            <div className="grid-2" style={{ marginTop: '1.25rem' }}>
              <div className="form-group">
                <label>{t('common.vintage')} *</label>
                <input
                  type="text"
                  value={bottleData.vintage}
                  onChange={(e) => setBottleData({ ...bottleData, vintage: e.target.value })}
                  placeholder={t('addBottle.vintagePlaceholder')}
                  required
                  autoFocus
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
            </div>

            {/* ── Bottle photo — compact section ── */}
            <div className="photo-section">
              <div className="photo-section-header">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="photo-section-icon">
                  <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
                  <circle cx="12" cy="13" r="4"/>
                </svg>
                <span className="photo-section-title">{t('addBottle.bottlePhotos')}</span>
              </div>
              <ImageUpload
                wineDefinitionId={selectedWine?._id}
                onUploadComplete={(img) => setUploadedImages(prev => [...prev, img])}
              />
              <p className="photo-section-notice">{t('addBottle.photosNotice')}</p>
            </div>

            {/* ── More details toggle ── */}
            <button
              type="button"
              className={`details-toggle ${showDetails ? 'details-toggle--open' : ''}`}
              onClick={() => setShowDetails(v => !v)}
            >
              <span>{showDetails ? t('addBottle.hideDetails') : t('addBottle.showDetails')}</span>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="details-toggle-chevron">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>

            {/* ── Collapsible: purchase info, notes, drink window ── */}
            {showDetails && (
              <div className="details-panel">
                <div className="grid-2">
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

                  <div className="form-group form-group-full">
                    <label>{t('addBottle.purchaseUrl')}</label>
                    <input
                      type="url"
                      value={bottleData.purchaseUrl}
                      onChange={(e) => setBottleData({ ...bottleData, purchaseUrl: e.target.value })}
                      placeholder="https://..."
                    />
                  </div>

                  <div className="form-group form-group-full">
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
                    rows="3"
                  />
                </div>

                <div className="drink-window-section">
                  <label className="form-label">{t('addBottle.drinkWindow')}</label>
                  <p className="help-text" style={{ marginTop: '0.25rem' }}>{t('addBottle.drinkWindowHint')}</p>
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

                {/* ── Add to History ── */}
                <div className="add-to-history-section">
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
              </div>
            )}

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
