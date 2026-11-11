import { useState, useEffect, useMemo, useRef, Suspense } from 'react';
import { lazy } from '../utils/lazyWithReload';
import { useParams, useSearchParams, useNavigate, useLocation } from 'react-router-dom';
import { useBackHere } from '../utils/useBackHere';
import { useBackToClose } from '../utils/useBackToClose';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { getCellar } from '../api/cellars';
import { getRacks, deleteRack, updateSlot, clearSlot, moveSlot, createRack, updateRack, disableSlot, enableSlot, previewArrange, applyArrange, moveRackBottles } from '../api/racks';
import { consumeBottle, pourBottle, openBottle } from '../api/bottles';
import PreservationPickerModal from '../components/bottle/PreservationPickerModal';
import { getTotalSlots, getModularTotalSlots } from '../utils/rackLayouts';
import { readPlaceQueue, planAutoPlace, withoutPlaced } from '../utils/placeQueue';
import RackRenderer from '../components/racks/RackRenderer';
import ShelfView from '../components/racks/ShelfView';
// Lazy: ShelfView3D pulls in three.js (~250 kB gzip) — only load it when the
// user actually switches to the 3D view, not on every visit to the racks page.
const ShelfView3D = lazy(() => import('../components/racks/ShelfView3D'));
import { TYPE_DIMENSIONS } from '../components/racks/RackTypeSelector';
import { CABINET_DEFAULT, fitShelfRows } from '../utils/cabinetPresets';
import { cabinetShelfCols, cabinetShelfAlternate, cabinetShelfSideways } from '../utils/rackLayouts';
import { ConsumeModal } from '../components/ConsumeModal';
import BottleUndoNotice, { bottleNoticeName } from '../components/BottleUndoNotice';
import { isReserved, reservationSummary } from '../utils/reservation';
import ConfirmModal from '../components/ConfirmModal';
import JournalPrompt, { journalPromptOptedOut } from '../components/JournalPrompt';
import ArrangeModal from '../components/racks/ArrangeModal';
import ZoneEditorModal from '../components/racks/ZoneEditorModal';
import RackAuditModal from '../components/racks/RackAuditModal';
import { LENSES, getLensStyle, getLensLegend, bottleMatchesSearch } from '../utils/rackLens';
import CellarNav from '../components/CellarNav';
import CellarPageHeader from '../components/CellarPageHeader';
import DialogBox from '../components/DialogBox';
import EditRackModal from '../components/racks/EditRackModal';
import MoveRackBottlesModal from '../components/racks/MoveRackBottlesModal';
import NfcLinkModal from '../components/racks/NfcLinkModal';
import NewRackForm from '../components/racks/NewRackForm';
import { EmptySlotContent, DisabledSlotContent, FilledSlotContent } from '../components/racks/SlotPopupContent';
import BetaBadge from '../components/BetaBadge';
import { useFeature } from '../utils/featureFlags';
import { groupRacks, groupNames } from '../utils/rackGroups';
import { friendlyError, messageForResponse } from '../utils/friendlyError';
import ActionNotice from '../components/ActionNotice';
import './CellarRacks.css';

function CellarRacks() {
  const { t } = useTranslation();
  const { id } = useParams();
  const navigate = useNavigate();
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
  // rack id being renamed / regrouped (EditRackModal), or null
  const [editRack, setEditRack]       = useState(null);
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
  // Why the last rack action failed (translated), shown by ActionNotice — the
  // rack actions used English browser alerts, and some failed silently.
  const [actionError, setActionError] = useState(null);
  // Slot actions in flight, by what they act on: a double tap on the same
  // slot sent two requests, and the second came back as a conflict alert for
  // a move that had in fact worked. Other slots stay usable meanwhile.
  const slotActionsBusy = useRef(new Set());
  // Move mode — "Move" in a filled slot's popup, then a tap on the slot the
  // bottle should go to: { rackId, position, bottle } or null (handleMoveTap).
  const [moving, setMoving] = useState(null);
  const movingOn = !!moving;
  // The phone's Back and Escape leave it, as they close a pop-up. Escape with
  // a pop-up open over the page is that pop-up's.
  useBackToClose(() => setMoving(null), movingOn);
  useEffect(() => {
    if (!movingOn) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape' && !document.querySelector('[role="dialog"]')) setMoving(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [movingOn]);

  // --- post-add placing mode (issue #1055) — HOOKS live up here, before the
  // page's early `if (error) return` (audit 2026-09-14 H: hooks declared after
  // a conditional return crash the page on a load error). The handlers that
  // use them sit further down, next to the render.
  const location = useLocation();
  // Handed to the bottle page so its back link returns here (BottleDetail).
  const backHere = useBackHere('racks');
  const [placeQueue, setPlaceQueue] = useState(() => readPlaceQueue(location.state));
  const [placeTotal] = useState(() => readPlaceQueue(location.state).length);
  // The bottle page hands over ONE existing bottle (not a fresh add): the
  // bar says so instead of "your new bottles".
  const [placeFromBottle] = useState(() => !!(location.state && location.state.placeFrom === 'bottle'));
  const [placeNotice, setPlaceNotice] = useState(null);
  const [placeBusy, setPlaceBusy] = useState(false);
  // Back/reload after the queue drained used to re-enter the mode with the
  // original ids and MOVE already-placed bottles: drop anything the loaded
  // racks already hold (audit 2026-09-14 M).
  useEffect(() => {
    if (!placeQueue.length || !racks.length) return;
    const trimmed = withoutPlaced(placeQueue, racks);
    if (trimmed.length !== placeQueue.length) setPlaceQueue(trimmed);
  }, [racks]); // eslint-disable-line react-hooks/exhaustive-deps

  // consume modal: { bottleId, bottle } or null
  const [consumeModal, setConsumeModal] = useState(null);

  // "just a glass" partial flow: preservation picker for a not-yet-open bottle
  const [partialPicker, setPartialPicker] = useState(null); // { bottleId }
  const [partialBusy, setPartialBusy] = useState(false);

  // "Organize this rack" modal
  const [arrangeOpen, setArrangeOpen] = useState(false);

  // Rack tools (⋮) dropdown in the lens toolbar
  const [toolsOpen, setToolsOpen] = useState(false);

  // Early access: "Move bottles to another rack" (MoveRackBottlesModal). Holds
  // the SOURCE rack's id while open — pinned, because reloading the racks
  // after the move can change which rack the page has selected (a ?highlight
  // follows its bottle into the target).
  const moveRackOn = useFeature('rackMoveBottles');
  // Early access: "Move" in a slot's pop-up, then a tap on the slot it goes to.
  const slotMoveOn = useFeature('rackSlotMove');
  const [moveOpen, setMoveOpen] = useState(null);

  // Zone editor modal
  const [zonesOpen, setZonesOpen] = useState(false);

  // Audit mode modal
  const [auditOpen, setAuditOpen] = useState(false);

  // consumed bottle awaiting the "add to journal?" prompt, or null
  const [journalBottle, setJournalBottle] = useState(null);
  // The bottle just taken out of a slot, said with Undo (components/
  // BottleUndoNotice) — a member could not undo a drink from the racks page.
  // It floats above the journal prompt, as on the cellar list. It remembers
  // the slot, so Undo can put the bottle back there (handleUndone).
  const [drunkNotice, setDrunkNotice] = useState(null);

  // NFC modal: { rackId } or null
  const [nfcModal, setNfcModal] = useState(null);

  // Delete confirmation: rackId or null
  const [deleteConfirm, setDeleteConfirm] = useState(null);

  useEffect(() => {
    // A move begun in another cellar must never reach this one's racks.
    setMoving(null);
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

  // Re-read the racks after a move refused because a rack changed meanwhile,
  // so the next try works on the real layout. Quietly: the notice already
  // says why, and a failed re-read keeps what is shown (never the page error).
  const reloadRacks = async () => {
    try {
      const res = await getRacks(apiFetch, id);
      if (!res.ok) return;
      const data = await res.json();
      setRacks(data.racks || []);
    } catch {
      // keep what is shown
    }
  };

  // --- create rack ---
  // A refused rack action, worded for the person (rate limit with its wait,
  // server down, or the server's own reason) and shown by ActionNotice.
  const failed = (res, body, fallback) => {
    setActionError(messageForResponse(res, body, fallback, t));
  };
  // Runs a slot action unless the same one (same rack + slot) is already in
  // flight — a repeat tap is dropped rather than sent twice.
  const slotAction = async (key, run) => {
    if (slotActionsBusy.current.has(key)) return;
    slotActionsBusy.current.add(key);
    setActionError(null);
    try { await run(); } finally { slotActionsBusy.current.delete(key); }
  };

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
        ...(newRack.group && newRack.group.trim() ? { group: newRack.group.trim() } : {}),
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
        // Cabinet: the per-shelf list must match the final shelf count (the
        // rows input may have changed after the list was edited); other
        // types must not carry cabinet keys (the backend rejects them).
        if (newRack.type === 'cabinet') {
          typeConfig.shelfRows = fitShelfRows(typeConfig.shelfRows, newRack.rows);
          typeConfig.twoDeep = typeConfig.twoDeep !== false;
          typeConfig.stagger = typeConfig.stagger !== false;
          typeConfig.alternate = typeConfig.alternate === true;
          // Head to tail is for a one-deep cabinet only (the backend refuses
          // it with two deep), and stored only when on.
          if (typeConfig.twoDeep === false && typeConfig.headToTail === true) typeConfig.headToTail = true; else delete typeConfig.headToTail;
          // Per-shelf width / pattern: fitted to the final shelf count and
          // width, and stored only where a shelf differs from the cabinet.
          const widths = cabinetShelfCols(newRack.rows, newRack.cols, typeConfig);
          if (widths.some((w) => w !== newRack.cols)) typeConfig.shelfCols = widths; else delete typeConfig.shelfCols;
          const patterns = cabinetShelfAlternate(newRack.rows, typeConfig);
          if (patterns.some((a) => a !== typeConfig.alternate)) typeConfig.shelfAlternate = patterns; else delete typeConfig.shelfAlternate;
          // How each shelf's bottles lie (drawing only): fitted to the final
          // shelf count, and stored only when some shelf lies sideways.
          const lies = cabinetShelfSideways(newRack.rows, typeConfig);
          if (lies.some(Boolean)) typeConfig.shelfSideways = lies; else delete typeConfig.shelfSideways;
        } else {
          for (const k of ['shelfRows', 'twoDeep', 'stagger', 'headToTail', 'alternate', 'shelfCols', 'shelfAlternate', 'shelfSideways']) delete typeConfig[k];
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
        setActionError(null);
      } else {
        failed(res, data, t('racks.errors.create', 'The rack could not be created.'));
      }
    } catch (err) {
      setActionError(friendlyError(err, t));
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
        : type === 'shelf' ? { bottlesPerCell: 1, backCols: 0 }
        : type === 'cabinet' ? { shelfRows: [...CABINET_DEFAULT.shelfRows], twoDeep: CABINET_DEFAULT.twoDeep, stagger: CABINET_DEFAULT.stagger, alternate: CABINET_DEFAULT.alternate } : {},
    }));
  };

  // --- delete rack ---
  const handleDeleteRack = async (rackId) => {
    try {
      const res = await deleteRack(apiFetch, rackId);
      if (res.ok) {
        const remaining = racks.filter(r => r._id !== rackId);
        setRacks(remaining);
        setActionError(null);
        setMoving(m => (m?.rackId === rackId ? null : m));
        if (selectedRackId === rackId) {
          setSelectedRackId(remaining.length > 0 ? remaining[0]._id : null);
        }
      } else {
        const data = await res.json().catch(() => null);
        failed(res, data, t('racks.errors.delete', 'The rack could not be deleted.'));
      }
    } catch (err) {
      setActionError(friendlyError(err, t));
    } finally {
      setDeleteConfirm(null);
    }
  };

  // --- assign bottle to slot ---
  const handleAssign = (rackId, position, bottleId) => slotAction(`${rackId}:${position}`, async () => {
    try {
      const res = await updateSlot(apiFetch, rackId, position, { bottleId });
      const data = await res.json();
      if (res.ok) {
        setRacks(prev => prev.map(r => r._id === rackId ? data.rack : r));
      } else {
        failed(res, data, t('racks.errors.assign', 'The bottle could not be placed.'));
      }
    } catch (err) {
      setActionError(friendlyError(err, t));
    }
    setActivePopup(null);
  });

  // --- case placement: assign several bottles of the same wine to the free
  // positions from startPosition onward. Sequential on purpose — each save
  // bumps the rack version, so parallel PUTs would 409 each other.
  const handleAssignMany = (rackId, startPosition, bottleIds) => slotAction(`${rackId}:${startPosition}`, async () => {
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
          failed(res, data, t('racks.errors.assignMany', 'Not all the bottles could be placed.'));
          break;
        }
        setRacks(prev => prev.map(x => x._id === rackId ? data.rack : x));
      } catch (err) {
        setActionError(friendlyError(err, t));
        break;
      }
    }
    setActivePopup(null);
  });

  // --- remove bottle from slot (keep bottle in cellar) ---
  const handleRemoveFromRack = (rackId, position) => slotAction(`${rackId}:${position}`, async () => {
    try {
      const res = await clearSlot(apiFetch, rackId, position);
      const data = await res.json();
      if (res.ok) {
        setRacks(prev => prev.map(r => r._id === rackId ? data.rack : r));
      } else {
        failed(res, data, t('racks.errors.removeFromRack', 'The bottle could not be taken out of the rack.'));
      }
    } catch (err) {
      setActionError(friendlyError(err, t));
    } finally {
      setActivePopup(null);
    }
  });

  // --- disable / re-enable a slot position ---
  const handleDisableSlot = (rackId, position) => slotAction(`${rackId}:${position}`, async () => {
    try {
      const res = await disableSlot(apiFetch, rackId, position);
      const data = await res.json();
      if (res.ok) {
        setRacks(prev => prev.map(r => r._id === rackId ? data.rack : r));
      } else {
        failed(res, data, t('racks.errors.disableSlot', 'The slot could not be marked unusable.'));
      }
    } catch (err) {
      setActionError(friendlyError(err, t));
    }
    setActivePopup(null);
  });

  const handleEnableSlot = (rackId, position) => slotAction(`${rackId}:${position}`, async () => {
    try {
      const res = await enableSlot(apiFetch, rackId, position);
      const data = await res.json();
      if (res.ok) {
        setRacks(prev => prev.map(r => r._id === rackId ? data.rack : r));
      } else {
        failed(res, data, t('racks.errors.enableSlot', 'The slot could not be made usable again.'));
      }
    } catch (err) {
      setActionError(friendlyError(err, t));
    }
    setActivePopup(null);
  });

  // --- soft-remove bottle via the shared consume endpoint ---
  const handleConsumeSubmit = async (reason, note, rating, consumedRatingScale, consumedAt) => {
    const { bottleId, bottle, slot } = consumeModal;
    try {
      const res = await consumeBottle(apiFetch, bottleId, { reason, note, rating, consumedRatingScale, consumedAt });
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
        setActionError(null);
        setDrunkNotice({ kind: 'consumed', reason, bottleId, slot, name: bottleNoticeName(bottle), at: Date.now() });
        if (reason === 'drank' && !journalPromptOptedOut()) {
          setJournalBottle(bottle);
        }
      } else {
        // The dialog stays open (nothing typed is lost); the notice floats
        // above it.
        failed(res, data, t('racks.errors.consume', 'The bottle could not be taken out.'));
      }
    } catch (err) {
      // Don't rethrow — ConsumeModal awaits this and must reach setSaving(false)
      setActionError(friendlyError(err, t));
    }
  };

  // After an Undo from the drunk notice. The journal prompt for that bottle
  // closes (it was not drunk after all). The bottle goes back into the slot it
  // came from when that slot is still free — the server checks it is still
  // empty (expectOccupant: null), so a bottle placed there meanwhile is never
  // displaced; otherwise it stays unplaced, which the notice's "back in the
  // cellar" covers, and the racks are read again quietly (reloadRacks — a
  // failed re-read keeps what is shown, never the whole-page error).
  const handleUndone = async (notice) => {
    setJournalBottle((prev) => (prev && String(prev._id) === String(notice.bottleId) ? null : prev));
    const { slot } = notice;
    const rack = slot && racks.find((r) => r._id === slot.rackId);
    const free = !!rack && !(rack.disabledPositions || []).includes(slot.position)
      && !rack.slots.some((s) => s.position === slot.position && s.bottle);
    if (free) {
      try {
        const res = await updateSlot(apiFetch, slot.rackId, slot.position, { bottleId: notice.bottleId, expectOccupant: null });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.rack) {
          setRacks((prev) => prev.map((r) => (r._id === slot.rackId ? data.rack : r)));
          return;
        }
      } catch { /* it stays unplaced */ }
    }
    await reloadRacks();
  };

  // --- drag & drop: move a bottle to another slot / swap two bottles ---
  // Also the move mode's, which passes `expect` (what it saw in both slots).
  const handleSlotMove = (rackId, fromPosition, toPosition, expect) => slotAction(`${rackId}:${fromPosition}`, async () => {
    try {
      const res = await moveSlot(apiFetch, rackId, fromPosition, toPosition, expect);
      const data = await res.json();
      if (res.ok) {
        setRacks(prev => prev.map(r => r._id === rackId ? data.rack : r));
      } else {
        failed(res, data, t('racks.errors.move', 'The bottle could not be moved.'));
        // The move mode's 409: the rack is not what the page shows.
        if (expect && res.status === 409) await reloadRacks();
      }
    } catch (err) {
      setActionError(friendlyError(err, t));
    }
  });

  // A drop (mouse/pen) of the bottle the move mode is moving — or onto its
  // slot — has moved it already: the mode ends.
  const handleDrop = (rackId, fromPosition, toPosition) => {
    setMoving(m => (m?.rackId === rackId && (m.position === fromPosition || m.position === toPosition) ? null : m));
    return handleSlotMove(rackId, fromPosition, toPosition);
  };

  // "Just a glass — keep the bottle": escape hatch out of the remove flow.
  // Already-open bottles pour immediately; unopened ones ask for the
  // preservation method first. Both land on the bottle page, where the
  // open-bottle panel shows the result.
  // "Just a glass": pour one from an open bottle, or open it first, then
  // show the bottle. A refusal says why and stays here — nothing changed, so
  // the bottle page would have nothing to show. Opened but the glass refused:
  // the bottle page shows it open, where a glass is one tap.
  const handlePartial = async (bottle) => {
    setConsumeModal(null);
    if (bottle.openedAt) {
      try {
        const res = await pourBottle(apiFetch, bottle._id);
        if (!res.ok) {
          failed(res, await res.json().catch(() => ({})), t('racks.errors.pour', 'The glass could not be recorded.'));
          return;
        }
      } catch (err) {
        setActionError(friendlyError(err, t));
        return;
      }
      navigate(`/cellars/${id}/bottles/${bottle._id}`, { state: backHere });
    } else {
      setPartialPicker({ bottleId: bottle._id });
    }
  };

  const confirmPartial = async (method, takeOutOfRack) => {
    const { bottleId } = partialPicker;
    setPartialBusy(true);
    try {
      const res = await openBottle(apiFetch, bottleId, method, { takeOutOfRack });
      if (!res.ok) {
        failed(res, await res.json().catch(() => ({})), t('racks.errors.open', 'The bottle could not be opened.'));
        return;
      }
      await pourBottle(apiFetch, bottleId).catch(() => {});
    } catch (err) {
      setActionError(friendlyError(err, t));
      return;
    } finally {
      setPartialBusy(false);
      setPartialPicker(null);
    }
    navigate(`/cellars/${id}/bottles/${bottleId}`, { state: backHere });
  };

  // Pour a glass from an open (Coravin'd) bottle right from the slot popup.
  // The pour response bottle is unpopulated — merge only the open-state
  // fields into the racks state so the populated wineDefinition survives.
  const handlePour = async (rackId, bottleId) => {
    try {
      const res = await pourBottle(apiFetch, bottleId);
      const data = await res.json();
      if (!res.ok) {
        failed(res, data, t('racks.errors.pour', 'The glass could not be recorded.'));
        return;
      }
      setActionError(null);
      const patch = {
        openedAt: data.bottle.openedAt,
        preservationMethod: data.bottle.preservationMethod,
        pours: data.bottle.pours,
      };
      setRacks(prev => prev.map(r => {
        if (r._id !== rackId) return r;
        return {
          ...r,
          slots: r.slots.map(s => {
            const bid = s.bottle?._id || s.bottle;
            return bid?.toString() === bottleId ? { ...s, bottle: { ...s.bottle, ...patch } } : s;
          }),
        };
      }));
      // Refresh the open popup so glasses-left updates in place
      setActivePopup(prev => {
        if (!prev?.slot) return prev;
        const bid = prev.slot.bottle?._id || prev.slot.bottle;
        if (bid?.toString() !== bottleId) return prev;
        return { ...prev, slot: { ...prev.slot, bottle: { ...prev.slot.bottle, ...patch } } };
      });
    } catch (err) {
      setActionError(friendlyError(err, t));
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

  // Auto-arrange: the plan is computed AND applied server-side (the same
  // engine the MCP auto_arrange tool uses); the modal shows the returned
  // errors itself. Apply refreshes the rack from the response in one shot.
  const handleArrangePreview = async (rackId, strategy, positionOrder) => {
    try {
      const res = await previewArrange(apiFetch, rackId, { strategy, positionOrder });
      const data = await res.json();
      if (!res.ok) return { ok: false, error: data?.error };
      return { ok: true, data };
    } catch {
      return { ok: false };
    }
  };

  const handleArrangeApply = async (rackId, target, before) => {
    try {
      const res = await applyArrange(apiFetch, rackId, { target, before });
      const data = await res.json();
      if (!res.ok) return { ok: false, error: data?.error };
      setRacks(prev => prev.map(r => r._id === rackId ? data.rack : r));
      return { ok: true };
    } catch {
      return { ok: false };
    }
  };

  // Every bottle of one rack into another, in order (early access
  // 'rackMoveBottles'). Both racks change, so reload them all.
  const handleMoveBottles = async (rackId, toRackId) => {
    try {
      const res = await moveRackBottles(apiFetch, rackId, toRackId);
      const data = await res.json();
      // Reload on a refusal too: a move refused halfway can leave bottles
      // unplaced, and the page must not keep showing them in their old slots.
      await fetchAll();
      if (!res.ok) return { ok: false, error: data?.error };
      return { ok: true, data };
    } catch {
      fetchAll();
      return { ok: false };
    }
  };

  // Rename / regroup: PUT name + group and adopt
  // the returned values. An empty group clears it.
  const handleEditRackSave = async (rackId, { name, group, typeConfig }) => {
    try {
      const res = await updateRack(apiFetch, rackId, { name, group, ...(typeConfig ? { typeConfig } : {}) });
      const data = await res.json();
      if (!res.ok) return { ok: false, error: data.error };
      // Adopt the changed fields only — the rack in state carries populated
      // slot bottles the PUT response does not.
      setRacks(prev => prev.map(r => r._id === rackId ? {
        ...r,
        name: data.rack.name,
        group: data.rack.group ?? null,
        ...(typeConfig ? { typeConfig: data.rack.typeConfig || typeConfig } : {}),
      } : r));
      return { ok: true };
    } catch {
      return { ok: false };
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
        setActionError(null);
      } else {
        // Keep the modal open so the user can retry instead of silently losing the tag
        failed(res, data, t('racks.errors.nfc', 'The NFC tag could not be saved.'));
      }
    } catch (err) {
      setActionError(friendlyError(err, t));
    }
  };

  if (error) return <div className="alert alert-error">{error}</div>;

  const rack = racks.find(r => r._id === selectedRackId) || racks[0];
  const canEdit = cellar?.userRole !== 'viewer';
  // Shelves and wine cabinets drawn in 3D hide the lens toolbar (and the rack
  // header with its pencil lives only in the Compact view).
  const shelf3d = !!rack && (rack.type === 'shelf' || rack.type === 'cabinet') && !rack.isModular && viewMode === '3d';

  // Rack tools (⋮), for editors, in every view and whether or not the rack
  // holds bottles. Rename sits here too: the header pencil is missing in the
  // Shelf and 3D views of shelves and wine cabinets, and a rack you cannot
  // find a way to rename gets deleted and rebuilt (forum feedback 2026-10-12).
  const rackToolsMenu = rack && canEdit ? (
    <div className="rack-tools">
      <button
        type="button"
        className="btn btn-secondary btn-small rack-tools-btn"
        onClick={() => setToolsOpen(o => !o)}
        aria-haspopup="menu"
        aria-expanded={toolsOpen}
        aria-label={t('racks.toolsMenu', 'Rack tools')}
        title={t('racks.toolsMenu', 'Rack tools')}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="12" cy="5" r="1.9" /><circle cx="12" cy="12" r="1.9" /><circle cx="12" cy="19" r="1.9" />
        </svg>
      </button>
      {toolsOpen && (
        <>
          <div className="rack-tools-backdrop" onClick={() => setToolsOpen(false)} aria-hidden="true" />
          <div className="rack-tools-menu" role="menu">
            <button type="button" role="menuitem" onClick={() => { setToolsOpen(false); setEditRack(rack._id); }}>
              {t('racks.renameMenuItem', 'Rename or group…')}
            </button>
            {rack.slots.length >= 2 && (
              <button type="button" role="menuitem" onClick={() => { setToolsOpen(false); setArrangeOpen(true); }}>
                {t('arrange.openBtn', 'Organize…')}
              </button>
            )}
            {moveRackOn && rack.slots.length > 0 && (
              <button type="button" role="menuitem" onClick={() => { setToolsOpen(false); setMoveOpen(rack._id); }}>
                {t('racks.moveBottles.menuItem', 'Move bottles to another rack…')}
              </button>
            )}
            {rack.slots.length > 0 && (
              <button type="button" role="menuitem" onClick={() => { setToolsOpen(false); setAuditOpen(true); }}>
                {t('audit.openBtn', 'Audit')}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  ) : null;

  // --- post-add placing mode (issue #1055): handlers ---
  // The add flow hands over the ids of the bottles it just created as router
  // state (hooks declared with the others above); each tap on a free slot
  // places the next one, "auto-place" fills first-free slots, leaving the mode
  // at any point keeps the rest unplaced — exactly what they were before. A
  // slot taken concurrently keeps the bottle in the queue with a notice; the
  // add itself can never fail on placement.
  const placingActive = placeTotal > 0 && (placeQueue.length > 0 || placeNotice?.kind === 'done');
  const placedCount = placeTotal - placeQueue.length;

  // Drop the handed-over router state so Back/reload cannot re-enter the mode
  // (and re-place bottles that are already in their slots).
  const clearPlaceState = () => navigate(location.pathname + location.search, { replace: true, state: null });

  const finishPlacing = () => {
    setPlaceQueue([]);
    setPlaceNotice(null);
    clearPlaceState();
  };

  // Returns true when the tap was consumed by the placing mode.
  const handlePlaceTap = async (targetRack, pos, slotData) => {
    if (!placeQueue.length || !canEdit) return false;
    if (placeBusy) return true; // a placement is in flight — swallow the tap, do not open the slot picker
    const isDisabled = (targetRack.disabledPositions || []).includes(pos);
    if (slotData || isDisabled) return false; // a filled/disabled slot behaves as usual
    const bottleId = placeQueue[0];
    setPlaceBusy(true);
    try {
      const res = await updateSlot(apiFetch, targetRack._id, pos, { bottleId });
      const data = await res.json();
      if (res.status === 404) {
        // The bottle is gone (deleted or moved since the add) — it must not
        // block the rest of the queue.
        const rest = placeQueue.slice(1);
        setPlaceQueue(rest);
        setPlaceNotice(rest.length === 0 ? { kind: 'done' } : { kind: 'error', text: data.error || t('racks.placeQueue.slotTaken') });
        if (rest.length === 0) clearPlaceState();
        return true;
      }
      if (!res.ok) {
        setPlaceNotice({ kind: 'error', text: data.error || t('racks.placeQueue.slotTaken') });
        return true;
      }
      setRacks(prev => prev.map(r => r._id === targetRack._id ? data.rack : r));
      const rest = placeQueue.slice(1);
      setPlaceQueue(rest);
      setPlaceNotice(rest.length === 0 ? { kind: 'done' } : null);
      if (rest.length === 0) clearPlaceState();
    } catch {
      setPlaceNotice({ kind: 'error', text: t('common.networkError') });
    } finally {
      setPlaceBusy(false);
    }
    return true;
  };

  // Sequential on purpose — each save bumps the rack version, so parallel
  // PUTs would 409 each other (same rule as case placement).
  const handleAutoPlace = async (targetRack) => {
    if (!placeQueue.length || !canEdit || placeBusy) return;
    setPlaceBusy(true);
    let current = targetRack;
    let remaining = [...placeQueue];
    const { pairs, leftover } = planAutoPlace(current, remaining);
    try {
      for (const { position, bottleId } of pairs) {
        const res = await updateSlot(apiFetch, current._id, position, { bottleId });
        const data = await res.json();
        if (!res.ok) { setPlaceNotice({ kind: 'error', text: data.error || t('racks.placeQueue.slotTaken') }); break; }
        current = data.rack;
        setRacks(prev => prev.map(r => r._id === current._id ? current : r));
        remaining = remaining.filter(id => id !== bottleId);
        setPlaceQueue(remaining);
      }
      if (remaining.length === 0) { setPlaceNotice({ kind: 'done' }); clearPlaceState(); }
      else if (leftover.length && remaining.length === leftover.length) {
        setPlaceNotice({ kind: 'leftover', text: t('racks.placeQueue.leftover', { count: remaining.length }) });
      }
    } catch {
      setPlaceNotice({ kind: 'error', text: t('common.networkError') });
    } finally {
      setPlaceBusy(false);
    }
  };

  // --- move mode: the way to move a bottle without dragging (drag & drop is
  // mouse/pen only — hooks/useSlotDrag). Within the bottle's own rack a tap
  // does what a drop does: an empty slot takes it, an occupied one swaps. In
  // another rack (its tab chosen while the mode stays on) an empty slot takes
  // it and the server clears its old slot. The mode ends after one try at a
  // move, done or refused by the server (a 409 re-reads the racks), and on a
  // tap on the bottle's own slot, Cancel, Escape or Back. Only a slot refused
  // here before any request (unusable, or occupied in another rack) keeps it
  // on, for another pick.
  // Returns true when the tap was consumed by the move mode.
  const handleMoveTap = async (targetRack, pos, slotData) => {
    if (!moving || !canEdit) return false;
    const { rackId: fromRackId, position: from, bottle } = moving;
    const done = () => setMoving(m => (m === moving ? null : m));
    if (targetRack._id === fromRackId && pos === from) { done(); return true; }
    if ((targetRack.disabledPositions || []).includes(pos)) {
      setActionError(t('racks.disabledSlotNote'));
      return true;
    }
    const bottleId = String(bottle._id || bottle);
    const occupant = slotData ? String(slotData.bottle?._id || slotData.bottle) : null;
    if (targetRack._id === fromRackId) {
      // The mode can stay open a while: send what the person saw, so a rack
      // changed meanwhile is refused instead of moving or swapping a bottle
      // they did not pick.
      await handleSlotMove(fromRackId, from, pos, { expectFrom: bottleId, expectTo: occupant });
      done();
      return true;
    }
    // Across racks a placement would push the other bottle out, not swap it.
    if (occupant) {
      setActionError(t('racks.moveMode.otherRackFilled', 'In another rack, choose an empty slot — bottles only swap places within one rack.'));
      return true;
    }
    await slotAction(`${fromRackId}:${from}`, async () => {
      try {
        const res = await updateSlot(apiFetch, targetRack._id, pos, { bottleId, expectOccupant: null });
        const data = await res.json();
        if (res.ok) {
          // The server took the bottle out of its old rack too.
          setRacks(prev => prev.map(r => r._id === targetRack._id ? data.rack : {
            ...r,
            slots: r.slots.filter(s => String(s.bottle?._id || s.bottle) !== bottleId),
          }));
        } else {
          failed(res, data, t('racks.errors.move', 'The bottle could not be moved.'));
          if (res.status === 409) await reloadRacks();
        }
      } catch (err) {
        setActionError(friendlyError(err, t));
      }
    });
    done();
    return true;
  };

  return (
    <div className="cellar-racks-page">
      <ActionNotice message={actionError} onDismiss={() => setActionError(null)} />
      {drunkNotice && (
        <BottleUndoNotice
          key={`${drunkNotice.bottleId}:${drunkNotice.at}`}
          floating
          notice={drunkNotice}
          cellarId={id}
          onUndone={() => handleUndone(drunkNotice)}
          onDismiss={() => setDrunkNotice(null)}
        />
      )}
      <CellarPageHeader
        backTo={`/cellars/${id}`}
        backLabel={t('racks.backToCellar')}
        title={cellar?.name}
        loading={loading}
        userColor={cellar?.userColor}
        subtitle={t('racks.title')}
        actions={!loading && canEdit && (
          <button className="btn btn-primary btn-small" onClick={() => setShowNewRack(v => !v)}>
            {showNewRack ? t('common.cancel') : `+ ${t('racks.newRack')}`}
          </button>
        )}
      />

      {/* Room View / Cellar Book live in the shared view switcher on every page */}
      <CellarNav cellarId={id} active="racks" />

      {/* Post-add placing mode (issue #1055): progress + auto-place + leave */}
      {placingActive && !loading && racks.length > 0 && (
        <div className={`alert ${placeNotice?.kind === 'error' ? 'alert-warning' : 'alert-info'} place-queue-bar`} role="status">
          <span>
            {placeQueue.length > 0
              ? (placeFromBottle && placeTotal === 1
                ? t('racks.placeQueue.progressExisting', 'Placing the bottle')
                : t('racks.placeQueue.progress', { placed: placedCount, total: placeTotal }))
              : (placeFromBottle && placeTotal === 1
                ? t('racks.placeQueue.placedExisting', 'The bottle is in its slot.')
                : t('racks.placeQueue.allPlaced', { count: placeTotal }))}
            {placeQueue.length > 0 && <> · {t('racks.placeQueue.tapHint')}</>}
            {placeNotice?.text && <> · {placeNotice.text}</>}
          </span>
          <span className="place-queue-bar__actions">
            {placeQueue.length > 0 && canEdit && (
              <button type="button" className="btn btn-secondary btn-small" onClick={() => handleAutoPlace(rack)} disabled={placeBusy}>
                {t('racks.placeQueue.autoPlace', { count: placeQueue.length })}
              </button>
            )}
            <button type="button" className="btn btn-small" onClick={finishPlacing} disabled={placeBusy}>
              {placeQueue.length > 0 ? t('racks.placeQueue.leaveMode') : t('common.done', 'Done')}
            </button>
          </span>
        </div>
      )}

      {/* Move mode: which bottle, and the way out */}
      {moving && !loading && (
        <div className="alert alert-info place-queue-bar" role="status">
          <span>
            {t('racks.moveMode.hint', 'Tap the slot to move {{name}} to', { name: bottleNoticeName(moving.bottle) || t('common.unknown') })}
            {racks.length > 1 && <> · {t('racks.moveMode.otherRackHint', 'for another rack, open its tab first')}</>}
          </span>
          <span className="place-queue-bar__actions">
            <button type="button" className="btn btn-small" onClick={() => setMoving(null)}>
              {t('common.cancel')}
            </button>
          </span>
          <BetaBadge feature="rackSlotMove" note={t('racks.moveMode.betaNote', 'Moving a bottle by tapping is in early access.')} />
        </div>
      )}

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
            groups={groupNames(racks)}
          />
        </div>
      )}

      {racks.length === 0 ? (
        <div className="empty-state">
          <p>{t('racks.noRacks')}</p>
        </div>
      ) : (
        <>
          {/* Tabs sectioned by the racks' group label ("Basement" holds several
              racks). A cellar without groups renders one plain strip. */}
          {groupRacks(racks).map(section => (
            <div key={section.group ?? '__ungrouped'} className={`rack-tab-group${section.group ? '' : ' rack-tab-group--none'}`}>
              {section.group && <div className="rack-tab-group-label">{section.group}</div>}
              <div className="rack-tabs">
                {section.racks.map(r => (
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
            </div>
          ))}

          {/* Lens + search toolbar (the 3D shelf view doesn't support lenses yet) */}
          {!((rack.type === 'shelf' || rack.type === 'cabinet') && !rack.isModular && viewMode === '3d') && (
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
                {rackToolsMenu}
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
                  {slotMoveOn
                    ? t('rackLens.dragHintMove', 'Tip: drag a bottle to an empty slot to move it, onto another bottle to swap them — or tap the bottle and choose Move.')
                    : t('rackLens.dragHint', 'Tip: drag a bottle to an empty slot to move it, onto another bottle to swap them.')}
                </p>
              )}
            </>
          )}
          {shelf3d && rackToolsMenu && <div className="rack-tools-row">{rackToolsMenu}</div>}
          {(rack.type === 'shelf' || rack.type === 'cabinet') && !rack.isModular && (
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
          {(rack.type === 'shelf' || rack.type === 'cabinet') && !rack.isModular && (viewMode === 'shelf' || viewMode === '3d') ? (
            (() => {
              const handleClick = async (pos, slotData) => {
                // Move mode consumes every tap while it is on.
                if (moving && await handleMoveTap(rack, pos, slotData)) return;
                // Placing mode consumes a tap on a free slot (issue #1055).
                if (placeQueue.length && await handlePlaceTap(rack, pos, slotData)) return;
                const isDisabled = (rack.disabledPositions || []).includes(pos);
                // Viewers can inspect filled or disabled slots, not empty ones
                if (!canEdit && !slotData && !isDisabled) return;
                if (activePopup?.rackId === rack._id && activePopup?.position === pos) {
                  setActivePopup(null);
                } else {
                  setActivePopup({ rackId: rack._id, position: pos, slot: slotData || null });
                }
              };
              const movingPos = moving?.rackId === rack._id ? moving.position : null;
              const commonProps = {
                rack,
                activePosition: activePopup?.rackId === rack._id ? activePopup.position : null,
                highlightPos: highlightPos?.rackId === rack._id ? highlightPos.position : null,
                onSlotClick: handleClick,
                getSlotStyle,
                onSlotMove: canEdit ? (from, to) => handleDrop(rack._id, from, to) : undefined,
              };
              if (viewMode === '3d') {
                // 3D has no selected-slot ring (its "selected" note points at
                // the popup): the bottle being moved glows like a highlight.
                return (
                  <Suspense fallback={<div className="loading">{t('common.loading')}</div>}>
                    <ShelfView3D key={rack._id} {...commonProps} highlightPos={movingPos ?? commonProps.highlightPos} />
                  </Suspense>
                );
              }
              return <ShelfView key={rack._id} {...commonProps} activePosition={movingPos ?? commonProps.activePosition} />;
            })()
          ) : (
            <RackRenderer
              rack={rack}
              canEdit={canEdit}
              activeRackId={(moving || activePopup)?.rackId}
              activePosition={(moving || activePopup)?.position}
              highlightPos={highlightPos?.rackId === rack._id ? highlightPos.position : null}
              getSlotStyle={getSlotStyle}
              onSlotMove={canEdit ? (from, to) => handleDrop(rack._id, from, to) : undefined}
              onSlotClick={async (pos, slotData) => {
                // Move mode consumes every tap while it is on.
                if (moving && await handleMoveTap(rack, pos, slotData)) return;
                // Placing mode consumes a tap on a free slot (issue #1055).
                if (placeQueue.length && await handlePlaceTap(rack, pos, slotData)) return;
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
              onEdit={() => setEditRack(rack._id)}
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
          <div className="slot-modal-overlay" onClick={() => setActivePopup(null)}>
            <DialogBox
              className="slot-modal"
              onClick={e => e.stopPropagation()}
              onClose={() => setActivePopup(null)}
              labelledBy="slot-popup-heading"
            >
              {activePopup.slot ? (
                <FilledSlotContent
                  position={activePopup.position}
                  slot={activePopup.slot}
                  zone={popupZone}
                  canEdit={canEdit}
                  onPour={() => handlePour(activePopup.rackId, (activePopup.slot.bottle?._id || activePopup.slot.bottle).toString())}
                  onRemoveFromRack={() => handleRemoveFromRack(activePopup.rackId, activePopup.position)}
                  onMove={slotMoveOn ? () => {
                    setMoving({ rackId: activePopup.rackId, position: activePopup.position, bottle: activePopup.slot.bottle });
                    setActivePopup(null);
                    setActionError(null);
                  } : undefined}
                  onConsume={() => {
                    setConsumeModal({
                      bottleId: activePopup.slot.bottle._id,
                      bottle: activePopup.slot.bottle,
                      slot: { rackId: activePopup.rackId, position: activePopup.position },
                    });
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
            </DialogBox>
          </div>
        );
      })()}

      {/* The one "take out of the cellar" dialog the bottle page uses too,
          with "Just a glass" on top — the bottle page's separate "Open
          bottle…" button is not at hand from a slot. */}
      {consumeModal && (
        <ConsumeModal
          wineName={bottleNoticeName(consumeModal.bottle)}
          defaultRatingScale={user?.preferences?.ratingScale || '5'}
          reservationText={isReserved(consumeModal.bottle) ? reservationSummary(consumeModal.bottle, t) : undefined}
          onConfirm={handleConsumeSubmit}
          onCancel={() => setConsumeModal(null)}
          onJustAGlass={() => handlePartial(consumeModal.bottle)}
        />
      )}

      {/* Preservation picker for the "just a glass" partial flow */}
      {partialPicker && (
        <PreservationPickerModal
          busy={partialBusy}
          onConfirm={confirmPartial}
          onClose={() => setPartialPicker(null)}
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
          onPreview={(strategy, positionOrder) => handleArrangePreview(rack._id, strategy, positionOrder)}
          onApply={(target, before) => handleArrangeApply(rack._id, target, before)}
          onClose={() => setArrangeOpen(false)}
        />
      )}

      {/* Early access: move every bottle to another rack */}
      {moveOpen && (() => {
        const source = racks.find(r => r._id === moveOpen);
        return source ? (
          <MoveRackBottlesModal
            rack={source}
            racks={racks}
            onMove={(toRackId) => handleMoveBottles(source._id, toRackId)}
            onShowRack={(rackId) => { setMoveOpen(null); setSelectedRackId(rackId); }}
            onClose={() => setMoveOpen(null)}
          />
        ) : null;
      })()}

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

      {/* Rename / regroup */}
      {editRack && (() => {
        const target = racks.find(r => r._id === editRack);
        return target ? (
          <EditRackModal
            rack={target}
            groups={groupNames(racks)}
            onSave={(fields) => handleEditRackSave(target._id, fields)}
            onClose={() => setEditRack(null)}
          />
        ) : null;
      })()}

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

export default CellarRacks;
