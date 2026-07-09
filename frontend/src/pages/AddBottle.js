import { useState, useCallback, useRef } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { searchWines, findOrCreateWine, identifyWineByText } from '../api/wines';
import useLabelScanner from '../hooks/useLabelScanner';
import { CURRENCIES } from '../config/currencies';
import { BOTTLE_SIZES, bottleSizeLabel } from '../config/bottleSizes';
import { validatePriceSanity } from '../utils/priceValidation';
import { validateDrinkWindowFields, DRINK_YEAR_MIN, DRINK_YEAR_MAX } from '../utils/drinkStatus';
import ImageUpload from '../components/ImageUpload';
import RatingInput from '../components/RatingInput';
import WineImage from '../components/WineImage';
import SimilarWinesModal from '../components/SimilarWinesModal';
import { WINE_TYPES } from '../config/wineTypes';
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
    bottleSize: '750ml',
    purchaseDate: '',
    purchaseLocation: '',
    purchaseUrl: '',
    notes: '',
    occasion: '',
    drinkFrom: '',
    drinkTo: '',
    rating: '',
    ratingScale: user?.preferences?.ratingScale || '5',
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
  const [saving, setSaving] = useState(false);
  // Bottles already created by earlier attempts of the current submission —
  // when POST k of N fails, a retry only creates the remaining N−k instead of
  // duplicating the whole batch. Reset whenever a new wine is selected.
  const createdBottlesRef = useRef([]);
  const imagesLinkedRef = useRef(false);

  // ── Scan result state ──
  const [scanResult, setScanResult] = useState(null);  // { extracted, match, labelImage }
  const [labelImage, setLabelImage] = useState(null);  // bg-removed data URL for display
  const [showManualForm, setShowManualForm] = useState(false);
  const [pendingWineData, setPendingWineData] = useState(null);
  const [findingWine, setFindingWine] = useState(false);

  // ── Soft-zone "did you mean?" state ──
  // When the backend's find-or-create finds similar (but not auto-matching)
  // wines, it returns candidates instead of creating. We hold the user's
  // pending wineData so we can re-fire with confirmCreate: true if the
  // user picks "No, create new wine".
  const [softCandidates, setSoftCandidates] = useState(null);
  const [softPending, setSoftPending] = useState(null); // { wineData, carriedVintage }

  // ── Label-scan camera (shared hook) ──
  const handleScanSuccess = useCallback((data) => {
    setScanResult(data);
    setLabelImage(data.labelImage || null);
    setShowManualForm(false);
    setPendingWineData(null);
  }, []);

  const handleScanError = useCallback((msg) => {
    setError(msg);
  }, []);

  const {
    labelCam, labelScanning, labelFacing, setLabelFacing,
    labelVideoRef, labelCanvasRef,
    startCamera: startLabelCamera, stopCamera: stopLabelCamera, capturePhoto: captureLabelPhoto
  } = useLabelScanner(apiFetch, { onScanSuccess: handleScanSuccess, onScanError: handleScanError });

  // Apply a resolved wine (from find-or-create OR from a soft-zone pick) and
  // advance to the bottle-details step. Centralised so all entry paths share
  // the same teardown.
  const applyResolvedWine = useCallback((wine, carriedVintage) => {
    createdBottlesRef.current = [];
    imagesLinkedRef.current = false;
    setSelectedWine(wine);
    setBottleData(prev => ({ ...prev, vintage: carriedVintage || '' }));
    setScanResult(null);
    setLabelImage(null);
    setShowManualForm(false);
    setPendingWineData(null);
    setSoftCandidates(null);
    setSoftPending(null);
    setStep(2);
  }, []);

  // Submit a find-or-create request, handling the three response shapes:
  // resolved wine, soft-zone candidates, or error.
  const submitFindOrCreate = useCallback(async (wineData, carriedVintage, { confirmCreate = false } = {}) => {
    setError(null);
    setFindingWine(true);
    try {
      const res = await findOrCreateWine(apiFetch, { ...wineData, confirmCreate });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || t('addBottle.scanFailedToSaveWine'));
        return;
      }
      if (data.candidates && data.candidates.length > 0) {
        setSoftCandidates(data.candidates);
        setSoftPending({ wineData, carriedVintage });
        return;
      }
      applyResolvedWine(data.wine, carriedVintage);
    } catch {
      setError(t('addBottle.scanFailedToSaveWine'));
    } finally {
      setFindingWine(false);
    }
  }, [apiFetch, t, applyResolvedWine]);

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

    await submitFindOrCreate(wineData, extracted.vintage);
  }, [scanResult, labelImage, submitFindOrCreate]);

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
    const grapes = pendingWineData.grapes
      ? pendingWineData.grapes.split(',').map(g => g.trim()).filter(Boolean)
      : [];
    await submitFindOrCreate(
      { ...pendingWineData, grapes, labelImage: labelImage || undefined },
      scanResult?.extracted?.vintage
    );
  }, [pendingWineData, scanResult, labelImage, t, submitFindOrCreate]);

  // Reset — back to search
  const handleScanReset = useCallback(() => {
    setScanResult(null);
    setLabelImage(null);
    setShowManualForm(false);
    setPendingWineData(null);
    setError(null);
  }, []);

  // Explicit search (Enter key or button — deliberately not fired per
  // keystroke, since each search also triggers a paid AI identification).
  // Runs both fuzzy search and AI identification in parallel so the AI can
  // correctly distinguish similar wines (e.g. single vineyard vs generic).
  const handleSearch = useCallback(() => {
    if (!search.trim()) { setWines([]); return; }
    const query = search.trim();
    setLoading(true);
    setAiSearchError(null);
    setAiSearching(true);
    setAiResult(null);

    // Fuzzy search (fast)
    searchWines(apiFetch, `search=${encodeURIComponent(query)}&limit=10`)
      .then(res => res.json())
      .then(data => { if (data.wines) setWines(data.wines); })
      .catch(err => console.error('Search failed:', err))
      .finally(() => setLoading(false));

    // AI identification in parallel (slower but more accurate)
    identifyWineByText(apiFetch, query)
      .then(res => res.json())
      .then(data => {
        if (data.wine) setAiResult(data.wine);
      })
      .catch(() => { /* AI failure is non-fatal — fuzzy results still available */ })
      .finally(() => setAiSearching(false));
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
      if (!res.ok) { setAiSearchError(data.error || t('addBottle.identifyFailed')); return; }
      if (!data.wine) { setAiSearchError(t('addBottle.aiCouldNotIdentify')); return; }
      setAiResult(data.wine);
    } catch {
      setAiSearchError(t('addBottle.identifyNetworkError'));
    } finally {
      setAiSearching(false);
    }
  };

  const handleAcceptAiResult = () => {
    if (aiResult) handleSelectWine(aiResult);
  };

  const handleSelectWine = (wine) => {
    createdBottlesRef.current = [];
    imagesLinkedRef.current = false;
    setSelectedWine(wine);
    setStep(2);
  };

  // Link the uploaded images to the first created bottle. Called on full
  // success and after a partial failure, so bottles that were created keep
  // their images even when the batch didn't finish.
  const linkUploadedImages = () => {
    const first = createdBottlesRef.current[0];
    if (imagesLinkedRef.current || uploadedImages.length === 0 || !first) return;
    imagesLinkedRef.current = true;
    apiFetch('/api/images/link-to-bottle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bottleId: first._id,
        imageIds: uploadedImages.map(img => img._id)
      })
    }).catch(err => {
      imagesLinkedRef.current = false; // let a retry attempt the link again
      console.error('Failed to link images:', err);
    });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    // In-flight guard: the N sequential POSTs below leave a wide window
    // where a second submit (double-click, Enter+click) would duplicate
    // every bottle.
    if (saving) return;

    // Client-side validation for the personal drink window + occasion —
    // mirrors the backend rules (integer years 1900–2200, from ≤ to, ≤500 chars).
    const windowError = validateDrinkWindowFields(bottleData, t);
    if (windowError) { setError(windowError); return; }

    setSaving(true);
    setError(null);

    // A partial failure leaves invisible bottles behind — tell the user
    // exactly what happened and what a retry will do.
    const partialError = (msg, done) => done > 0
      ? t('addBottle.partialAdded', { msg, count: done, total: numBottles, remaining: numBottles - done })
      : msg;

    try {
      const payload = {
        cellar: cellarId,
        wineDefinition: selectedWine._id,
        ...bottleData,
        price: bottleData.price ? parseFloat(bottleData.price) : undefined,
        occasion: bottleData.occasion || undefined,
        drinkFrom: bottleData.drinkFrom ? parseInt(bottleData.drinkFrom, 10) : undefined,
        drinkTo: bottleData.drinkTo ? parseInt(bottleData.drinkTo, 10) : undefined,
        rating: bottleData.rating ? parseFloat(bottleData.rating) : undefined,
        ratingScale: bottleData.ratingScale || '5',
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

      // Create the bottle records that are still missing. createdBottlesRef
      // carries the ones a previous, partially-failed attempt already created,
      // so a retry never duplicates them.
      const createdBottles = createdBottlesRef.current;
      for (let i = createdBottles.length; i < numBottles; i++) {
        const res = await apiFetch('/api/bottles', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        const data = await res.json();
        if (!res.ok) {
          setError(partialError(data.error || t('addBottle.addFailed'), createdBottles.length));
          linkUploadedImages();
          return;
        }
        createdBottles.push(data.bottle);
      }

      // Link uploaded images to the first bottle
      linkUploadedImages();
      navigate(`/cellars/${cellarId}`);
    } catch (err) {
      setError(partialError(t('common.networkError'), createdBottlesRef.current.length));
      linkUploadedImages();
    } finally {
      setSaving(false);
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
                      <button type="button" className="camera-btn camera-btn-close" onClick={stopLabelCamera} aria-label="Close camera">✕</button>
                      <button type="button" className="camera-btn camera-btn-capture" onClick={captureLabelPhoto} aria-label="Scan label">
                        <span className="capture-ring" aria-hidden="true"></span>
                      </button>
                      <button type="button" className="camera-btn camera-btn-switch" onClick={() => setLabelFacing(f => f === 'environment' ? 'user' : 'environment')} aria-label="Switch camera">⟲</button>
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
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"/></svg>
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
                  {t('addBottle.scanPromptHint', 'Take a photo of the label — we\'ll identify the wine and add it to the registry if it doesn\'t exist yet.')}
                </p>
                <button type="button" className="btn btn-primary" data-guide="scan-label" onClick={startLabelCamera}>
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
                {t('addBottle.searchHint', 'Be as specific as possible — include the wine name and producer. We\'ll check our library first; if no match is found, we\'ll identify and add the wine.')}
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
                    <div key={wine._id} className="wine-row" onClick={() => handleSelectWine(wine)} role="button" tabIndex={0} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleSelectWine(wine); } }}>
                      <WineImage image={wine.image} alt={wine.name} className="wine-row-image" wrapClass="wine-row-img-wrap" credit={wine.imageCredit} creditClass="wine-row-credit" wineType={wine.type} placeholder="wine-row-placeholder" />
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
                <div className="ai-search-row" onClick={!aiSearching ? handleAiIdentify : undefined} role="button" tabIndex={0} onKeyDown={e => { if ((e.key === 'Enter' || e.key === ' ') && !aiSearching) { e.preventDefault(); handleAiIdentify(); } }}>
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
                  pattern="^(?:[Nn][Vv]|[Uu]nknown|(?:19|20)\d{2})$"
                  title={t('addBottle.vintagePattern')}
                  maxLength={7}
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
                  onFocus={(e) => e.target.select()}
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
                {(() => {
                  const warns = validatePriceSanity({
                    price: parseFloat(bottleData.price),
                    currency: bottleData.currency || 'USD',
                  });
                  if (warns.length === 0) return null;
                  return (
                    <ul className="price-warnings">
                      {warns.map(w => (
                        <li key={w.code} className={`price-warning price-warning--${w.severity}`}>
                          {t(`addBottle.priceWarning.${w.code}`, w.context)}
                        </li>
                      ))}
                    </ul>
                  );
                })()}
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
                  {BOTTLE_SIZES.map((s) => (
                    <option key={s.code} value={s.code}>{bottleSizeLabel(s.code, t)}</option>
                  ))}
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

                <div className="form-group">
                  <label>{t('addBottle.occasion')}</label>
                  <input
                    type="text"
                    value={bottleData.occasion}
                    onChange={(e) => setBottleData({ ...bottleData, occasion: e.target.value })}
                    placeholder={t('addBottle.occasionPlaceholder')}
                    maxLength={500}
                  />
                  <p className="help-text">{t('addBottle.occasionHint')}</p>
                </div>

                {/* ── Personal drink window ── */}
                <div className="form-group">
                  <label>{t('addBottle.drinkWindow')}</label>
                  <div className="grid-2">
                    <div className="form-group">
                      <label>{t('addBottle.drinkFrom')}</label>
                      <input
                        type="number"
                        value={bottleData.drinkFrom}
                        onChange={(e) => setBottleData({ ...bottleData, drinkFrom: e.target.value })}
                        placeholder={t('addBottle.drinkFromPlaceholder')}
                        min={DRINK_YEAR_MIN}
                        max={DRINK_YEAR_MAX}
                        step="1"
                      />
                    </div>
                    <div className="form-group">
                      <label>{t('addBottle.drinkTo')}</label>
                      <input
                        type="number"
                        value={bottleData.drinkTo}
                        onChange={(e) => setBottleData({ ...bottleData, drinkTo: e.target.value })}
                        placeholder={t('addBottle.drinkToPlaceholder')}
                        min={DRINK_YEAR_MIN}
                        max={DRINK_YEAR_MAX}
                        step="1"
                      />
                    </div>
                  </div>
                  <p className="help-text">{t('addBottle.drinkWindowHint')}</p>
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
              <button type="submit" className="btn btn-success" disabled={saving}>
                {saving ? t('common.saving', 'Saving…') : addToHistory ? t('addBottle.addToHistoryBtn') : t('addBottle.addBottleBtn')}
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

      {softCandidates && (
        <SimilarWinesModal
          candidates={softCandidates}
          queryName={softPending?.wineData?.name}
          busy={findingWine}
          onPick={(wine) => applyResolvedWine(wine, softPending?.carriedVintage)}
          onCreateNew={() => softPending && submitFindOrCreate(
            softPending.wineData, softPending.carriedVintage, { confirmCreate: true }
          )}
          onCancel={() => { setSoftCandidates(null); setSoftPending(null); }}
        />
      )}
    </div>
  );
}

export default AddBottle;
