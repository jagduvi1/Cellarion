import { useState, useEffect, useMemo, useCallback, useRef, lazy, Suspense } from 'react';
import { useParams, Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { getCellar } from '../api/cellars';
import { getRacks, deleteRack, updateSlot, clearSlot, moveSlot, createRack, updateRack, disableSlot, enableSlot } from '../api/racks';
import { consumeBottle } from '../api/bottles';
import { getTotalSlots, getModularTotalSlots } from '../utils/rackLayouts';
import RackRenderer from '../components/racks/RackRenderer';
import ShelfView from '../components/racks/ShelfView';
// Lazy: ShelfView3D pulls in three.js (~250 kB gzip) — only load it when the
// user actually switches to the 3D view, not on every visit to the racks page.
const ShelfView3D = lazy(() => import('../components/racks/ShelfView3D'));
import RackTypeSelector, { TYPE_DIMENSIONS } from '../components/racks/RackTypeSelector';
import RatingInput from '../components/RatingInput';
import WineImage from '../components/WineImage';
import ConfirmModal from '../components/ConfirmModal';
import JournalPrompt, { journalPromptOptedOut } from '../components/JournalPrompt';
import ArrangeModal from '../components/racks/ArrangeModal';
import ZoneEditorModal from '../components/racks/ZoneEditorModal';
import RackAuditModal from '../components/racks/RackAuditModal';
import { LENSES, getLensStyle, getLensLegend, bottleMatchesSearch } from '../utils/rackLens';
import './CellarRacks.css';

function CellarRacks() {
  const { t } = useTranslation();
  const { id } = useParams();
  const { apiFetch, user } = useAuth();
  const [searchParams] = useSearchParams();
  const highlightBottleId = searchParams.get('highlight');
  const [highlightPos, setHighlightPos] = useState(null); // { rackId, position }

  const [cellar, setCellar]   = useState(null);
  const [racks, setRacks]     = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);

  // "new rack" form
  const [showNewRack, setShowNewRack] = useState(false);
  const [newRack, setNewRack]         = useState({ name: '', type: 'grid', rows: 4, cols: 8, typeConfig: {} });
  const [saving, setSaving]           = useState(false);
  // which rack tab is selected
  const [selectedRackId, setSelectedRackId] = useState(null);

  // View mode for the active rack: 'compact' (default, existing renderer) or
  // 'shelf' (top-down per-shelf view). Only meaningful for shelf racks.
  // Persisted to localStorage so the user's choice survives navigation —
  // e.g. clicking a bottle's rack position from the wine list returns them
  // to whichever view they were in last.
  const [viewMode, setViewModeState] = useState(() => {
    try {
      const stored = window.localStorage.getItem('cellarion.rackViewMode');
      // 'iso' was a short-lived option (deprecated in v1.53.1) — fall back to
      // the closest equivalent so returning users don't see a missing view.
      if (stored === 'iso') return 'shelf';
      return stored || 'compact';
    } catch {
      return 'compact';
    }
  });
  const setViewMode = (mode) => {
    setViewModeState(mode);
    try {
      window.localStorage.setItem('cellarion.rackViewMode', mode);
    } catch {
      // localStorage unavailable (e.g. private mode) — view mode just won't persist
    }
  };

  // Lens: which dimension colors the slots (type = classic wine-type colors).
  // Persisted like the view mode so the choice survives navigation.
  const [lens, setLensState] = useState(() => {
    try {
      const stored = window.localStorage.getItem('cellarion.rackLens');
      return LENSES.includes(stored) ? stored : 'type';
    } catch {
      return 'type';
    }
  });
  const setLens = (l) => {
    setLensState(l);
    try {
      window.localStorage.setItem('cellarion.rackLens', l);
    } catch {
      // not persisted — fine
    }
  };

  // Free-text search across rack slots — non-matching slots are dimmed.
  const [rackSearch, setRackSearch] = useState('');
  const searchActive = rackSearch.trim().length > 0;

  // Per-slot style callback for the renderers; null = default rendering.
  // Empty/disabled slots and non-matching bottles dim while searching so
  // matches pop; the lens picks the fill for filled slots.
  const getSlotStyle = useMemo(() => {
    if (lens === 'type' && !searchActive) return null;
    return (slot) => {
      const bottle = slot?.bottle;
      const style = bottle ? getLensStyle(lens, bottle) : null;
      const dim = searchActive && (!bottle || !bottleMatchesSearch(bottle, rackSearch));
      return { ...(style || {}), dim };
    };
  }, [lens, searchActive, rackSearch]);

  // While searching, show a match count on every rack tab so cross-rack
  // hits are visible from the current rack.
  const matchCounts = useMemo(() => {
    if (!searchActive) return null;
    const counts = {};
    for (const r of racks) {
      counts[r._id] = r.slots.filter(s => s.bottle && bottleMatchesSearch(s.bottle, rackSearch)).length;
    }
    return counts;
  }, [racks, searchActive, rackSearch]);

  // active popup: { rackId, position, slot: slotData|null } — rendered as fixed modal
  const [activePopup, setActivePopup] = useState(null);

  // consume modal: { bottleId, bottle } or null
  const [consumeModal, setConsumeModal] = useState(null);

  // "Organize this rack" modal
  const [arrangeOpen, setArrangeOpen] = useState(false);

  // Zone editor modal
  const [zonesOpen, setZonesOpen] = useState(false);

  // Audit mode modal
  const [auditOpen, setAuditOpen] = useState(false);

  // consumed bottle awaiting the "add to journal?" prompt, or null
  const [journalBottle, setJournalBottle] = useState(null);

  // NFC modal: { rackId } or null
  const [nfcModal, setNfcModal] = useState(null);

  // Delete confirmation: rackId or null
  const [deleteConfirm, setDeleteConfirm] = useState(null);

  useEffect(() => {
    fetchAll();
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const focusRackId = searchParams.get('rack');

  // When racks load and a highlight param is set, find and select that slot
  useEffect(() => {
    if (!highlightBottleId || racks.length === 0) return;
    for (const rack of racks) {
      const slot = rack.slots.find(s => {
        const bid = s.bottle?._id || s.bottle;
        return bid && bid.toString() === highlightBottleId;
      });
      if (slot) {
        setSelectedRackId(rack._id);
        setHighlightPos({ rackId: rack._id, position: slot.position });
        return;
      }
    }
  }, [highlightBottleId, racks]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-select rack when navigating from room view with ?rack=<id>
  useEffect(() => {
    if (!focusRackId || racks.length === 0) return;
    const found = racks.find(r => r._id === focusRackId);
    if (found) {
      setSelectedRackId(found._id);
      // Scroll to the rack after a short delay for rendering
      setTimeout(() => {
        const el = document.getElementById(`rack-${found._id}`);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 100);
    }
  }, [focusRackId, racks]);

  const fetchAll = async () => {
    try {
      const [cellarRes, racksRes] = await Promise.all([
        getCellar(apiFetch, id),
        getRacks(apiFetch, id)
      ]);
      const cellarData = await cellarRes.json();
      const racksData  = await racksRes.json();

      if (!cellarRes.ok) { setError(cellarData.error || 'Failed to load cellar'); return; }
      if (!racksRes.ok)  { setError(racksData.error  || 'Failed to load racks');  return; }

      setCellar(cellarData.cellar);
      const loadedRacks = racksData.racks || [];
      setRacks(loadedRacks);
      if (loadedRacks.length > 0) setSelectedRackId(r => r || loadedRacks[0]._id);
    } catch {
      setError('Network error');
    } finally {
      setLoading(false);
    }
  };

  // --- create rack ---
  const handleCreateRack = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const payload = {
        cellar: id,
        name: newRack.name,
        type: newRack.type,
        rows: newRack.rows,
        cols: newRack.cols,
      };
      if (newRack.typeConfig && Object.keys(newRack.typeConfig).length > 0) {
        const typeConfig = { ...newRack.typeConfig };
        // Drop double-height rows outside the final row count — the rows
        // input may have been lowered after they were typed, and the
        // backend rejects out-of-range entries with a 400.
        if (Array.isArray(typeConfig.doubleHeightRows)) {
          typeConfig.doubleHeightRows = typeConfig.doubleHeightRows
            .filter(r => r >= 1 && r <= newRack.rows);
          if (typeConfig.doubleHeightRows.length === 0) delete typeConfig.doubleHeightRows;
        }
        payload.typeConfig = typeConfig;
      }
      const res = await createRack(apiFetch, payload);
      const data = await res.json();
      if (res.ok) {
        setRacks([...racks, data.rack]);
        setSelectedRackId(data.rack._id);
        setNewRack({ name: '', type: 'grid', rows: 4, cols: 8, typeConfig: {} });
        setShowNewRack(false);
      } else {
        alert(data.error || 'Failed to create rack');
      }
    } finally {
      setSaving(false);
    }
  };

  // When rack type changes, reset dimensions to sensible defaults
  const handleTypeChange = (type) => {
    const dims = TYPE_DIMENSIONS[type] || TYPE_DIMENSIONS.grid;
    setNewRack(prev => ({
      ...prev,
      type,
      rows: dims.defaultRows,
      cols: dims.defaultCols,
      typeConfig: type === 'cube'
        ? { moduleRows: 2, moduleCols: 2 }
        : type === 'x-rack' ? { bottlesPerSection: 10 }
        : type === 'shelf' ? { bottlesPerCell: 1, backCols: 0 } : {},
    }));
  };

  // --- delete rack ---
  const handleDeleteRack = async (rackId) => {
    try {
      const res = await deleteRack(apiFetch, rackId);
      if (res.ok) {
        const remaining = racks.filter(r => r._id !== rackId);
        setRacks(remaining);
        if (selectedRackId === rackId) {
          setSelectedRackId(remaining.length > 0 ? remaining[0]._id : null);
        }
      } else {
        const data = await res.json();
        alert(data.error || 'Failed to delete rack');
      }
    } finally {
      setDeleteConfirm(null);
    }
  };

  // --- assign bottle to slot ---
  const handleAssign = async (rackId, position, bottleId) => {
    const res = await updateSlot(apiFetch, rackId, position, { bottleId });
    const data = await res.json();
    if (res.ok) {
      setRacks(racks.map(r => r._id === rackId ? data.rack : r));
    } else {
      alert(data.error || 'Failed to assign');
    }
    setActivePopup(null);
  };

  // --- case placement: assign several bottles of the same wine to the free
  // positions from startPosition onward. Sequential on purpose — each save
  // bumps the rack version, so parallel PUTs would 409 each other.
  const handleAssignMany = async (rackId, startPosition, bottleIds) => {
    const r = racks.find(x => x._id === rackId);
    if (!r) return;
    const total = r.isModular && r.modules?.length > 0
      ? getModularTotalSlots(r.modules)
      : getTotalSlots(r.type || 'grid', r.rows, r.cols, r.typeConfig);
    const occupied = new Set(r.slots.map(s => s.position));
    const disabled = new Set(r.disabledPositions || []);
    const targets = [];
    for (let p = startPosition; p <= total && targets.length < bottleIds.length; p++) {
      if (!occupied.has(p) && !disabled.has(p)) targets.push(p);
    }
    for (let i = 0; i < targets.length; i++) {
      try {
        const res = await updateSlot(apiFetch, rackId, targets[i], { bottleId: bottleIds[i] });
        const data = await res.json();
        if (!res.ok) {
          alert(data.error || 'Failed to place bottles');
          break;
        }
        setRacks(prev => prev.map(x => x._id === rackId ? data.rack : x));
      } catch {
        alert('Network error — please try again.');
        break;
      }
    }
    setActivePopup(null);
  };

  // --- remove bottle from slot (keep bottle in cellar) ---
  const handleRemoveFromRack = async (rackId, position) => {
    const res = await clearSlot(apiFetch, rackId, position);
    const data = await res.json();
    if (res.ok) {
      setRacks(racks.map(r => r._id === rackId ? data.rack : r));
    }
    setActivePopup(null);
  };

  // --- disable / re-enable a slot position ---
  const handleDisableSlot = async (rackId, position) => {
    const res = await disableSlot(apiFetch, rackId, position);
    const data = await res.json();
    if (res.ok) {
      setRacks(racks.map(r => r._id === rackId ? data.rack : r));
    } else {
      alert(data.error || 'Failed to disable slot');
    }
    setActivePopup(null);
  };

  const handleEnableSlot = async (rackId, position) => {
    const res = await enableSlot(apiFetch, rackId, position);
    const data = await res.json();
    if (res.ok) {
      setRacks(racks.map(r => r._id === rackId ? data.rack : r));
    } else {
      alert(data.error || 'Failed to enable slot');
    }
    setActivePopup(null);
  };

  // --- soft-remove bottle via the shared consume endpoint ---
  const handleConsumeSubmit = async (reason, note, rating, consumedRatingScale) => {
    const { bottleId, bottle } = consumeModal;
    try {
      const res = await consumeBottle(apiFetch, bottleId, { reason, note, rating, consumedRatingScale });
      const data = await res.json();
      if (res.ok) {
        // Server already cleared the rack slot; update local racks state
        setRacks(prev => prev.map(r => ({
          ...r,
          slots: r.slots.filter(s => {
            const bid = s.bottle?._id || s.bottle;
            return bid?.toString() !== bottleId;
          })
        })));
        setConsumeModal(null);
        if (reason === 'drank' && !journalPromptOptedOut()) {
          setJournalBottle(bottle);
        }
      } else {
        alert(data.error || 'Failed to remove bottle');
      }
    } catch {
      // Don't rethrow — ConsumeModal awaits this and must reach setSaving(false)
      alert('Network error — please try again.');
    }
  };

  // --- drag & drop: move a bottle to another slot / swap two bottles ---
  const handleSlotMove = async (rackId, fromPosition, toPosition) => {
    try {
      const res = await moveSlot(apiFetch, rackId, fromPosition, toPosition);
      const data = await res.json();
      if (res.ok) {
        setRacks(prev => prev.map(r => r._id === rackId ? data.rack : r));
      } else {
        alert(data.error || 'Failed to move bottle');
      }
    } catch {
      alert('Network error — please try again.');
    }
  };

  // Audit-mode fix: clear a slot whose bottle is physically gone.
  const auditClearSlot = async (rackId, position) => {
    try {
      const res = await clearSlot(apiFetch, rackId, position);
      const data = await res.json();
      if (!res.ok) return false;
      setRacks(prev => prev.map(r => r._id === rackId ? data.rack : r));
      return true;
    } catch {
      return false;
    }
  };

  // Zone editor save — PUT the zones array, adopt the returned rack.
  const saveZones = async (rackId, zones) => {
    try {
      const res = await updateRack(apiFetch, rackId, { zones });
      const data = await res.json();
      if (!res.ok) return false;
      setRacks(prev => prev.map(r => r._id === rackId ? data.rack : r));
      return true;
    } catch {
      return false;
    }
  };

  // Auto-arrange step: same move endpoint, but reports success back to the
  // modal's apply loop instead of alerting (the modal shows the error).
  const applyArrangeStep = async (rackId, fromPosition, toPosition) => {
    try {
      const res = await moveSlot(apiFetch, rackId, fromPosition, toPosition);
      const data = await res.json();
      if (!res.ok) return false;
      setRacks(prev => prev.map(r => r._id === rackId ? data.rack : r));
      return true;
    } catch {
      return false;
    }
  };

  // --- NFC: save or clear rfidTag on rack ---
  const handleNfcSave = async (rackId, rfidTag) => {
    try {
      const res = await updateRack(apiFetch, rackId, { rfidTag });
      const data = await res.json();
      if (res.ok) {
        setRacks(racks.map(r => r._id === rackId ? { ...r, rfidTag: data.rack.rfidTag } : r));
        setNfcModal(null);
      } else {
        // Keep the modal open so the user can retry instead of silently losing the tag
        alert(data.error || 'Failed to save NFC tag');
      }
    } catch {
      alert('Network error — please try again.');
    }
  };

  if (error) return <div className="alert alert-error">{error}</div>;

  const rack = racks.find(r => r._id === selectedRackId) || racks[0];
  const canEdit = cellar?.userRole !== 'viewer';

  return (
    <div className="cellar-racks-page">
      <div className="cellarracks-header">
        <div>
          <Link to={`/cellars/${id}`} className="back-link">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"/></svg>
            {t('racks.backToCellar')}
          </Link>
          {loading ? (
            <div className="skeleton-h1" />
          ) : (
            <>
              <h1 style={cellar?.userColor ? { borderLeft: `4px solid ${cellar.userColor}`, paddingLeft: '0.75rem' } : {}}>
                {cellar?.name}
              </h1>
              <p className="cellar-description">{t('racks.title')}</p>
            </>
          )}
        </div>
        {!loading && (
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <Link to={`/cellars/${id}/room`} className="btn btn-secondary btn-small">
              {t('room.title', 'Room View')}
            </Link>
            <Link to={`/cellars/${id}/book`} className="btn btn-secondary btn-small">
              {t('cellarBook.linkBtn', 'Cellar Book')}
            </Link>
            {canEdit && (
              <button className="btn btn-primary" onClick={() => setShowNewRack(v => !v)}>
                {showNewRack ? t('common.cancel') : `+ ${t('racks.newRack')}`}
              </button>
            )}
          </div>
        )}
      </div>

      {loading ? (
        <div className="loading">{t('racks.loadingRacks')}</div>
      ) : <>

      {canEdit && showNewRack && (
        <div className="new-rack-section">
          <NewRackForm
            newRack={newRack}
            setNewRack={setNewRack}
            onTypeChange={handleTypeChange}
            onSubmit={handleCreateRack}
            saving={saving}
          />
        </div>
      )}

      {racks.length === 0 ? (
        <div className="empty-state">
          <p>{t('racks.noRacks')}</p>
        </div>
      ) : (
        <>
          <div className="rack-tabs">
            {racks.map(r => (
              <button
                key={r._id}
                className={`rack-tab ${r._id === rack._id ? 'active' : ''}`}
                onClick={() => { setSelectedRackId(r._id); setActivePopup(null); }}
              >
                {r.name}
                <span className="rack-tab-count">
                  {r.slots.length}/{(r.isModular && r.modules?.length > 0
                    ? getModularTotalSlots(r.modules)
                    : getTotalSlots(r.type || 'grid', r.rows, r.cols, r.typeConfig))
                    - (r.disabledPositions?.length || 0)}
                </span>
                {matchCounts && (
                  <span className={`rack-tab-matches ${matchCounts[r._id] > 0 ? 'has-matches' : ''}`}>
                    {matchCounts[r._id]}
                  </span>
                )}
              </button>
            ))}
          </div>

          {/* Lens + search toolbar (the 3D shelf view doesn't support lenses yet) */}
          {!(rack.type === 'shelf' && !rack.isModular && viewMode === '3d') && (
            <>
              <div className="rack-lens-toolbar">
                <div className="rack-lens-search-wrap">
                  <svg className="rack-lens-search-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                  <input
                    type="search"
                    className="rack-lens-search"
                    placeholder={t('rackLens.searchPlaceholder', 'Find in racks…')}
                    aria-label={t('rackLens.searchPlaceholder', 'Find in racks…')}
                    value={rackSearch}
                    onChange={e => setRackSearch(e.target.value)}
                  />
                  {searchActive && (
                    <button
                      type="button"
                      className="rack-lens-search-clear"
                      onClick={() => setRackSearch('')}
                      aria-label={t('common.clear', 'Clear')}
                    >
                      ×
                    </button>
                  )}
                </div>
                <div className="rack-lens-segment" role="tablist" aria-label={t('rackLens.colorBy', 'Color by')}>
                  <button role="tab" aria-selected={lens === 'type'} className={`rack-lens-segment-btn ${lens === 'type' ? 'active' : ''}`} onClick={() => setLens('type')}>
                    {t('rackLens.lensType', 'Wine type')}
                  </button>
                  <button role="tab" aria-selected={lens === 'maturity'} className={`rack-lens-segment-btn ${lens === 'maturity' ? 'active' : ''}`} onClick={() => setLens('maturity')}>
                    {t('rackLens.lensMaturity', 'Drink window')}
                  </button>
                  <button role="tab" aria-selected={lens === 'age'} className={`rack-lens-segment-btn ${lens === 'age' ? 'active' : ''}`} onClick={() => setLens('age')}>
                    {t('rackLens.lensAge', 'Bottle age')}
                  </button>
                  <button role="tab" aria-selected={lens === 'rating'} className={`rack-lens-segment-btn ${lens === 'rating' ? 'active' : ''}`} onClick={() => setLens('rating')}>
                    {t('rackLens.lensRating', 'My rating')}
                  </button>
                </div>
                {canEdit && rack.slots.length >= 2 && (
                  <button className="btn btn-secondary btn-small rack-arrange-btn" onClick={() => setArrangeOpen(true)}>
                    {t('arrange.openBtn', 'Organize…')}
                  </button>
                )}
                {canEdit && rack.slots.length > 0 && (
                  <button className="btn btn-secondary btn-small rack-arrange-btn" onClick={() => setAuditOpen(true)}>
                    {t('audit.openBtn', 'Audit')}
                  </button>
                )}
              </div>
              <div className="rack-lens-legend" aria-hidden="true">
                {getLensLegend(lens).map(e => (
                  <span key={e.tKey} className="rack-lens-chip">
                    <span className="rack-lens-dot" style={{ background: e.fill }} />
                    {t(e.tKey)}
                  </span>
                ))}
              </div>
              {canEdit && (
                <p className="rack-drag-hint">
                  {t('rackLens.dragHint', 'Tip: drag a bottle to an empty slot to move it, onto another bottle to swap them.')}
                </p>
              )}
            </>
          )}
          {rack.type === 'shelf' && !rack.isModular && (
            <div className="rack-view-mode-toggle" role="tablist">
              <button
                role="tab"
                aria-selected={viewMode === 'compact'}
                className={`view-mode-btn ${viewMode === 'compact' ? 'active' : ''}`}
                onClick={() => setViewMode('compact')}
              >
                {t('racks.viewCompact')}
              </button>
              <button
                role="tab"
                aria-selected={viewMode === 'shelf'}
                className={`view-mode-btn ${viewMode === 'shelf' ? 'active' : ''}`}
                onClick={() => setViewMode('shelf')}
              >
                {t('racks.viewShelf')}
              </button>
              <button
                role="tab"
                aria-selected={viewMode === '3d'}
                className={`view-mode-btn ${viewMode === '3d' ? 'active' : ''}`}
                onClick={() => setViewMode('3d')}
              >
                {t('racks.view3d')}
              </button>
            </div>
          )}
          <div id={`rack-${rack._id}`}>
          {rack.type === 'shelf' && !rack.isModular && (viewMode === 'shelf' || viewMode === '3d') ? (
            (() => {
              const handleClick = (pos, slotData) => {
                const isDisabled = (rack.disabledPositions || []).includes(pos);
                // Viewers can inspect filled or disabled slots, not empty ones
                if (!canEdit && !slotData && !isDisabled) return;
                if (activePopup?.rackId === rack._id && activePopup?.position === pos) {
                  setActivePopup(null);
                } else {
                  setActivePopup({ rackId: rack._id, position: pos, slot: slotData || null });
                }
              };
              const commonProps = {
                rack,
                activePosition: activePopup?.rackId === rack._id ? activePopup.position : null,
                highlightPos: highlightPos?.rackId === rack._id ? highlightPos.position : null,
                onSlotClick: handleClick,
                getSlotStyle,
                onSlotMove: canEdit ? (from, to) => handleSlotMove(rack._id, from, to) : undefined,
              };
              if (viewMode === '3d') {
                return (
                  <Suspense fallback={<div className="loading">{t('common.loading')}</div>}>
                    <ShelfView3D {...commonProps} />
                  </Suspense>
                );
              }
              return <ShelfView {...commonProps} />;
            })()
          ) : (
            <RackRenderer
              rack={rack}
              canEdit={canEdit}
              activeRackId={activePopup?.rackId}
              activePosition={activePopup?.position}
              highlightPos={highlightPos?.rackId === rack._id ? highlightPos.position : null}
              getSlotStyle={getSlotStyle}
              onSlotMove={canEdit ? (from, to) => handleSlotMove(rack._id, from, to) : undefined}
              onSlotClick={(pos, slotData) => {
                // Viewers can only inspect filled or disabled slots, not interact with empty ones
                const isDisabled = (rack.disabledPositions || []).includes(pos);
                if (!canEdit && !slotData && !isDisabled) return;
                if (activePopup?.rackId === rack._id && activePopup?.position === pos) {
                  setActivePopup(null);
                } else {
                  setActivePopup({ rackId: rack._id, position: pos, slot: slotData || null });
                }
              }}
              onDelete={() => setDeleteConfirm(rack._id)}
              onNfcLink={() => setNfcModal({ rackId: rack._id })}
              onZones={() => setZonesOpen(true)}
            />
          )}
          </div>
        </>
      )}

      </>}

      {/* Page-level fixed slot modal */}
      {activePopup && (() => {
        const popupRack = racks.find(r => r._id === activePopup.rackId);
        const popupDisabled = !activePopup.slot &&
          (popupRack?.disabledPositions || []).includes(activePopup.position);
        const popupZone = (popupRack?.zones || []).find(
          z => (z.positions || []).includes(activePopup.position)
        ) || null;
        // Free positions from this slot onward — the cap for case placement.
        let popupFreeRun = 0;
        if (popupRack && !activePopup.slot) {
          const totalPos = popupRack.isModular && popupRack.modules?.length > 0
            ? getModularTotalSlots(popupRack.modules)
            : getTotalSlots(popupRack.type || 'grid', popupRack.rows, popupRack.cols, popupRack.typeConfig);
          const occupiedPos = new Set(popupRack.slots.map(s => s.position));
          const disabledPos = new Set(popupRack.disabledPositions || []);
          for (let p = activePopup.position; p <= totalPos; p++) {
            if (!occupiedPos.has(p) && !disabledPos.has(p)) popupFreeRun++;
          }
        }
        return (
          <div className="slot-modal-overlay" onClick={() => setActivePopup(null)} role="dialog" aria-modal="true">
            <div className="slot-modal" onClick={e => e.stopPropagation()}>
              {activePopup.slot ? (
                <FilledSlotContent
                  position={activePopup.position}
                  slot={activePopup.slot}
                  zone={popupZone}
                  canEdit={canEdit}
                  onRemoveFromRack={() => handleRemoveFromRack(activePopup.rackId, activePopup.position)}
                  onConsume={() => {
                    setConsumeModal({ bottleId: activePopup.slot.bottle._id, bottle: activePopup.slot.bottle });
                    setActivePopup(null);
                  }}
                  onClose={() => setActivePopup(null)}
                />
              ) : popupDisabled ? (
                <DisabledSlotContent
                  position={activePopup.position}
                  canEdit={canEdit}
                  onEnable={() => handleEnableSlot(activePopup.rackId, activePopup.position)}
                  onClose={() => setActivePopup(null)}
                />
              ) : (
                <EmptySlotContent
                  position={activePopup.position}
                  zone={popupZone}
                  apiFetch={apiFetch}
                  cellarId={id}
                  canEdit={canEdit}
                  freeRun={popupFreeRun}
                  onAssignMany={canEdit
                    ? (bottleIds) => handleAssignMany(activePopup.rackId, activePopup.position, bottleIds)
                    : undefined}
                  onAssign={(pos, bottleId) => handleAssign(activePopup.rackId, pos, bottleId)}
                  onDisable={() => handleDisableSlot(activePopup.rackId, activePopup.position)}
                  onClose={() => setActivePopup(null)}
                />
              )}
            </div>
          </div>
        );
      })()}

      {/* Consume/remove modal */}
      {consumeModal && (
        <ConsumeModal
          defaultRatingScale={user?.preferences?.ratingScale || '5'}
          onSubmit={handleConsumeSubmit}
          onCancel={() => setConsumeModal(null)}
        />
      )}

      {/* Post-consume "add to journal?" prompt */}
      {journalBottle && (
        <JournalPrompt bottle={journalBottle} onDone={() => setJournalBottle(null)} />
      )}

      {/* Auto-arrange modal */}
      {arrangeOpen && rack && (
        <ArrangeModal
          rack={rack}
          maxPosition={rack.isModular && rack.modules?.length > 0
            ? getModularTotalSlots(rack.modules)
            : getTotalSlots(rack.type || 'grid', rack.rows, rack.cols, rack.typeConfig)}
          onMoveStep={(from, to) => applyArrangeStep(rack._id, from, to)}
          onClose={() => setArrangeOpen(false)}
        />
      )}

      {/* Zone editor modal */}
      {zonesOpen && rack && (
        <ZoneEditorModal
          rack={rack}
          onSave={(zones) => saveZones(rack._id, zones)}
          onClose={() => setZonesOpen(false)}
        />
      )}

      {/* Audit mode modal */}
      {auditOpen && rack && (
        <RackAuditModal
          rack={rack}
          canEdit={canEdit}
          onClearSlot={(position) => auditClearSlot(rack._id, position)}
          onClose={() => setAuditOpen(false)}
        />
      )}

      {/* NFC link modal */}
      {nfcModal && (
        <NfcLinkModal
          rack={racks.find(r => r._id === nfcModal.rackId)}
          onSave={(rfidTag) => handleNfcSave(nfcModal.rackId, rfidTag)}
          onCancel={() => setNfcModal(null)}
        />
      )}

      {/* Delete rack confirmation */}
      {deleteConfirm && (() => {
        const rackToDelete = racks.find(r => r._id === deleteConfirm);
        if (!rackToDelete) return null;
        const bottleCount = (rackToDelete.slots || []).length;
        return (
          <ConfirmModal
            title={t('racks.deleteRack')}
            message={t('racks.deleteConfirmName', { name: rackToDelete.name })}
            warning={bottleCount > 0 ? t('racks.deleteConfirmBottles', { count: bottleCount }) : undefined}
            confirmLabel={t('racks.deleteRack')}
            onConfirm={() => handleDeleteRack(deleteConfirm)}
            onCancel={() => setDeleteConfirm(null)}
          />
        );
      })()}
    </div>
  );
}

// Parse a comma-separated "double-height rows" input ("1, 3") into a
// deduplicated array of positive integers. Range-checking against the row
// count happens in handleCreateRack (the rows input can change afterwards)
// and defensively in the layout/geometry helpers.
function parseDoubleHeightRows(text) {
  const seen = new Set();
  return String(text)
    .split(',')
    .map(s => parseInt(s.trim(), 10))
    .filter(n => {
      if (!Number.isInteger(n) || n < 1 || n > 20 || seen.has(n)) return false;
      seen.add(n);
      return true;
    });
}

// ---- New rack creation form with type selector ----
function NewRackForm({ newRack, setNewRack, onTypeChange, onSubmit, saving }) {
  const { t } = useTranslation();
  const dims = TYPE_DIMENSIONS[newRack.type] || TYPE_DIMENSIONS.grid;
  const [showPreview, setShowPreview] = useState(false);
  // Raw text of the double-height rows input (grid only). Kept as text so
  // partial input like "1," doesn't fight the parser; cleared when the rack
  // type changes (the parent resets typeConfig at the same time).
  const [doubleRowsText, setDoubleRowsText] = useState('');
  useEffect(() => { setDoubleRowsText(''); }, [newRack.type]);

  // Synthetic rack for the preview renderer — empty slots, just the geometry.
  const previewRack = {
    _id: 'preview',
    name: newRack.name || t('racks.namePlaceholder', 'Preview'),
    type: newRack.type,
    rows: newRack.rows,
    cols: newRack.cols,
    typeConfig: newRack.typeConfig,
    slots: [],
    isModular: false,
  };

  return (
    <form className="card new-rack-form" onSubmit={onSubmit}>
      <h3>{t('racks.newRackTitle')}</h3>

      <RackTypeSelector value={newRack.type} onChange={onTypeChange} />

      <div className="new-rack-fields">
        <div className="form-group">
          <label>{t('racks.nameLabel')}</label>
          <input
            type="text"
            value={newRack.name}
            onChange={e => setNewRack({ ...newRack, name: e.target.value })}
            placeholder={t('racks.namePlaceholder')}
            required
          />
        </div>

        {dims.showRows && (
          <div className="form-group">
            <label>{t(dims.rowLabel || 'racks.rowsLabel')}</label>
            <input
              type="number"
              min={1} max={20}
              value={newRack.rows}
              onChange={e => setNewRack({ ...newRack, rows: parseInt(e.target.value) || dims.defaultRows })}
            />
          </div>
        )}

        {dims.showCols && (
          <div className="form-group">
            <label>{t(dims.colLabel || 'racks.colsLabel')}</label>
            <input
              type="number"
              min={1} max={20}
              value={newRack.cols}
              onChange={e => setNewRack({ ...newRack, cols: parseInt(e.target.value) || dims.defaultCols })}
            />
          </div>
        )}

        {dims.showDoubleHeightRows && (
          <div className="form-group">
            <label>{t('racks.doubleHeightRowsLabel', 'Double-height rows')}</label>
            <input
              type="text"
              inputMode="numeric"
              value={doubleRowsText}
              placeholder={t('racks.doubleHeightRowsPlaceholder', 'e.g. 1,3')}
              onChange={e => {
                const text = e.target.value;
                setDoubleRowsText(text);
                const parsed = parseDoubleHeightRows(text);
                setNewRack({
                  ...newRack,
                  typeConfig: {
                    ...newRack.typeConfig,
                    doubleHeightRows: parsed.length > 0 ? parsed : undefined,
                  },
                });
              }}
            />
            <small style={{ color: 'var(--color-text-muted)', fontSize: '0.75rem' }}>
              {t('racks.doubleHeightRowsHelp', 'Rows with headroom for bottles resting on top')}
            </small>
          </div>
        )}

        {dims.showModule && (
          <>
            <div className="form-group">
              <label>{t('racks.moduleRowsLabel')}</label>
              <input
                type="number"
                min={1} max={10}
                value={newRack.typeConfig?.moduleRows || 2}
                onChange={e => setNewRack({
                  ...newRack,
                  typeConfig: { ...newRack.typeConfig, moduleRows: parseInt(e.target.value) || 2 }
                })}
              />
            </div>
            <div className="form-group">
              <label>{t('racks.moduleColsLabel')}</label>
              <input
                type="number"
                min={1} max={10}
                value={newRack.typeConfig?.moduleCols || 2}
                onChange={e => setNewRack({
                  ...newRack,
                  typeConfig: { ...newRack.typeConfig, moduleCols: parseInt(e.target.value) || 2 }
                })}
              />
            </div>
          </>
        )}

        {dims.showBottlesPerCell && (
          <div className="form-group">
            <label>{t('racks.bottlesPerCellLabel', 'Bottles per cell')}</label>
            <input
              type="number"
              min={1} max={20}
              value={newRack.typeConfig?.bottlesPerCell || 1}
              onChange={e => setNewRack({
                ...newRack,
                typeConfig: { ...newRack.typeConfig, bottlesPerCell: parseInt(e.target.value) || 1 }
              })}
            />
          </div>
        )}

        {dims.showBackCols && (
          <div className="form-group">
            <label>{t('racks.backColsLabel', 'Back row bottles (per shelf)')}</label>
            <input
              type="number"
              min={0} max={20}
              value={newRack.typeConfig?.backCols ?? 0}
              onChange={e => setNewRack({
                ...newRack,
                typeConfig: { ...newRack.typeConfig, backCols: Math.max(0, parseInt(e.target.value) || 0) }
              })}
            />
          </div>
        )}

        {dims.showBottlesPerSection && (
          <div className="form-group">
            <label>{t('racks.bottlesPerSectionLabel', 'Bottles per section')}</label>
            <input
              type="number"
              min={1} max={30}
              value={newRack.typeConfig?.bottlesPerSection || 10}
              onChange={e => setNewRack({
                ...newRack,
                typeConfig: { ...newRack.typeConfig, bottlesPerSection: parseInt(e.target.value) || 10 }
              })}
            />
          </div>
        )}

        <button
          type="button"
          className={`btn btn-secondary new-rack-preview-toggle ${showPreview ? 'active' : ''}`}
          onClick={() => setShowPreview(p => !p)}
        >
          {showPreview ? t('racks.hidePreview', 'Hide preview') : t('racks.preview', 'Preview')}
        </button>
        <button type="submit" className="btn btn-primary" disabled={saving}>
          {saving ? t('racks.creating') : t('racks.createRack')}
        </button>
      </div>

      <div className="new-rack-preview-hint">
        {t('racks.totalSlots')}: {getTotalSlots(newRack.type, newRack.rows, newRack.cols, newRack.typeConfig)}
      </div>

      {showPreview && (
        <div className="new-rack-preview-panel">
          <div className="new-rack-preview-label">
            {t('racks.previewLabel', 'Preview — this is how the rack will look once created')}
          </div>
          <div className="new-rack-preview-canvas">
            <RackRenderer
              rack={previewRack}
              canEdit={false}
              onSlotClick={() => {}}
            />
          </div>
        </div>
      )}
    </form>
  );
}

// ---- Content for empty slot: pick a bottle to place ----
/** Group unplaced bottles by wine + vintage so a case shows as one row ×N. */
function groupBottles(bottles) {
  const map = new Map();
  for (const b of bottles) {
    const key = `${b.wineDefinition?._id || b._id}:${b.vintage || ''}`;
    if (!map.has(key)) map.set(key, { key, sample: b, bottles: [] });
    map.get(key).bottles.push(b);
  }
  return [...map.values()];
}

function EmptySlotContent({ position, zone, apiFetch, cellarId, canEdit, onAssign, onAssignMany, freeRun, onDisable, onClose }) {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(true);
  // Case placement: the group being quantity-picked, chosen quantity, busy flag
  const [caseGroup, setCaseGroup] = useState(null);
  const [caseQty, setCaseQty] = useState(2);
  const [placing, setPlacing] = useState(false);
  const timerRef = useRef(null);

  // Fetch bottles from backend, excluding already-placed bottles server-side
  const fetchBottles = useCallback(async (term) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: '30' });
      if (term) params.set('search', term);
      // The backend excludes rack-placed bottles itself — sending every placed
      // bottle ID in the query string overflows the URL limit on big cellars.
      params.set('excludePlaced', '1');
      const res = await getCellar(apiFetch, cellarId, params.toString());
      const data = await res.json();
      if (res.ok) {
        setResults(data.bottles?.items || []);
      }
    } catch { /* ignore */ }
    setLoading(false);
  }, [apiFetch, cellarId]);

  // Load initial results on mount
  useEffect(() => { fetchBottles(''); }, [fetchBottles]);

  // Debounced search (300ms)
  const handleSearch = (value) => {
    setSearch(value);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => fetchBottles(value), 300);
  };

  // Cleanup timer on unmount
  useEffect(() => () => clearTimeout(timerRef.current), []);

  return (
    <>
      <div className="slot-popup-header">
        <span className="slot-popup-title">
          {t('racks.slotPlaceBottle', { position })}
          {zone && (
            <span className="slot-zone-chip">
              <span className="rack-zone-dot" style={{ background: zone.color || '#888' }} />
              {zone.name}
            </span>
          )}
        </span>
        <button className="slot-popup-close" onClick={onClose} aria-label="Close">&times;</button>
      </div>
      <input
        type="text"
        className="slot-search"
        placeholder={t('racks.searchWines')}
        value={search}
        onChange={e => handleSearch(e.target.value)}
        aria-label={t('racks.searchWines')}
        autoFocus
      />
      {caseGroup ? (
        /* Quantity picker: place several bottles of the same wine into the
           free slots starting at this position. */
        <div className="slot-case-panel">
          <p className="slot-case-title">
            <strong>{caseGroup.sample.wineDefinition?.name || t('common.unknown')}</strong>
            {caseGroup.sample.vintage ? ` (${caseGroup.sample.vintage})` : ''}
          </p>
          <p className="slot-case-hint">
            {t('racks.caseHint', 'Fills the free slots from here onward, in position order.')}
          </p>
          <div className="slot-case-qty">
            <button
              type="button"
              className="btn btn-secondary btn-small"
              onClick={() => setCaseQty(q => Math.max(2, q - 1))}
              disabled={placing || caseQty <= 2}
              aria-label="−"
            >
              −
            </button>
            <span className="slot-case-count">{caseQty}</span>
            <button
              type="button"
              className="btn btn-secondary btn-small"
              onClick={() => setCaseQty(q => Math.min(caseGroup.max, q + 1))}
              disabled={placing || caseQty >= caseGroup.max}
              aria-label="+"
            >
              +
            </button>
            <span className="slot-case-max">{t('racks.caseMax', 'max {{max}}', { max: caseGroup.max })}</span>
          </div>
          <div className="slot-popup-actions">
            <button className="btn btn-secondary btn-small" onClick={() => setCaseGroup(null)} disabled={placing}>
              {t('common.cancel')}
            </button>
            <button
              className="btn btn-primary btn-small"
              disabled={placing}
              onClick={async () => {
                setPlacing(true);
                // The parent closes the popup once every bottle is placed.
                await onAssignMany(caseGroup.bottles.slice(0, caseQty).map(b => b._id));
              }}
            >
              {placing
                ? t('racks.casePlacing', 'Placing…')
                : t('racks.casePlaceBtn', 'Place {{count}} bottles', { count: caseQty })}
            </button>
          </div>
        </div>
      ) : (
      <div className="slot-bottle-list">
        {loading ? (
          <p className="slot-empty-msg">…</p>
        ) : results.length === 0 ? (
          <p className="slot-empty-msg">{t('racks.noUnplacedBottles')}</p>
        ) : (
          groupBottles(results).map(g => (
            <div
              key={g.key}
              className="slot-bottle-item"
              onClick={() => onAssign(position, g.bottles[0]._id)}
              onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onAssign(position, g.bottles[0]._id)}
              role="button"
              tabIndex={0}
            >
              <span className={`slot-bottle-type-dot type-${g.sample.wineDefinition?.type || 'red'}`} aria-hidden="true" />
              <div className="slot-bottle-info">
                <strong>
                  {g.sample.wineDefinition?.name || t('common.unknown')}
                  {g.bottles.length > 1 && <span className="slot-case-badge">×{g.bottles.length}</span>}
                </strong>
                <span className="slot-bottle-meta">
                  {g.sample.wineDefinition?.producer} &middot; {g.sample.vintage}
                  {g.sample.wineDefinition?.country?.name ? ` \u00B7 ${g.sample.wineDefinition.country.name}` : ''}
                </span>
              </div>
              {onAssignMany && g.bottles.length > 1 && Math.min(g.bottles.length, freeRun || 0) > 1 && (
                <button
                  type="button"
                  className="btn btn-secondary btn-small slot-case-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    const max = Math.min(g.bottles.length, freeRun);
                    setCaseGroup({ ...g, max });
                    setCaseQty(Math.min(g.bottles.length, max));
                  }}
                >
                  {t('racks.caseOpenBtn', 'Place several\u2026')}
                </button>
              )}
            </div>
          ))
        )}
      </div>
      )}
      {canEdit && onDisable && (
        <div className="slot-popup-actions">
          <button className="btn btn-secondary btn-small" onClick={onDisable}>
            {t('racks.disableSlot')}
          </button>
        </div>
      )}
    </>
  );
}

// ---- Content for a disabled (unusable) slot ----
function DisabledSlotContent({ position, canEdit, onEnable, onClose }) {
  const { t } = useTranslation();
  return (
    <>
      <div className="slot-popup-header">
        <span className="slot-popup-title">{t('racks.disabledSlotTitle', { position })}</span>
        <button className="slot-popup-close" onClick={onClose} aria-label="Close">&times;</button>
      </div>
      <p className="slot-disabled-note">{t('racks.disabledSlotNote')}</p>
      {canEdit && (
        <div className="slot-popup-actions">
          <button className="btn btn-secondary btn-small" onClick={onEnable}>
            {t('racks.enableSlot')}
          </button>
        </div>
      )}
    </>
  );
}

// ---- Content for filled slot: show bottle info + actions ----
function FilledSlotContent({ position, slot, zone, canEdit, onRemoveFromRack, onConsume, onClose }) {
  const { t } = useTranslation();
  const bottle = slot.bottle;
  const wine = bottle?.wineDefinition;

  return (
    <>
      <div className="slot-popup-header">
        <span className="slot-popup-title">
          {t('racks.slotTitle', { position })}
          {zone && (
            <span className="slot-zone-chip">
              <span className="rack-zone-dot" style={{ background: zone.color || '#888' }} />
              {zone.name}
            </span>
          )}
        </span>
        <button className="slot-popup-close" onClick={onClose} aria-label="Close">&times;</button>
      </div>

      <div className="slot-bottle-detail">
        <WineImage image={wine?.image} alt={wine?.name} className="slot-detail-img" />
        <div className="slot-detail-info">
          <h4>{wine?.name || t('common.unknown')}</h4>
          {wine?.producer && <p className="slot-detail-producer">{wine.producer}</p>}
          <p className="slot-detail-meta">
            <span className={`slot-bottle-type-dot type-${wine?.type || 'red'}`} />
            {wine?.type} &middot; {bottle?.vintage}
          </p>
          {wine?.country?.name && (
            <p className="slot-detail-meta">
              {wine.country.name}{wine?.region?.name ? `, ${wine.region.name}` : ''}
            </p>
          )}
          {bottle?.notes && <p className="slot-detail-notes">{bottle.notes}</p>}
        </div>
      </div>

      {canEdit && (
        <div className="slot-popup-actions">
          <button className="btn btn-secondary btn-small" onClick={onRemoveFromRack}>
            {t('racks.removeFromRack')}
          </button>
          <button className="btn btn-consume btn-small" onClick={onConsume}>
            {t('racks.remove')}
          </button>
        </div>
      )}
    </>
  );
}

// ---- Consume / remove modal ----
function ConsumeModal({ defaultRatingScale, onSubmit, onCancel }) {
  const { t } = useTranslation();
  const [reason,       setReason]      = useState('drank');
  const [note,         setNote]        = useState('');
  const [rating,       setRating]      = useState('');
  const [ratingScale,  setRatingScale] = useState(defaultRatingScale || '5');
  const [saving,       setSaving]      = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      await onSubmit(reason, note || undefined, rating || undefined, ratingScale);
    } finally {
      // Always re-enable the button — a rejected onSubmit must not leave the
      // modal stuck on "Saving...".
      setSaving(false);
    }
  };

  return (
    <div className="slot-modal-overlay" onClick={onCancel}>
      <div className="slot-modal consume-modal-box" onClick={e => e.stopPropagation()}>
        <div className="slot-popup-header">
          <span className="slot-popup-title">{t('bottleDetail.removeBottleTitle')}</span>
          <button className="slot-popup-close" onClick={onCancel} aria-label="Close">&times;</button>
        </div>
        <form onSubmit={handleSubmit} className="consume-modal-form">
          <div className="form-group">
            <label>{t('common.reason')}</label>
            <select value={reason} onChange={e => setReason(e.target.value)}>
              <option value="drank">{t('bottleDetail.drinkReason')}</option>
              <option value="gifted">{t('bottleDetail.giftedReason')}</option>
              <option value="sold">{t('bottleDetail.soldReason')}</option>
              <option value="other">{t('bottleDetail.otherReason')}</option>
            </select>
          </div>
          {reason === 'drank' && (
            <div className="form-group">
              <label>{t('bottleDetail.ratingOptional')}</label>
              <RatingInput
                value={rating}
                scale={ratingScale}
                onChange={v => setRating(v ?? '')}
                onScaleChange={s => { setRatingScale(s); setRating(''); }}
                allowScaleOverride
              />
            </div>
          )}
          <div className="form-group">
            <label>{t('bottleDetail.noteOptional')}</label>
            <textarea
              value={note}
              onChange={e => setNote(e.target.value)}
              rows={2}
              placeholder={t('racks.consumeNotePlaceholder')}
            />
          </div>
          <div className="consume-modal-actions">
            <button type="button" className="btn btn-secondary" onClick={onCancel}>{t('common.cancel')}</button>
            <button type="submit" className="btn btn-consume" disabled={saving}>
              {saving ? t('common.saving') : t('common.confirm')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---- NFC link modal ----
function NfcLinkModal({ rack, onSave, onCancel }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState('idle'); // idle | writing | success | error
  const [errorMsg, setErrorMsg] = useState('');
  const supportsNfc = typeof window !== 'undefined' && 'NDEFReader' in window;

  const nfcUrl = `${window.location.origin}/nfc/rack/${rack?._id}`;

  const handleWrite = async () => {
    if (!supportsNfc) return;
    setStatus('writing');
    setErrorMsg('');
    try {
      const reader = new window.NDEFReader();
      await reader.write({
        records: [{ recordType: 'url', data: nfcUrl }]
      });
      setStatus('success');
      // Save rfidTag marker on the rack
      onSave(rack._id);
    } catch (err) {
      setStatus('error');
      setErrorMsg(err.message || t('nfc.writeFailed'));
    }
  };

  const handleUnlink = () => {
    onSave('');
  };

  return (
    <div className="slot-modal-overlay" onClick={onCancel} role="dialog" aria-modal="true">
      <div className="slot-modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 400 }}>
        <div className="slot-popup-header">
          <span className="slot-popup-title">{t('nfc.linkTitle')}</span>
          <button className="slot-popup-close" onClick={onCancel} aria-label="Close">&times;</button>
        </div>
        <div style={{ padding: '1rem' }}>
          <p style={{ fontSize: '0.85rem', color: 'var(--color-text-muted)', margin: '0 0 1rem' }}>
            {t('nfc.linkDescription')}
          </p>

          {rack?.rfidTag && (
            <div style={{ padding: '0.5rem 0.75rem', background: 'rgba(var(--color-primary-rgb), 0.08)', borderRadius: 'var(--radius-sm)', marginBottom: '1rem', fontSize: '0.85rem' }}>
              {t('nfc.currentlyLinked')}
            </div>
          )}

          <div style={{ fontSize: '0.8rem', color: 'var(--color-text-muted)', wordBreak: 'break-all', marginBottom: '1rem', padding: '0.5rem', background: 'var(--color-surface-raised)', borderRadius: 'var(--radius-sm)' }}>
            <strong>URL:</strong> {nfcUrl}
          </div>

          {supportsNfc ? (
            <>
              <button
                className="btn btn-primary"
                onClick={handleWrite}
                disabled={status === 'writing'}
                style={{ width: '100%', marginBottom: '0.5rem' }}
              >
                {status === 'writing' ? t('nfc.writing') : t('nfc.writeToTag')}
              </button>
              {status === 'success' && (
                <p style={{ color: 'var(--color-success)', fontSize: '0.85rem', margin: '0.5rem 0 0' }}>
                  {t('nfc.writeSuccess')}
                </p>
              )}
              {status === 'error' && (
                <p style={{ color: 'var(--color-error)', fontSize: '0.85rem', margin: '0.5rem 0 0' }}>
                  {errorMsg}
                </p>
              )}
            </>
          ) : (
            <div style={{ fontSize: '0.85rem', color: 'var(--color-text-muted)' }}>
              <p style={{ margin: '0 0 0.5rem', fontWeight: 600 }}>{t('nfc.notSupported')}</p>
              <p style={{ margin: 0 }}>{t('nfc.manualInstructions')}</p>
            </div>
          )}

          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem', justifyContent: 'flex-end' }}>
            {rack?.rfidTag && (
              <button className="btn btn-danger btn-small" onClick={handleUnlink}>
                {t('nfc.unlink')}
              </button>
            )}
            {!supportsNfc && !rack?.rfidTag && (
              <button className="btn btn-primary btn-small" onClick={() => onSave(rack._id)}>
                {t('nfc.markAsLinked')}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default CellarRacks;
