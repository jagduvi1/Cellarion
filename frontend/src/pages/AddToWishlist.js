import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { searchWines, getWine, resolveWine, identifyWineByText } from '../api/wines';
import useLabelScanner from '../hooks/useLabelScanner';
import { addToWishlist } from '../api/wishlist';
import '../components/ImageUpload.css';
import './AddBottle.css';
import WineImage from '../components/WineImage';
import SimilarWinesModal from '../components/SimilarWinesModal';
import { WINE_TYPES } from '../config/wineTypes';
import './AddToWishlist.css';

function AddToWishlist() {
  const { t } = useTranslation();
  const { apiFetch } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
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
  // identify-text is read-only — see api/wines.js. `aiIdentified` is UNSAVED
  // (plain strings, no _id); resolveWine (also read-only) either matches it to
  // a registry wine or leaves it pending, and the wine is minted only when the
  // wishlist item is SAVED (POST /api/wishlist with `newWine`) — an abandoned
  // form leaves no orphan registry row.
  const [aiIdentified, setAiIdentified] = useState(null);
  const [aiMatch, setAiMatch] = useState(null);
  const [aiCandidates, setAiCandidates] = useState([]);
  // The not-yet-registered wine riding along to the save. When set,
  // `selectedWine` is a display-only stub WITHOUT `_id`.
  const [pendingNewWine, setPendingNewWine] = useState(null);

  // ── Scan result state ──
  const [scanResult, setScanResult] = useState(null);
  const [labelImage, setLabelImage] = useState(null);
  // Id of the stored ORIGINAL scan frame — never rendered; it rides the commit
  // so the minted wine keeps the label a curator may need to read.
  const [scanImageId, setScanImageId] = useState(null);
  // ── Back-label rescue — see AddBottle.js for the design. Offered only after
  // a front pass that read half a label or none of it; optional, dismissible,
  // and never a gate on manual entry. ──
  const [backOffer, setBackOffer] = useState(false);
  const [backScanImageId, setBackScanImageId] = useState(null);
  // Suspect-producer flag + the exact prefilled string (see AddBottle).
  const [producerSuspect, setProducerSuspect] = useState(null);
  const suspectProducerValueRef = useRef(null);
  const [scanConflicts, setScanConflicts] = useState([]);
  const [showManualForm, setShowManualForm] = useState(false);
  const [pendingWineData, setPendingWineData] = useState(null);
  const [findingWine, setFindingWine] = useState(false);

  // ── Soft-zone "did you mean?" state — see AddBottle.js for the design ──
  const [softCandidates, setSoftCandidates] = useState(null);
  const [softPending, setSoftPending] = useState(null);

  const clearAi = useCallback(() => {
    setAiIdentified(null);
    setAiMatch(null);
    setAiCandidates([]);
  }, []);

  const applyResolvedWine = useCallback((wine) => {
    setSelectedWine(wine);
    setPendingNewWine(null);
    setScanResult(null);
    setLabelImage(null);
    // Wine already identified — its scans have no curation value, and neither
    // does the record of what the two labels disagreed about.
    setScanImageId(null);
    setBackScanImageId(null);
    setScanConflicts([]);
    setBackOffer(false);
    setShowManualForm(false);
    setPendingWineData(null);
    setSoftCandidates(null);
    setSoftPending(null);
    clearAi();
  }, [clearAi]);

  // Advance to the details step WITHOUT any registry write: the confirmed
  // wine fields ride along and are minted by POST /api/wishlist on save.
  const applyPendingNewWine = useCallback((wineData) => {
    setPendingNewWine(wineData);
    setSelectedWine({ name: wineData.name, producer: wineData.producer, type: wineData.type });
    setScanResult(null);
    setLabelImage(null);
    // The scan ids and conflicts survive — this path ends in a pendingIdentity
    // mint, which is exactly who the evidence is for.
    setBackOffer(false);
    setShowManualForm(false);
    setPendingWineData(null);
    setSoftCandidates(null);
    setSoftPending(null);
    clearAi();
  }, [clearAi]);

  // Resolve confirmed wine data against the registry (READ-ONLY — nothing is
  // created here any more): matched wine, soft-zone candidates, or no match
  // (→ the fields ride to the save, which mints).
  const resolveSelectedWine = useCallback(async (wineData) => {
    setError(null);
    setFindingWine(true);
    try {
      const res = await resolveWine(apiFetch, wineData);
      const data = await res.json();
      if (!res.ok) { setError(data.error || t('addToWishlist.failedSaveWine')); return; }
      if (data.candidates && data.candidates.length > 0) {
        setSoftCandidates(data.candidates);
        setSoftPending({ wineData });
        return;
      }
      if (data.wine) { applyResolvedWine(data.wine); return; }
      applyPendingNewWine(wineData);
    } catch {
      setError(t('addToWishlist.failedSaveWine'));
    } finally {
      setFindingWine(false);
    }
  }, [apiFetch, applyResolvedWine, applyPendingNewWine, t]);

  // ── Wishlist item details ──
  const [vintage, setVintage] = useState('');
  const [notes, setNotes] = useState('');
  const [priority, setPriority] = useState('medium');
  const [saving, setSaving] = useState(false);

  // ── Label-scan camera (shared hook) ──
  const handleScanSuccess = useCallback((data) => {
    setScanResult(data);
    setLabelImage(data.labelImage || null);
    // Carry the stored original frame's id to the commit — it is what lets a
    // curator fix the wine when the extraction was wrong (see AddBottle).
    setScanImageId(data.scanImageId || null);
    // A HALF-READ label is a 200, not an error: the back label is offered as
    // an optional way to fill the rest.
    const partial = data.extracted?.partial === true;
    setBackOffer(partial);
    setBackScanImageId(null);
    setScanConflicts([]);
    // Suspect producer: note + replace-if-untouched machinery (see AddBottle).
    setProducerSuspect(data.extracted?.producer_suspect || null);
    suspectProducerValueRef.current = data.extracted?.producer_suspect
      ? (data.extracted.producer || '') : null;
    if (partial) {
      // Straight to the EDITABLE form, prefilled — never the read-only card
      // (release-audit M-1; see AddBottle for the full argument).
      const e = data.extracted || {};
      setPendingWineData({
        name: e.name || '',
        producer: e.producer || '',
        country: e.country || '',
        region: e.region || '',
        appellation: e.appellation || '',
        // Not a form field — rides invisibly into the commit payload (see AddBottle).
        classification: e.classification || '',
        type: e.type || 'red',
        grapes: (e.grapes || []).join(', '),
      });
      setShowManualForm(true);
    } else {
      setShowManualForm(false);
      setPendingWineData(null);
    }
    // Pre-fill vintage from scan
    if (data.extracted?.vintage) setVintage(data.extracted.vintage);
  }, []);

  const handleScanError = useCallback((msg, body) => {
    setError(msg);
    // An unreadable label still hands back the stored frame — keep its id and
    // offer the back label, so the pending wine the manual entry mints is not
    // left with no evidence at all.
    if (body?.scanImageId) {
      setScanImageId(body.scanImageId);
      setBackOffer(true);
    }
  }, []);

  /**
   * Merge a back-label reading into the form WITHOUT ever overwriting the user.
   * Anything typed while the scan was in flight is a deliberate correction and
   * outranks both labels; this only fills what is still blank. (Front-vs-back
   * was already settled server-side — front wins, disagreements recorded.)
   */
  const handleBackScanSuccess = useCallback((data) => {
    const merged = data.merged || {};
    setBackScanImageId(data.backScanImageId || null);
    setScanConflicts(Array.isArray(data.conflicts) ? data.conflicts : []);
    setBackOffer(false);
    setError(null);

    setScanResult(prev => (prev
      ? { ...prev, extracted: merged, match: data.match || null }
      : { extracted: merged, match: data.match || null, labelImage: null, scanImageId: null }));

    setPendingWineData(prev => {
      const fromMerged = {
        name: merged.name || '',
        producer: merged.producer || '',
        country: merged.country || '',
        region: merged.region || '',
        appellation: merged.appellation || '',
        classification: merged.classification || '',
        type: merged.type || 'red',
        grapes: (merged.grapes || []).join(', '),
      };
      if (!prev) return fromMerged;
      const next = { ...prev };
      for (const key of Object.keys(fromMerged)) {
        const typed = typeof prev[key] === 'string' ? prev[key].trim() : prev[key];
        if (!typed && fromMerged[key]) next[key] = fromMerged[key];
      }
      // A SUSPECT front producer may be REPLACED by the back label's — only
      // while the box still holds the exact prefilled string (audit M-1).
      if (suspectProducerValueRef.current
          && next.producer === suspectProducerValueRef.current
          && fromMerged.producer
          && fromMerged.producer !== next.producer) {
        next.producer = fromMerged.producer;
      }
      return next;
    });
    setProducerSuspect(merged.producer_suspect || null);
    suspectProducerValueRef.current = merged.producer_suspect ? (merged.producer || '') : null;
    setShowManualForm(prev => prev || !scanResult);
    // The vintage field is the user's; only fill it if they have not.
    if (merged.vintage) setVintage(prev => prev || merged.vintage);
  }, [scanResult]);

  const {
    labelCam, labelScanning, labelFacing, setLabelFacing,
    labelVideoRef, labelCanvasRef,
    startCamera: startLabelCamera, startBackCamera: startBackLabelCamera,
    stopCamera: stopLabelCamera, capturePhoto: captureLabelPhoto
  } = useLabelScanner(apiFetch, {
    onScanSuccess: handleScanSuccess,
    onScanError: handleScanError,
    onBackScanSuccess: handleBackScanSuccess,
  });

  const startBackScan = useCallback(() => {
    startBackLabelCamera({
      frontExtracted: scanResult?.extracted || {},
      frontScanImageId: scanImageId,
    });
  }, [startBackLabelCamera, scanResult, scanImageId]);

  // Pre-select wine when navigating from restock suggestions (route state)
  // or from a wine page's "Add to Wishlist" link (?wine=<id> query param).
  useEffect(() => {
    const restock = location.state?.fromRestock;
    const wineParam = new URLSearchParams(location.search).get('wine');
    const wineId = restock?.wineId || wineParam;
    if (!wineId) return;
    let cancelled = false;
    (async () => {
      try {
        // getWine returns the raw fetch Response — parse the body and check
        // res.ok before using it (a Response object is always truthy).
        const res = await getWine(apiFetch, wineId);
        if (cancelled || !res.ok) return;
        const data = await res.json();
        const wine = data.wine || data;
        if (!cancelled && wine?._id) {
          setSelectedWine(wine);
          if (restock?.vintage) setVintage(restock.vintage);
        }
      } catch {
        // Wine definition not found — fall back to normal flow
      }
    })();
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Confirm scan result — resolve the wine, then add details. The label
  // image is NOT part of the wine payload (the old find-or-create route
  // ignored it, and it must not bloat the wishlist commit). ──
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
          grapes: (match.wine.grapes || []).map(g => g.name)
        }
      : {
          name: extracted.name,
          producer: extracted.producer,
          country: extracted.country || '',
          region: extracted.region || '',
          appellation: extracted.appellation || '',
          classification: extracted.classification || '',
          type: extracted.type || 'red',
          grapes: extracted.grapes || []
        };

    await resolveSelectedWine(wineData);
  }, [scanResult, resolveSelectedWine]);

  const handleNotRightWine = useCallback(() => {
    const { extracted } = scanResult;
    setPendingWineData({
      name: extracted.name || '',
      producer: extracted.producer || '',
      country: extracted.country || '',
      region: extracted.region || '',
      appellation: extracted.appellation || '',
      classification: extracted.classification || '',
      type: extracted.type || 'red',
      grapes: (extracted.grapes || []).join(', ')
    });
    setShowManualForm(true);
  }, [scanResult]);

  // Producer is deliberately NOT required — see AddBottle: an unreadable label
  // must not block the add, and a producerless payload resolves to noMatch and
  // mints a pending-identity wine a curator completes.
  const handleConfirmManualWine = useCallback(async () => {
    if (!pendingWineData?.name?.trim() || !pendingWineData?.country?.trim()) {
      setError(t('addToWishlist.nameCountryRequired'));
      return;
    }
    const grapes = pendingWineData.grapes
      ? pendingWineData.grapes.split(',').map(g => g.trim()).filter(Boolean)
      : [];
    await resolveSelectedWine({ ...pendingWineData, grapes });
  }, [pendingWineData, t, resolveSelectedWine]);

  const handleScanReset = useCallback(() => {
    setProducerSuspect(null);
    suspectProducerValueRef.current = null;
    setScanResult(null);
    setLabelImage(null);
    setScanImageId(null);
    setBackScanImageId(null);
    setScanConflicts([]);
    setBackOffer(false);
    setShowManualForm(false);
    setPendingWineData(null);
    setError(null);
    clearAi();
  }, [clearAi]);

  // ── Text search. Registry search ONLY — the parallel AI call that used to
  // run here spent budget on every search and (before identify-text became
  // read-only) minted a registry wine per guess. AI is opt-in below. ──
  const handleSearch = useCallback(() => {
    if (!search.trim()) { setWines([]); return; }
    const query = search.trim();
    setLoading(true);
    setAiSearchError(null);
    clearAi();

    searchWines(apiFetch, `search=${encodeURIComponent(query)}&limit=10`)
      .then(res => res.json())
      .then(data => { if (data.wines) setWines(data.wines); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [search, apiFetch, clearAi]);

  const handleSearchKeyDown = (e) => {
    if (e.key === 'Enter') handleSearch();
  };

  const handleAiIdentify = async () => {
    if (!search.trim()) return;
    setAiSearching(true);
    setAiSearchError(null);
    clearAi();
    try {
      const res = await identifyWineByText(apiFetch, search.trim());
      const data = await res.json();
      if (!res.ok) {
        // The AI 403 is a hardcoded English server string; translate the one
        // case we can recognise rather than showing it verbatim in every locale.
        setAiSearchError(data.code === 'demo_ai_disabled'
          ? t('addToWishlist.demoAiBlocked')
          : (data.error || t('addToWishlist.identificationFailed')));
        return;
      }
      // Branch on `identified` — "recognised but not in the registry" is a
      // success, and is the common case.
      if (!data.identified) { setAiSearchError(t('addToWishlist.couldNotIdentify')); return; }
      setAiIdentified(data.identified);
      setAiMatch(data.match?.wine || null);
      setAiCandidates(data.candidates || []);
    } catch {
      setAiSearchError(t('addToWishlist.networkErrorIdentify'));
    } finally {
      setAiSearching(false);
    }
  };

  const editAiSuggestion = () => {
    if (!aiIdentified) return;
    setPendingWineData({
      name: aiIdentified.name || '',
      producer: aiIdentified.producer || '',
      country: aiIdentified.country || '',
      region: aiIdentified.region || '',
      appellation: aiIdentified.appellation || '',
      type: aiIdentified.type || 'red',
      grapes: (aiIdentified.grapes || []).join(', '),
      source: 'ai',
    });
    setShowManualForm(true);
  };

  // An unsaved suggestion is resolved against the registry first; if it is
  // not there, the fields ride to the save, which mints. `source: 'ai'`
  // travels with the payload so the commit stamps createdVia:'ai'.
  const handleAcceptAiResult = () => {
    if (aiMatch) { handleSelectWine(aiMatch); return; }
    if (!aiIdentified) return;
    if (!aiIdentified.country) { editAiSuggestion(); return; }
    resolveSelectedWine({
      name: aiIdentified.name,
      producer: aiIdentified.producer,
      country: aiIdentified.country,
      region: aiIdentified.region || '',
      appellation: aiIdentified.appellation || '',
      type: aiIdentified.type || 'red',
      grapes: aiIdentified.grapes || [],
      source: 'ai',
    });
  };

  const handleSelectWine = (wine) => {
    setSelectedWine(wine);
    setPendingNewWine(null);
  };

  // One row renderer for both the registry-search list and the AI near-match
  // list. Takes a SAVED wine only.
  const renderWineRow = (wine) => (
    <div key={wine._id} className="wine-row" onClick={() => handleSelectWine(wine)} role="button" tabIndex={0} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleSelectWine(wine); } }}>
      <WineImage image={wine.image} alt={wine.name} className="wine-row-image" wrapClass="wine-row-img-wrap" wineType={wine.type} placeholder="wine-row-placeholder" />
      <div className="wine-info">
        <h3>{wine.name}</h3>
        <p className="producer">{wine.producer}</p>
        <div className="wine-meta">
          <span>{wine.country?.name}</span>
          {wine.region && <span>• {wine.region.name}</span>}
          <span className={`wine-type-pill ${wine.type}`}>{wine.type}</span>
        </div>
        {wine.grapes?.length > 0 && (
          <p className="wine-grapes">{wine.grapes.map(g => g.displayName || g.name).join(', ')}</p>
        )}
      </div>
      <button className="btn btn-primary btn-small">{t('addToWishlist.select')}</button>
    </div>
  );

  // ── Save to wishlist. wineRef is EITHER { wineId } (existing registry
  // wine) or { newWinePayload } — the save then mints the wine WITH the
  // wishlist item (a wanted-but-not-owned wine is a legitimate zero-bottle
  // registry row; what changed is only WHEN it is created). Callable from the
  // form submit and from the soft-zone modal (the rare commit-time race), so
  // a modal answer finishes the save in one step. ──
  const saveItem = async ({ wineId, newWinePayload }) => {
    if (saving) return;
    setError(null);
    setSaving(true);
    try {
      const body = {
        vintage: vintage || undefined,
        notes: notes || undefined,
        priority
      };
      // The scan evidence rides at the ONE place a newWine payload is sent, so
      // every entry path carries it without each remembering to. All three
      // parts travel together: the front frame, the optional back frame, and
      // what the two labels disagreed about.
      if (newWinePayload) body.newWine = {
        ...newWinePayload,
        ...(scanImageId ? { scanImageId } : {}),
        ...(backScanImageId ? { scanImageBackId: backScanImageId } : {}),
        ...(scanConflicts.length > 0 ? { scanConflicts } : {}),
      };
      else body.wineDefinitionId = wineId;

      const res = await addToWishlist(apiFetch, body);
      const data = await res.json();
      if (res.ok && data.candidates && data.candidates.length > 0) {
        // Commit-time soft zone: a very similar wine entered the registry
        // between the resolve and this save. NOTHING was created — ask again.
        setSoftCandidates(data.candidates);
        setSoftPending({ forCommit: true, queryLabel: newWinePayload?.name });
        return;
      }
      if (!res.ok) {
        setError(data.error || t('addToWishlist.failedAdd'));
        // Release-audit MEDIUM (same as AddBottle): a mint-gate 400 arrives
        // after the wine form is gone — when the failed save carried newWine,
        // reopen the manual form seeded with the typed fields so the user
        // fixes the named field instead of retyping the wine.
        if (newWinePayload) {
          setPendingWineData({ ...newWinePayload, grapes: (newWinePayload.grapes || []).join(', ') });
          setShowManualForm(true);
        }
        window.scrollTo(0, 0);
        return;
      }
      // The saved item's populated wine, not selectedWine: when the commit-
      // phase modal picked a different wine (or the save just minted one),
      // this closure's selectedWine is still the stale stub.
      setSuccess(t('addToWishlist.addedSuccess', {
        name: data.item?.wineDefinition?.name || selectedWine?.name
      }));
      // Reset for adding another
      setTimeout(() => {
        navigate('/wishlist');
      }, 1200);
    } catch {
      setError(t('addToWishlist.networkError'));
    } finally {
      setSaving(false);
    }
  };

  const handleSave = async (e) => {
    e.preventDefault();
    if (!selectedWine) return;
    await saveItem(pendingNewWine
      ? { newWinePayload: pendingNewWine }
      : { wineId: selectedWine._id });
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
                <button type="button" className="btn btn-secondary" onClick={stopLabelCamera}>{t('addToWishlist.close')}</button>
              </div>
            ) : (
              <>
                <video ref={labelVideoRef} autoPlay playsInline muted className="camera-video" />
                {labelScanning ? (
                  <div className="label-scan-overlay">
                    <div className="label-scan-spinner" />
                    <span>{t('addToWishlist.readingLabel')}</span>
                  </div>
                ) : (
                  <>
                    <div className="camera-overlay">
                      <div className="label-guide-frame" />
                      <p className="overlay-hint">{t('addToWishlist.frameLabel')}</p>
                    </div>
                    <div className="camera-controls">
                      <button type="button" className="camera-btn camera-btn-close" onClick={stopLabelCamera} aria-label={t('addToWishlist.closeCamera')}>&#x2715;</button>
                      <button type="button" className="camera-btn camera-btn-capture" onClick={captureLabelPhoto} aria-label={t('addToWishlist.scanLabel')}>
                        <span className="capture-ring" aria-hidden="true"></span>
                      </button>
                      <button type="button" className="camera-btn camera-btn-switch" onClick={() => setLabelFacing(f => f === 'environment' ? 'user' : 'environment')} aria-label={t('addToWishlist.switchCamera')}>&#x27F2;</button>
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
          {t('addToWishlist.backToWishlist')}
        </Link>
        <h1>{t('addToWishlist.title')}</h1>
      </div>

      {error && <div className="alert alert-error">{error}</div>}
      {success && <div className="alert alert-success">{success}</div>}

      {/* ── Step 1: Select wine ── */}
      {!selectedWine && (
        <div className="card">
          {/* ── Back-label rescue ─────────────────────────────────────────
              Appears ONLY after a front scan that read half a label or none
              of it. Optional in the strongest sense: "Skip" dismisses it,
              every field below stays editable while it is on screen, and
              ignoring it leaves the flow exactly as it was. ── */}
          {backOffer && !labelCam.open && (
            <div className="scan-back-prompt">
              <p className="scan-back-prompt-text">{t('addToWishlist.backScanPrompt')}</p>
              <div className="scan-back-prompt-actions">
                <button type="button" className="btn btn-secondary" onClick={startBackScan}>
                  {t('addToWishlist.backScanCta')}
                </button>
                <button type="button" className="btn btn-ghost" onClick={() => setBackOffer(false)}>
                  {t('addToWishlist.backScanSkip')}
                </button>
              </div>
            </div>
          )}

          {/* Non-blocking: the front value was kept, and saying so is what
              stops a user re-typing a field that is already right. */}
          {scanConflicts.length > 0 && (
            <p className="scan-back-conflicts">
              {t('addToWishlist.backScanConflicts', {
                fields: scanConflicts.map(c => c.field).join(', '),
              })}
            </p>
          )}

          {/* WHY the scan is partial with filled boxes (audit M-2). */}
          {producerSuspect && (
            <p className="scan-back-conflicts">
              {t('addToWishlist.producerSuspectNote')}
            </p>
          )}

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
                      {t('addToWishlist.confidence', { percent: Math.round(scanResult.extracted.confidence * 100) })}
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
                  <p className="scan-vintage-note">{t('addToWishlist.vintageDetected', { vintage: scanResult.extracted.vintage })}</p>
                )}
                <div className="scan-wine-actions">
                  <button type="button" className="btn btn-success" onClick={handleConfirmScan} disabled={findingWine}>
                    {findingWine ? t('addToWishlist.saving') : t('addToWishlist.addBtn')}
                  </button>
                  <button type="button" className="btn-not-right" onClick={handleNotRightWine}>
                    {t('addToWishlist.notRightWine')}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Scan result: manual edit form */}
          {/* Not gated on scanResult: the AI card reuses this form for
              "Not the right wine" and for a missing country. */}
          {showManualForm && pendingWineData && (
            <div className="scan-result-panel">
              {labelImage && (
                <div className="scan-manual-image-wrap">
                  <img src={labelImage} alt="" className="scan-manual-label-img" />
                </div>
              )}
              <div className="grid-2">
                <div className="form-group">
                  <label>{t('addToWishlist.wineName')}</label>
                  <input type="text" value={pendingWineData.name}
                    onChange={e => setPendingWineData(p => ({ ...p, name: e.target.value }))} required />
                </div>
                <div className="form-group">
                  {/* Optional: no `*` in the label key, no `required`. */}
                  <label>{t('addToWishlist.producerOptional')}</label>
                  <input type="text" value={pendingWineData.producer}
                    placeholder={t('addToWishlist.producerOptionalPlaceholder')}
                    onChange={e => setPendingWineData(p => ({ ...p, producer: e.target.value }))} />
                </div>
                <div className="form-group">
                  <label>{t('addToWishlist.country')}</label>
                  <input type="text" value={pendingWineData.country}
                    onChange={e => setPendingWineData(p => ({ ...p, country: e.target.value }))} required />
                </div>
                <div className="form-group">
                  <label>{t('addToWishlist.region')}</label>
                  <input type="text" value={pendingWineData.region}
                    onChange={e => setPendingWineData(p => ({ ...p, region: e.target.value }))} />
                </div>
                <div className="form-group">
                  <label>{t('addToWishlist.appellation')}</label>
                  <input type="text" value={pendingWineData.appellation}
                    onChange={e => setPendingWineData(p => ({ ...p, appellation: e.target.value }))} />
                </div>
                <div className="form-group">
                  <label>{t('addToWishlist.type')}</label>
                  <select value={pendingWineData.type}
                    onChange={e => setPendingWineData(p => ({ ...p, type: e.target.value }))}>
                    {WINE_TYPES.map(wt => <option key={wt} value={wt}>{wt}</option>)}
                  </select>
                </div>
                <div className="form-group form-group-full">
                  <label>{t('addToWishlist.grapes')}</label>
                  <input type="text" value={pendingWineData.grapes}
                    onChange={e => setPendingWineData(p => ({ ...p, grapes: e.target.value }))}
                    placeholder={t('addToWishlist.grapesPlaceholder')} />
                </div>
              </div>
              <div className="scan-result-actions">
                <button type="button" className="btn btn-success" onClick={handleConfirmManualWine} disabled={findingWine}>
                  {findingWine ? t('addToWishlist.saving') : t('addToWishlist.addBtn')}
                </button>
                <button type="button" className="btn btn-ghost" onClick={handleScanReset}>
                  {t('addToWishlist.searchManually')}
                </button>
              </div>
            </div>
          )}

          {/* Camera-first prompt */}
          {!scanResult && !showTextSearch && !showManualForm && !labelCam.open && (
            <div className="wine-select-default">
              <div className="camera-prompt-card">
                <svg className="camera-prompt-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
                  <circle cx="12" cy="13" r="4"/>
                </svg>
                <h2>{t('addToWishlist.snapLabel')}</h2>
                <p className="camera-prompt-hint">
                  {t('addToWishlist.cameraHint')}
                </p>
                <button type="button" className="btn btn-primary" onClick={startLabelCamera}>
                  {t('addToWishlist.startCamera')}
                </button>
              </div>
              <button type="button" className="wine-select-manual-link" onClick={() => setShowTextSearch(true)}>
                {t('addToWishlist.noCameraSearch')}
              </button>
            </div>
          )}

          {/* Manual text search */}
          {!scanResult && showTextSearch && !showManualForm && (
            <>
              <div className="wine-select-manual-header">
                <h2>{t('addToWishlist.searchForWine')}</h2>
                <button type="button" className="btn-link-muted" onClick={() => { setShowTextSearch(false); setSearch(''); setWines([]); setAiSearchError(null); }}>
                  {t('addToWishlist.useCameraInstead')}
                </button>
              </div>
              <p className="wine-search-hint">
                {t('addToWishlist.searchHint')}
              </p>
              <div className="search-section">
                <div className="search-input-wrapper">
                  <input
                    type="text"
                    placeholder={t('addToWishlist.searchPlaceholder')}
                    value={search}
                    onChange={(e) => { setSearch(e.target.value); setWines([]); setAiSearchError(null); setError(null); clearAi(); }}
                    onKeyDown={handleSearchKeyDown}
                    className="search-input-large"
                    autoFocus
                  />
                  <button type="button" className="btn btn-secondary search-submit-btn" onClick={handleSearch} disabled={loading}>
                    {loading ? '...' : t('addToWishlist.searchBtn')}
                  </button>
                </div>
              </div>

              {loading && <p>{t('addToWishlist.searching')}</p>}

              {/* AI result card — shape-aware: `card` is either a saved
                  registry wine (populated refs) or the AI's unsaved suggestion
                  (plain strings). */}
              {(aiMatch || aiIdentified) && !aiSearching && (() => {
                const card = aiMatch || aiIdentified;
                const isRegistryWine = Boolean(aiMatch);
                const countryName = typeof card.country === 'string' ? card.country : card.country?.name;
                const regionName = typeof card.region === 'string' ? card.region : card.region?.name;
                const grapeNames = (card.grapes || [])
                  .map(g => (typeof g === 'string' ? g : g?.name))
                  .filter(Boolean);
                return (
                  <div className="ai-result-card">
                    <div className="ai-result-badge">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2a4 4 0 0 1 4 4c0 1.95-1.4 3.58-3.25 3.93L12 22"/><path d="M8 6a4 4 0 0 1 8 0"/><path d="M17 12H7"/></svg>
                      {isRegistryWine ? t('addToWishlist.aiFound') : t('addToWishlist.aiIdentified')}
                    </div>
                    <p className="wine-search-hint">
                      {isRegistryWine ? t('addToWishlist.aiMatchHint') : t('addToWishlist.aiIdentifiedHint')}
                    </p>
                    <div className="ai-result-wine">
                      <WineImage image={card.image} alt={card.name} className="wine-row-image" wrapClass="wine-row-img-wrap" wineType={card.type} placeholder="wine-row-placeholder" />
                      <div className="wine-info">
                        <h3>{card.name}</h3>
                        <p className="producer">{card.producer}</p>
                        <div className="wine-meta">
                          {countryName && <span>{countryName}</span>}
                          {regionName && <span>• {regionName}</span>}
                          {card.appellation && <span>• {card.appellation}</span>}
                          <span className={`wine-type-pill ${card.type || 'red'}`}>{card.type || 'red'}</span>
                        </div>
                        {grapeNames.length > 0 && (
                          <p className="wine-grapes">{grapeNames.join(', ')}</p>
                        )}
                        {!isRegistryWine && card.confidence != null && (
                          <span className="scan-confidence">{t('addToWishlist.confidence', { percent: Math.round(card.confidence * 100) })}</span>
                        )}
                      </div>
                    </div>
                    <div className="ai-result-actions">
                      <button
                        type="button"
                        className={`btn ${aiCandidates.length > 0 ? 'btn-secondary' : 'btn-success'}`}
                        onClick={handleAcceptAiResult}
                        disabled={findingWine}
                      >
                        {findingWine
                          ? t('addToWishlist.saving')
                          : (isRegistryWine ? t('addToWishlist.useThisWine') : t('addToWishlist.aiAddIt'))}
                      </button>
                      <button type="button" className="btn btn-ghost" onClick={isRegistryWine ? clearAi : editAiSuggestion} disabled={findingWine}>
                        {t('addToWishlist.notRightWine')}
                      </button>
                    </div>
                  </div>
                );
              })()}

              {/* Near-matches already in the registry — picking one writes nothing */}
              {aiCandidates.length > 0 && !aiSearching && (
                <div className="wines-list">
                  <h3 className="wine-select-subheading">{t('addToWishlist.aiSimilarTitle')}</h3>
                  {aiCandidates.map(c => renderWineRow(c.wine))}
                </div>
              )}

              {/* Search results list — no longer hidden behind the AI card */}
              {!aiSearching && wines.length > 0 && (
                <div className="wines-list">
                  {wines
                    .filter(w => String(w._id) !== String(aiMatch?._id)
                      && !aiCandidates.some(c => String(c.wine?._id) === String(w._id)))
                    .map(wine => renderWineRow(wine))}
                </div>
              )}

              {/* Can't find wine? */}
              {!loading && search.trim() && !aiIdentified && !aiMatch && !aiSearching && (
                <div className="ai-search-row" onClick={!aiSearching ? handleAiIdentify : undefined} role="button" tabIndex={0} onKeyDown={e => { if ((e.key === 'Enter' || e.key === ' ') && !aiSearching) { e.preventDefault(); handleAiIdentify(); } }}>
                  <div className="ai-search-row-icon">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                      <path d="M11 8a3 3 0 0 1 3 3" opacity="0.5"/>
                    </svg>
                  </div>
                  <div className="ai-search-row-body">
                    <span className="ai-search-row-title">{t('addToWishlist.cantFind')}</span>
                    <span className="ai-search-row-hint">{t('addToWishlist.tapToIdentify')}</span>
                  </div>
                  <svg className="ai-search-row-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
                </div>
              )}

              {aiSearching && (
                <div className="ai-searching-state">
                  <div className="ai-searching-spinner" />
                  <p>{t('addToWishlist.identifying')}</p>
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
              {t('addToWishlist.change')}
            </button>
          </div>

          <form onSubmit={handleSave}>
            <div className="grid-2" style={{ marginTop: '1.25rem' }}>
              <div className="form-group">
                <label>{t('addToWishlist.vintage')}</label>
                <input
                  type="text"
                  value={vintage}
                  onChange={(e) => setVintage(e.target.value)}
                  placeholder={t('addToWishlist.vintagePlaceholder')}
                  maxLength={20}
                />
              </div>
              <div className="form-group">
                <label>{t('addToWishlist.priority')}</label>
                <select value={priority} onChange={(e) => setPriority(e.target.value)}>
                  <option value="low">{t('addToWishlist.priorityLow')}</option>
                  <option value="medium">{t('addToWishlist.priorityMedium')}</option>
                  <option value="high">{t('addToWishlist.priorityHigh')}</option>
                </select>
              </div>
              <div className="form-group form-group-full">
                <label>{t('addToWishlist.notes')}</label>
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder={t('addToWishlist.notesPlaceholder')}
                  rows="3"
                  maxLength={2000}
                />
              </div>
            </div>
            <div className="form-actions">
              <button type="submit" className="btn btn-success" disabled={saving}>
                {saving ? t('addToWishlist.saving') : t('addToWishlist.addBtn')}
              </button>
              <button type="button" onClick={() => navigate('/wishlist')} className="btn btn-secondary">
                {t('addToWishlist.cancel')}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Soft-zone "did you mean?" — same two-phase dialog as AddBottle:
          resolve-phase answers write nothing ("create new" only carries the
          fields + confirmCreate to the save); commit-phase answers resume the
          interrupted save immediately. */}
      {softCandidates && (
        <SimilarWinesModal
          candidates={softCandidates}
          queryName={softPending?.queryLabel || softPending?.wineData?.name}
          busy={findingWine || saving}
          onPick={(wine) => {
            if (softPending?.forCommit) {
              setSoftCandidates(null);
              setSoftPending(null);
              setSelectedWine(wine);
              setPendingNewWine(null);
              saveItem({ wineId: wine._id });
            } else {
              applyResolvedWine(wine);
            }
          }}
          onCreateNew={() => {
            if (!softPending) return;
            if (softPending.forCommit) {
              const confirmed = { ...pendingNewWine, confirmCreate: true };
              setSoftCandidates(null);
              setSoftPending(null);
              setPendingNewWine(confirmed);
              saveItem({ newWinePayload: confirmed });
            } else {
              applyPendingNewWine({ ...softPending.wineData, confirmCreate: true });
            }
          }}
          onCancel={() => { setSoftCandidates(null); setSoftPending(null); }}
        />
      )}
    </div>
  );
}

export default AddToWishlist;
