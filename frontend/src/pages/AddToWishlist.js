import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { searchWines, findOrCreateWine, identifyWineByText } from '../api/wines';
import { addToWishlist } from '../api/wishlist';
import '../components/ImageUpload.css';
import './AddBottle.css';
import './AddToWishlist.css';

const WINE_TYPES = ['red', 'white', 'rosé', 'sparkling', 'dessert', 'fortified'];

function AddToWishlist() {
  const { apiFetch } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);

  // ── Wine selection ──
  const [selectedWine, setSelectedWine] = useState(null);
  const [search, setSearch] = useState('');
  const [showTextSearch, setShowTextSearch] = useState(false);
  const [wines, setWines] = useState([]);
  const [loading, setLoading] = useState(false);
  const [aiSearching, setAiSearching] = useState(false);
  const [aiSearchError, setAiSearchError] = useState(null);
  const [aiResult, setAiResult] = useState(null);

  // ── Label-scan camera ──
  const [labelCam, setLabelCam] = useState({ open: false, error: null });
  const [labelScanning, setLabelScanning] = useState(false);
  const [labelFacing, setLabelFacing] = useState('environment');
  const labelVideoRef = useRef(null);
  const labelCanvasRef = useRef(null);
  const labelStreamRef = useRef(null);

  // ── Scan result state ──
  const [scanResult, setScanResult] = useState(null);
  const [labelImage, setLabelImage] = useState(null);
  const [showManualForm, setShowManualForm] = useState(false);
  const [pendingWineData, setPendingWineData] = useState(null);
  const [findingWine, setFindingWine] = useState(false);

  // ── Wishlist item details ──
  const [vintage, setVintage] = useState('');
  const [notes, setNotes] = useState('');
  const [priority, setPriority] = useState('medium');
  const [saving, setSaving] = useState(false);

  // ── Camera helpers (same as AddBottle) ──
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

  useEffect(() => {
    if (labelCam.open && !labelCam.error) {
      if (labelStreamRef.current) labelStreamRef.current.getTracks().forEach(t => t.stop());
      startLabelCamera();
    }
  }, [labelFacing]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    return () => {
      if (labelStreamRef.current) labelStreamRef.current.getTracks().forEach(t => t.stop());
    };
  }, []);

  const captureLabelPhoto = useCallback(async () => {
    const video = labelVideoRef.current;
    const canvas = labelCanvasRef.current;
    if (!video || !canvas) return;

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
          // Pre-fill vintage from scan
          if (data.extracted.vintage) setVintage(data.extracted.vintage);
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

  // ── Confirm scan result — find/create the wine then add to wishlist ──
  const handleConfirmScan = useCallback(async () => {
    const { extracted, match } = scanResult;
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
      if (!res.ok) { setError(data.error || 'Failed to save wine'); return; }
      setSelectedWine(data.wine);
      setScanResult(null);
      setLabelImage(null);
      setShowManualForm(false);
      setPendingWineData(null);
    } catch {
      setError('Failed to save wine');
    } finally {
      setFindingWine(false);
    }
  }, [apiFetch, scanResult, labelImage]);

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

  const handleConfirmManualWine = useCallback(async () => {
    if (!pendingWineData?.name?.trim() || !pendingWineData?.producer?.trim() || !pendingWineData?.country?.trim()) {
      setError('Name, producer, and country are required');
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
      if (!res.ok) { setError(data.error || 'Failed to save wine'); return; }
      setSelectedWine(data.wine);
      setScanResult(null);
      setLabelImage(null);
      setShowManualForm(false);
      setPendingWineData(null);
    } catch {
      setError('Failed to save wine');
    } finally {
      setFindingWine(false);
    }
  }, [apiFetch, pendingWineData, labelImage]);

  const handleScanReset = useCallback(() => {
    setScanResult(null);
    setLabelImage(null);
    setShowManualForm(false);
    setPendingWineData(null);
    setError(null);
  }, []);

  // ── Text search ──
  const handleSearch = useCallback(() => {
    if (!search.trim()) { setWines([]); return; }
    const query = search.trim();
    setLoading(true);
    setAiSearchError(null);
    setAiSearching(true);
    setAiResult(null);

    searchWines(apiFetch, `search=${encodeURIComponent(query)}&limit=10`)
      .then(res => res.json())
      .then(data => { if (data.wines) setWines(data.wines); })
      .catch(() => {})
      .finally(() => setLoading(false));

    identifyWineByText(apiFetch, query)
      .then(res => res.json())
      .then(data => { if (data.wine) setAiResult(data.wine); })
      .catch(() => {})
      .finally(() => setAiSearching(false));
  }, [search, apiFetch]);

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
      if (!res.ok) { setAiSearchError(data.error || 'Identification failed'); return; }
      if (!data.wine) { setAiSearchError('Could not identify this wine'); return; }
      setAiResult(data.wine);
    } catch {
      setAiSearchError('Network error during identification.');
    } finally {
      setAiSearching(false);
    }
  };

  const handleSelectWine = (wine) => {
    setSelectedWine(wine);
  };

  // ── Save to wishlist ──
  const handleSave = async (e) => {
    e.preventDefault();
    if (!selectedWine) return;
    setError(null);
    setSaving(true);
    try {
      const res = await addToWishlist(apiFetch, {
        wineDefinitionId: selectedWine._id,
        vintage: vintage || undefined,
        notes: notes || undefined,
        priority
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Failed to add to wishlist');
        return;
      }
      setSuccess(`${selectedWine.name} added to your wishlist!`);
      // Reset for adding another
      setTimeout(() => {
        navigate('/wishlist');
      }, 1200);
    } catch {
      setError('Network error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="add-wishlist-page">
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
                    <span>Reading label...</span>
                  </div>
                ) : (
                  <>
                    <div className="camera-overlay">
                      <div className="label-guide-frame" />
                      <p className="overlay-hint">Frame the wine label</p>
                    </div>
                    <div className="camera-controls">
                      <button type="button" className="camera-btn camera-btn-close" onClick={stopLabelCamera} aria-label="Close camera">&#x2715;</button>
                      <button type="button" className="camera-btn camera-btn-capture" onClick={captureLabelPhoto} aria-label="Scan label">
                        <span className="capture-ring" aria-hidden="true"></span>
                      </button>
                      <button type="button" className="camera-btn camera-btn-switch" onClick={() => setLabelFacing(f => f === 'environment' ? 'user' : 'environment')} aria-label="Switch camera">&#x27F2;</button>
                    </div>
                  </>
                )}
              </>
            )}
          </div>
          <canvas ref={labelCanvasRef} style={{ display: 'none' }} />
        </div>
      )}

      <div className="add-wishlist-header">
        <Link to="/wishlist" className="back-link">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"/></svg>
          Back to Wishlist
        </Link>
        <h1>Add to Wishlist</h1>
      </div>

      {error && <div className="alert alert-error">{error}</div>}
      {success && <div className="alert alert-success">{success}</div>}

      {/* ── Step 1: Select wine ── */}
      {!selectedWine && (
        <div className="card">
          {/* Scan result: wine card */}
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
                  <p className="scan-vintage-note">Vintage detected: {scanResult.extracted.vintage}</p>
                )}
                <div className="scan-wine-actions">
                  <button type="button" className="btn btn-success" onClick={handleConfirmScan} disabled={findingWine}>
                    {findingWine ? 'Saving...' : 'Add to Wishlist'}
                  </button>
                  <button type="button" className="btn-not-right" onClick={handleNotRightWine}>
                    Not the right wine?
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Scan result: manual edit form */}
          {scanResult && showManualForm && pendingWineData && (
            <div className="scan-result-panel">
              {labelImage && (
                <div className="scan-manual-image-wrap">
                  <img src={labelImage} alt="" className="scan-manual-label-img" />
                </div>
              )}
              <div className="grid-2">
                <div className="form-group">
                  <label>Wine Name *</label>
                  <input type="text" value={pendingWineData.name}
                    onChange={e => setPendingWineData(p => ({ ...p, name: e.target.value }))} required />
                </div>
                <div className="form-group">
                  <label>Producer *</label>
                  <input type="text" value={pendingWineData.producer}
                    onChange={e => setPendingWineData(p => ({ ...p, producer: e.target.value }))} required />
                </div>
                <div className="form-group">
                  <label>Country *</label>
                  <input type="text" value={pendingWineData.country}
                    onChange={e => setPendingWineData(p => ({ ...p, country: e.target.value }))} required />
                </div>
                <div className="form-group">
                  <label>Region</label>
                  <input type="text" value={pendingWineData.region}
                    onChange={e => setPendingWineData(p => ({ ...p, region: e.target.value }))} />
                </div>
                <div className="form-group">
                  <label>Appellation</label>
                  <input type="text" value={pendingWineData.appellation}
                    onChange={e => setPendingWineData(p => ({ ...p, appellation: e.target.value }))} />
                </div>
                <div className="form-group">
                  <label>Type</label>
                  <select value={pendingWineData.type}
                    onChange={e => setPendingWineData(p => ({ ...p, type: e.target.value }))}>
                    {WINE_TYPES.map(wt => <option key={wt} value={wt}>{wt}</option>)}
                  </select>
                </div>
                <div className="form-group form-group-full">
                  <label>Grapes</label>
                  <input type="text" value={pendingWineData.grapes}
                    onChange={e => setPendingWineData(p => ({ ...p, grapes: e.target.value }))}
                    placeholder="e.g. Cabernet Sauvignon, Merlot" />
                </div>
              </div>
              <div className="scan-result-actions">
                <button type="button" className="btn btn-success" onClick={handleConfirmManualWine} disabled={findingWine}>
                  {findingWine ? 'Saving...' : 'Add to Wishlist'}
                </button>
                <button type="button" className="btn btn-ghost" onClick={handleScanReset}>
                  Search manually
                </button>
              </div>
            </div>
          )}

          {/* Camera-first prompt */}
          {!scanResult && !showTextSearch && !labelCam.open && (
            <div className="wine-select-default">
              <div className="camera-prompt-card">
                <svg className="camera-prompt-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
                  <circle cx="12" cy="13" r="4"/>
                </svg>
                <h2>Snap the label</h2>
                <p className="camera-prompt-hint">
                  Take a photo of the wine label — we'll identify it and add it to your wishlist so you can buy it later.
                </p>
                <button type="button" className="btn btn-primary" onClick={startLabelCamera}>
                  Start Camera
                </button>
              </div>
              <button type="button" className="wine-select-manual-link" onClick={() => setShowTextSearch(true)}>
                No camera? Search manually instead &rarr;
              </button>
            </div>
          )}

          {/* Manual text search */}
          {!scanResult && showTextSearch && (
            <>
              <div className="wine-select-manual-header">
                <h2>Search for a wine</h2>
                <button type="button" className="btn-link-muted" onClick={() => { setShowTextSearch(false); setSearch(''); setWines([]); setAiSearchError(null); }}>
                  &larr; Use camera instead
                </button>
              </div>
              <p className="wine-search-hint">
                Be as specific as possible — include the wine name and producer.
              </p>
              <div className="search-section">
                <div className="search-input-wrapper">
                  <input
                    type="text"
                    placeholder="e.g. Chateau Margaux 2015"
                    value={search}
                    onChange={(e) => { setSearch(e.target.value); setWines([]); setAiSearchError(null); setAiResult(null); }}
                    onKeyDown={handleSearchKeyDown}
                    className="search-input-large"
                    autoFocus
                  />
                  <button type="button" className="btn btn-secondary search-submit-btn" onClick={handleSearch} disabled={loading}>
                    {loading ? '...' : 'Search'}
                  </button>
                </div>
              </div>

              {loading && <p>Searching...</p>}

              {/* AI result */}
              {aiResult && !aiSearching && (
                <div className="ai-result-card">
                  <div className="ai-result-badge">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2a4 4 0 0 1 4 4c0 1.95-1.4 3.58-3.25 3.93L12 22"/><path d="M8 6a4 4 0 0 1 8 0"/><path d="M17 12H7"/></svg>
                    AI found this wine
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
                    <button type="button" className="btn btn-success" onClick={() => handleSelectWine(aiResult)}>
                      Use this wine
                    </button>
                  </div>
                </div>
              )}

              {/* Search results list */}
              {!aiResult && !aiSearching && wines.length > 0 && (
                <div className="wines-list">
                  {wines.map(wine => (
                    <div key={wine._id} className="wine-row" onClick={() => handleSelectWine(wine)}>
                      {wine.image ? (
                        <div className="wine-row-img-wrap">
                          <img src={wine.image} alt={wine.name} className="wine-row-image" onError={(e) => { e.target.style.display = 'none'; }} />
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
                      <button className="btn btn-primary btn-small">Select</button>
                    </div>
                  ))}
                </div>
              )}

              {/* Can't find wine? */}
              {!loading && search.trim() && !aiResult && !aiSearching && (
                <div className="ai-search-row" onClick={!aiSearching ? handleAiIdentify : undefined}>
                  <div className="ai-search-row-icon">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                      <path d="M11 8a3 3 0 0 1 3 3" opacity="0.5"/>
                    </svg>
                  </div>
                  <div className="ai-search-row-body">
                    <span className="ai-search-row-title">Can't find your wine?</span>
                    <span className="ai-search-row-hint">Tap here to identify it with AI</span>
                  </div>
                  <svg className="ai-search-row-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
                </div>
              )}

              {aiSearching && (
                <div className="ai-searching-state">
                  <div className="ai-searching-spinner" />
                  <p>Identifying wine...</p>
                </div>
              )}

              {aiSearchError && !aiSearching && (
                <div className="ai-error-state">
                  <p className="error-text">{aiSearchError}</p>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* ── Step 2: Wine selected — add details and save ── */}
      {selectedWine && !success && (
        <div className="card">
          <div className="selected-wine-bar">
            {selectedWine.image && (
              <img src={selectedWine.image} alt={selectedWine.name} className="selected-wine-bar-img" onError={(e) => { e.target.style.display = 'none'; }} />
            )}
            <div className="selected-wine-bar-info">
              <strong className="selected-wine-bar-name">{selectedWine.name}</strong>
              <span className="selected-wine-bar-producer">{selectedWine.producer}</span>
            </div>
            <button type="button" onClick={() => setSelectedWine(null)} className="btn btn-ghost btn-small">
              Change
            </button>
          </div>

          <form onSubmit={handleSave}>
            <div className="grid-2" style={{ marginTop: '1.25rem' }}>
              <div className="form-group">
                <label>Vintage</label>
                <input
                  type="text"
                  value={vintage}
                  onChange={(e) => setVintage(e.target.value)}
                  placeholder="e.g. 2020 or NV"
                  maxLength={20}
                />
              </div>
              <div className="form-group">
                <label>Priority</label>
                <select value={priority} onChange={(e) => setPriority(e.target.value)}>
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High — must buy!</option>
                </select>
              </div>
              <div className="form-group form-group-full">
                <label>Notes</label>
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Where you tried it, what you liked, price you saw..."
                  rows="3"
                  maxLength={2000}
                />
              </div>
            </div>
            <div className="form-actions">
              <button type="submit" className="btn btn-success" disabled={saving}>
                {saving ? 'Saving...' : 'Add to Wishlist'}
              </button>
              <button type="button" onClick={() => navigate('/wishlist')} className="btn btn-secondary">
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

export default AddToWishlist;
