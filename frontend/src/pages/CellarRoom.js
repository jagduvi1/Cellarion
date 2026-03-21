import { useState, useEffect, useCallback, useMemo, useRef, Suspense } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Canvas } from '@react-three/fiber';
import { useAuth } from '../contexts/AuthContext';
import { getCellar } from '../api/cellars';
import { getRacks, updateSlot, clearSlot } from '../api/racks';
import { consumeBottle } from '../api/bottles';
import { getCellarLayout, saveCellarLayout } from '../api/cellarLayout';
import { getPlacedBottleIds } from '../utils/rackUtils';
import RoomScene from '../components/room/RoomScene';
import { getRackHeight } from '../utils/roomConstants';
import './CellarRoom.css';

const DEFAULT_DIMENSIONS = { width: 10, depth: 10, height: 3 };

export default function CellarRoom() {
  const { t } = useTranslation();
  const { id } = useParams();
  const { apiFetch } = useAuth();

  const [cellar, setCellar] = useState(null);
  const [racks, setRacks] = useState([]);
  const [layout, setLayout] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [isEditMode, setIsEditMode] = useState(false);
  const [selectedRackIds, setSelectedRackIds] = useState([]);
  const [showSettings, setShowSettings] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [interactionMode, setInteractionMode] = useState(null); // 'stack' | 'link' | null
  const [showAddRackPicker, setShowAddRackPicker] = useState(false);

  // Bottle interaction state
  const [selectedBottle, setSelectedBottle] = useState(null); // { rackId, slot }
  const [emptySlotTarget, setEmptySlotTarget] = useState(null); // { rackId, position }
  const [slotSearch, setSlotSearch] = useState('');
  const [slotResults, setSlotResults] = useState([]);
  const [slotLoading, setSlotLoading] = useState(false);
  const slotTimerRef = useRef(null);
  const [consumeModal, setConsumeModal] = useState(null); // { bottleId }

  // Derived: first selected rack for single-rack operations (backward compat)
  const selectedRackId = selectedRackIds[0] || null;

  useEffect(() => {
    fetchData();
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const fetchData = async () => {
    try {
      const [cellarRes, racksRes, layoutRes] = await Promise.all([
        getCellar(apiFetch, id),
        getRacks(apiFetch, id),
        getCellarLayout(apiFetch, id),
      ]);

      const cellarData = await cellarRes.json();
      const racksData = await racksRes.json();
      const layoutData = await layoutRes.json();

      if (!cellarRes.ok) { setError(cellarData.error); return; }
      setCellar(cellarData.cellar);
      setRacks(racksData.racks || []);

      if (layoutData.layout) {
        // Filter out placements for racks that no longer exist (e.g. deleted)
        const validRackIds = new Set((racksData.racks || []).map(r => r._id));
        const filtered = {
          ...layoutData.layout,
          rackPlacements: (layoutData.layout.rackPlacements || []).filter(
            rp => validRackIds.has(rp.rack?._id || rp.rack)
          ),
        };
        setLayout(filtered);
      } else {
        // Auto-populate: place all racks in a line
        const autoPlace = (racksData.racks || []).map((r, i) => ({
          rack: r._id,
          position: { x: -3 + i * 1.5, y: 0, z: -3 },
          rotation: 0,
          wall: 'north',
        }));
        setLayout({
          cellar: id,
          roomDimensions: DEFAULT_DIMENSIONS,
          rackPlacements: autoPlace,
        });
      }
    } catch (err) {
      console.error('Room data load error:', err);
      setError('Failed to load room data');
    } finally {
      setLoading(false);
    }
  };

  const handleSave = useCallback(async () => {
    if (!layout) return;
    setSaving(true);
    setSaveError(null);
    try {
      // Sanitize placements: ensure rack is a plain ID string, strip unknown fields
      const cleanPlacements = layout.rackPlacements.map(rp => {
        const clean = {
          rack: rp.rack?._id || rp.rack,
          position: {
            x: Number(rp.position?.x) || 0,
            y: Number(rp.position?.y) || 0,
            z: Number(rp.position?.z) || 0,
          },
          rotation: rp.rotation || 0,
          wall: rp.wall || 'none',
        };
        if (rp.group) clean.group = rp.group;
        if (rp.widthOverride) clean.widthOverride = Number(rp.widthOverride);
        if (rp.depthOverride) clean.depthOverride = Number(rp.depthOverride);
        if (rp.scaleOverride) clean.scaleOverride = Number(rp.scaleOverride);
        return clean;
      });

      const cleanDims = {
        width: Number(layout.roomDimensions?.width) || 10,
        depth: Number(layout.roomDimensions?.depth) || 10,
        height: Number(layout.roomDimensions?.height) || 3,
      };

      const res = await saveCellarLayout(apiFetch, {
        cellar: id,
        roomDimensions: cleanDims,
        rackPlacements: cleanPlacements,
      });
      if (res.ok) {
        const data = await res.json();
        setLayout(data.layout);
      } else {
        const errData = await res.json().catch(() => ({}));
        setSaveError(errData.error || `Save failed (${res.status})`);
        console.error('Save layout failed:', errData.error || res.status);
      }
    } catch (err) {
      setSaveError(err.message);
      console.error('Save layout error:', err);
    } finally {
      setSaving(false);
    }
  }, [layout, id, apiFetch]);

  const handleRackDragEnd = useCallback((rackId, newPosition) => {
    setLayout(prev => {
      const draggedPlacement = prev.rackPlacements.find(
        rp => (rp.rack === rackId || rp.rack?._id === rackId)
      );
      if (!draggedPlacement) return prev;

      const group = draggedPlacement.group;
      const oldX = draggedPlacement.position?.x || 0;
      const oldZ = draggedPlacement.position?.z || 0;
      const dx = newPosition.x - oldX;
      const dz = newPosition.z - oldZ;

      return {
        ...prev,
        rackPlacements: prev.rackPlacements.map(rp => {
          const rpId = rp.rack?._id || rp.rack;
          if (rpId === rackId) {
            return { ...rp, position: newPosition };
          }
          const isGroupMember = group && rp.group === group;
          const isAlsoSelected = selectedRackIds.includes(rpId);
          if (isGroupMember || isAlsoSelected) {
            return {
              ...rp,
              position: {
                x: (rp.position?.x || 0) + dx,
                y: rp.position?.y || 0,
                z: (rp.position?.z || 0) + dz,
              },
            };
          }
          return rp;
        }),
      };
    });
  }, [selectedRackIds]);

  const handleDimensionChange = useCallback((field, value) => {
    setLayout(prev => ({
      ...prev,
      roomDimensions: { ...prev.roomDimensions, [field]: Math.max(2, Math.min(50, Number(value) || 2)) },
    }));
  }, []);

  // Rotate selected rack(s) by 90 degrees
  // Single select: group members orbit around the pivot rack
  // Multi-select: each selected rack rotates in place
  const handleRotateRack = useCallback(() => {
    if (selectedRackIds.length === 0) return;
    setLayout(prev => {
      if (selectedRackIds.length === 1) {
        // Single selection: existing behavior with group orbital rotation
        const sid = selectedRackIds[0];
        const selectedPlacement = prev.rackPlacements.find(
          rp => (rp.rack?._id || rp.rack) === sid
        );
        if (!selectedPlacement) return prev;
        const group = selectedPlacement.group;
        const pivotX = selectedPlacement.position?.x || 0;
        const pivotZ = selectedPlacement.position?.z || 0;

        return {
          ...prev,
          rackPlacements: prev.rackPlacements.map(rp => {
            const rpId = rp.rack?._id || rp.rack;
            if (rpId === sid) {
              return { ...rp, rotation: ((rp.rotation || 0) + 90) % 360 };
            }
            if (group && rp.group === group) {
              const dx = (rp.position?.x || 0) - pivotX;
              const dz = (rp.position?.z || 0) - pivotZ;
              return {
                ...rp,
                rotation: ((rp.rotation || 0) + 90) % 360,
                position: { x: pivotX - dz, y: rp.position?.y || 0, z: pivotZ + dx },
              };
            }
            return rp;
          }),
        };
      }

      // Multi-selection: rotate each selected rack in place
      const ids = new Set(selectedRackIds);
      return {
        ...prev,
        rackPlacements: prev.rackPlacements.map(rp => {
          const rpId = rp.rack?._id || rp.rack;
          if (ids.has(rpId)) {
            return { ...rp, rotation: ((rp.rotation || 0) + 90) % 360 };
          }
          return rp;
        }),
      };
    });
  }, [selectedRackIds]);

  // Add a single rack to the room (placed at center)
  const handleAddRack = useCallback((rackId) => {
    setLayout(prev => {
      const alreadyPlaced = prev.rackPlacements.some(
        rp => (rp.rack?._id || rp.rack) === rackId
      );
      if (alreadyPlaced) return prev;
      return {
        ...prev,
        rackPlacements: [
          ...prev.rackPlacements,
          { rack: rackId, position: { x: 0, y: 0, z: 0 }, rotation: 0, wall: 'none' },
        ],
      };
    });
  }, []);

  // Compute unplaced racks
  const unplacedRacks = useMemo(() => {
    const placedIds = new Set(
      (layout?.rackPlacements || []).map(rp => rp.rack?._id || rp.rack)
    );
    return racks.filter(r => !placedIds.has(r._id));
  }, [racks, layout?.rackPlacements]);

  // Stack: place the selected rack on top of the target rack (click-to-stack)
  // If the selected rack is in a group, move all group members together.
  const handleStackOnTarget = useCallback((targetRackId) => {
    if (!selectedRackId || !layout || targetRackId === selectedRackId) return;

    const targetPlacement = layout.rackPlacements.find(
      rp => (rp.rack === targetRackId || rp.rack?._id === targetRackId)
    );
    if (!targetPlacement) return;

    const targetRackObj = racks.find(r => r._id === targetRackId);
    if (!targetRackObj) return;

    const selectedPlacement = layout.rackPlacements.find(
      rp => (rp.rack === selectedRackId || rp.rack?._id === selectedRackId)
    );
    if (!selectedPlacement) return;

    const targetY = (targetPlacement.position?.y || 0) + getRackHeight(targetRackObj);
    const targetX = targetPlacement.position?.x || 0;
    const targetZ = targetPlacement.position?.z || 0;

    // Compute offset from selected rack's current position
    const dx = targetX - (selectedPlacement.position?.x || 0);
    const dz = targetZ - (selectedPlacement.position?.z || 0);
    const dy = targetY - (selectedPlacement.position?.y || 0);

    const group = selectedPlacement.group;

    setLayout(prev => ({
      ...prev,
      rackPlacements: prev.rackPlacements.map(rp => {
        const rpId = rp.rack?._id || rp.rack;
        if (rpId === selectedRackId) {
          return {
            ...rp,
            position: { x: targetX, y: targetY, z: targetZ },
            rotation: targetPlacement.rotation || 0,
          };
        }
        // Move group members by the same offset
        if (group && rp.group === group) {
          return {
            ...rp,
            position: {
              x: (rp.position?.x || 0) + dx,
              y: (rp.position?.y || 0) + dy,
              z: (rp.position?.z || 0) + dz,
            },
          };
        }
        return rp;
      }),
    }));

    setInteractionMode(null);
    setSelectedRackIds([selectedRackId]);
  }, [selectedRackId, layout, racks]);

  // Unstack the selected rack (move it back to floor level)
  const handleUnstackRack = useCallback(() => {
    if (!selectedRackId) return;
    setLayout(prev => ({
      ...prev,
      rackPlacements: prev.rackPlacements.map(rp => {
        const rpId = rp.rack?._id || rp.rack;
        if (rpId === selectedRackId) {
          return { ...rp, position: { ...rp.position, y: 0 } };
        }
        return rp;
      }),
    }));
  }, [selectedRackId]);

  // Link: click-to-link — link the selected rack to a target rack
  const handleLinkToTarget = useCallback((targetRackId) => {
    if (!selectedRackId || targetRackId === selectedRackId) return;
    setLayout(prev => {
      const selectedPlacement = prev.rackPlacements.find(
        rp => (rp.rack === selectedRackId || rp.rack?._id === selectedRackId)
      );
      const targetPlacement = prev.rackPlacements.find(
        rp => (rp.rack === targetRackId || rp.rack?._id === targetRackId)
      );
      if (!selectedPlacement || !targetPlacement) return prev;

      const groupId = selectedPlacement.group || targetPlacement.group || `g${Date.now().toString(36)}`;
      const oldGroupA = selectedPlacement.group;
      const oldGroupB = targetPlacement.group;

      return {
        ...prev,
        rackPlacements: prev.rackPlacements.map(rp => {
          const rpId = rp.rack?._id || rp.rack;
          if (rpId === selectedRackId || rpId === targetRackId) {
            return { ...rp, group: groupId };
          }
          if (oldGroupA && rp.group === oldGroupA) return { ...rp, group: groupId };
          if (oldGroupB && rp.group === oldGroupB) return { ...rp, group: groupId };
          return rp;
        }),
      };
    });
    setInteractionMode(null);
  }, [selectedRackId]);

  // Unlink a rack from its group
  const handleUnlinkRack = useCallback(() => {
    setLayout(prev => ({
      ...prev,
      rackPlacements: prev.rackPlacements.map(rp => {
        const rpId = rp.rack?._id || rp.rack;
        if (rpId === selectedRackId) {
          return { ...rp, group: null };
        }
        return rp;
      }),
    }));
  }, [selectedRackId]);

  // Remove rack from the room layout (does not delete the rack itself)
  const handleRemoveFromRoom = useCallback(() => {
    if (selectedRackIds.length === 0) return;
    const removeSet = new Set(selectedRackIds);
    setLayout(prev => ({
      ...prev,
      rackPlacements: prev.rackPlacements.filter(
        rp => !removeSet.has(rp.rack?._id || rp.rack)
      ),
    }));
    setSelectedRackIds([]);
    setInteractionMode(null);
  }, [selectedRackIds]);

  // Update a placement field for the selected rack (e.g. widthOverride, depthOverride)
  const handlePlacementField = useCallback((field, value) => {
    if (!selectedRackId) return;
    setLayout(prev => ({
      ...prev,
      rackPlacements: prev.rackPlacements.map(rp => {
        const rpId = rp.rack?._id || rp.rack;
        if (rpId === selectedRackId) {
          const updated = { ...rp };
          if (value === null || value === undefined || value === '') {
            delete updated[field];
          } else {
            updated[field] = Number(value);
          }
          return updated;
        }
        return rp;
      }),
    }));
  }, [selectedRackId]);

  // Arrow key movement for selected rack(s) in edit mode
  useEffect(() => {
    if (!isEditMode || selectedRackIds.length === 0) return;
    const STEP = 0.05;
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        setInteractionMode(null);
        return;
      }
      let dx = 0, dz = 0;
      switch (e.key) {
        case 'ArrowLeft':  dx = -STEP; break;
        case 'ArrowRight': dx = STEP; break;
        case 'ArrowUp':    dz = -STEP; break;
        case 'ArrowDown':  dz = STEP; break;
        default: return;
      }
      e.preventDefault();
      setLayout(prev => {
        // Collect all IDs to move: selected + their group members
        const moveIds = new Set(selectedRackIds);
        selectedRackIds.forEach(id => {
          const rp = prev.rackPlacements.find(p => (p.rack?._id || p.rack) === id);
          if (rp?.group) {
            prev.rackPlacements.forEach(p => {
              if (p.group === rp.group) moveIds.add(p.rack?._id || p.rack);
            });
          }
        });
        return {
          ...prev,
          rackPlacements: prev.rackPlacements.map(rp => {
            const rpId = rp.rack?._id || rp.rack;
            if (moveIds.has(rpId)) {
              return {
                ...rp,
                position: {
                  x: Math.round(((rp.position?.x || 0) + dx) * 20) / 20,
                  y: rp.position?.y || 0,
                  z: Math.round(((rp.position?.z || 0) + dz) * 20) / 20,
                },
              };
            }
            return rp;
          }),
        };
      });
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isEditMode, selectedRackIds]);

  // Link all selected racks into one group
  const handleLinkSelected = useCallback(() => {
    if (selectedRackIds.length < 2) return;
    setLayout(prev => {
      const existingGroups = new Set();
      selectedRackIds.forEach(id => {
        const rp = prev.rackPlacements.find(p => (p.rack?._id || p.rack) === id);
        if (rp?.group) existingGroups.add(rp.group);
      });
      const groupId = existingGroups.size > 0
        ? [...existingGroups][0]
        : `g${Date.now().toString(36)}`;
      const selectedSet = new Set(selectedRackIds);
      return {
        ...prev,
        rackPlacements: prev.rackPlacements.map(rp => {
          const rpId = rp.rack?._id || rp.rack;
          if (selectedSet.has(rpId) || (rp.group && existingGroups.has(rp.group))) {
            return { ...rp, group: groupId };
          }
          return rp;
        }),
      };
    });
  }, [selectedRackIds]);

  // Compute group color map for visual indicators
  const groupColorMap = useMemo(() => {
    const map = {};
    const palette = ['#E74C3C', '#3498DB', '#2ECC71', '#F39C12', '#9B59B6', '#1ABC9C'];
    const groups = [...new Set(
      (layout?.rackPlacements || []).map(rp => rp.group).filter(Boolean)
    )];
    groups.forEach((g, i) => { map[g] = palette[i % palette.length]; });
    return map;
  }, [layout?.rackPlacements]);

  const selectedRack = racks.find(r => r._id === selectedRackId);
  const canEdit = cellar?.userRole !== 'viewer';
  const dims = layout?.roomDimensions || DEFAULT_DIMENSIONS;
  const placements = layout?.rackPlacements || [];

  const placedBottleIds = useMemo(() => getPlacedBottleIds(racks), [racks]);

  // Bottle click — show detail panel
  const handleBottleClick = useCallback((rackId, slot) => {
    setEmptySlotTarget(null);
    setSelectedBottle({ rackId, slot });
  }, []);

  // Empty slot click — show bottle picker
  const handleEmptySlotClick = useCallback((rackId, position) => {
    if (!canEdit) return;
    setSelectedBottle(null);
    setEmptySlotTarget({ rackId, position });
    setSlotSearch('');
  }, [canEdit]);

  // Assign bottle to slot
  const handleAssignBottle = useCallback(async (bottleId) => {
    if (!emptySlotTarget) return;
    const { rackId, position } = emptySlotTarget;
    const res = await updateSlot(apiFetch, rackId, position, { bottleId });
    const data = await res.json();
    if (res.ok) {
      setRacks(prev => prev.map(r => r._id === rackId ? data.rack : r));
      setEmptySlotTarget(null);
    }
  }, [emptySlotTarget, apiFetch]);

  // Remove bottle from rack slot
  const handleRemoveFromRack = useCallback(async () => {
    if (!selectedBottle) return;
    const { rackId, slot } = selectedBottle;
    const res = await clearSlot(apiFetch, rackId, slot.position);
    const data = await res.json();
    if (res.ok) {
      setRacks(prev => prev.map(r => r._id === rackId ? data.rack : r));
      setSelectedBottle(null);
    }
  }, [selectedBottle, apiFetch]);

  // Consume bottle
  const handleConsumeSubmit = useCallback(async (reason, note, rating, ratingScale) => {
    if (!consumeModal) return;
    const res = await consumeBottle(apiFetch, consumeModal.bottleId, {
      reason, note, rating, consumedRatingScale: ratingScale,
    });
    const data = await res.json();
    if (res.ok) {
      setRacks(prev => prev.map(r => ({
        ...r,
        slots: r.slots.filter(s => {
          const bid = s.bottle?._id || s.bottle;
          return bid?.toString() !== consumeModal.bottleId;
        }),
      })));
      setConsumeModal(null);
      setSelectedBottle(null);
    }
  }, [consumeModal, apiFetch]);

  // Backend search for slot picker
  const fetchSlotBottles = useCallback(async (term) => {
    setSlotLoading(true);
    try {
      const params = new URLSearchParams({ limit: '30' });
      if (term) params.set('search', term);
      const res = await getCellar(apiFetch, id, params.toString());
      const data = await res.json();
      if (res.ok) {
        setSlotResults((data.bottles?.items || []).filter(b => !placedBottleIds.has(b._id)));
      }
    } catch { /* ignore */ }
    setSlotLoading(false);
  }, [apiFetch, id, placedBottleIds]);

  // Fetch initial results when slot picker opens
  useEffect(() => {
    if (emptySlotTarget) fetchSlotBottles('');
  }, [emptySlotTarget, fetchSlotBottles]);

  // Debounced slot search
  const handleSlotSearch = useCallback((value) => {
    setSlotSearch(value);
    clearTimeout(slotTimerRef.current);
    slotTimerRef.current = setTimeout(() => fetchSlotBottles(value), 300);
  }, [fetchSlotBottles]);

  // Cleanup timer
  useEffect(() => () => clearTimeout(slotTimerRef.current), []);

  if (error) return <div className="alert alert-error">{error}</div>;

  return (
    <div className="cellar-room-page">
      <div className="cellar-room-header">
        <div className="cellar-room-header-left">
          <Link to={`/cellars/${id}/racks`} className="back-link">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"/></svg>
            {t('room.backToRacks', 'Racks')}
          </Link>
          <h1>{cellar?.name || '...'} — {t('room.title', 'Room View')}</h1>
          <span className="room-beta-badge">Beta</span>
          {isEditMode && <span className="room-mode-badge edit">{t('room.editMode', 'Edit')}</span>}
          {!isEditMode && <span className="room-mode-badge view">{t('room.viewMode', 'View')}</span>}
        </div>

        {canEdit && (
          <div className="cellar-room-header-actions">
            <button
              className="btn btn-secondary btn-small"
              onClick={() => setShowSettings(s => !s)}
            >
              {t('room.roomSettings', 'Settings')}
            </button>
            <button
              className={`btn btn-small ${isEditMode ? 'btn-secondary' : 'btn-primary'}`}
              onClick={() => setIsEditMode(m => !m)}
            >
              {isEditMode ? t('room.viewMode', 'View') : t('room.editMode', 'Edit')}
            </button>
            {isEditMode && (
              <>
                <button
                  className={`btn btn-small ${showAddRackPicker ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => setShowAddRackPicker(p => !p)}
                  disabled={unplacedRacks.length === 0}
                >
                  {t('room.addRack', 'Add Rack')} {unplacedRacks.length > 0 && `(${unplacedRacks.length})`}
                </button>
                {saveError && <span style={{ color: 'var(--color-danger)', fontSize: '0.75rem' }}>{saveError}</span>}
                <button className="btn btn-primary btn-small" onClick={handleSave} disabled={saving}>
                  {saving ? t('common.saving', 'Saving...') : t('room.saveLayout', 'Save')}
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {loading ? (
        <div className="room-loading">{t('common.loading', 'Loading...')}</div>
      ) : (
        <div className="cellar-room-canvas">
          {placements.length === 0 && (
            <div className="room-empty-hint">
              {t('room.noLayout', 'No racks placed yet. Switch to Edit mode to arrange your cellar.')}
            </div>
          )}

          <Canvas
            shadows
            camera={{
              position: [dims.width * 0.6, dims.height * 1.5, dims.depth * 0.8],
              fov: 50,
              near: 0.1,
              far: 100,
            }}
            style={{ height: '100%' }}
          >
            <Suspense fallback={null}>
              <RoomScene
                roomDimensions={dims}
                rackPlacements={placements}
                racks={racks}
                isEditMode={isEditMode}
                selectedRackIds={selectedRackIds}
                groupColorMap={groupColorMap}
                onRackClick={(rackId, shiftKey) => {
                  // Handle click-to-stack / click-to-link modes
                  if (interactionMode === 'stack' && selectedRackId && rackId !== selectedRackId) {
                    handleStackOnTarget(rackId);
                    return;
                  }
                  if (interactionMode === 'link' && selectedRackId && rackId !== selectedRackId) {
                    handleLinkToTarget(rackId);
                    return;
                  }

                  setInteractionMode(null);
                  setSelectedBottle(null);
                  setEmptySlotTarget(null);
                  if (shiftKey) {
                    setSelectedRackIds(prev =>
                      prev.includes(rackId) ? prev.filter(id => id !== rackId) : [...prev, rackId]
                    );
                  } else {
                    setSelectedRackIds([rackId]);
                  }
                }}
                onRackDragEnd={handleRackDragEnd}
                onBottleClick={handleBottleClick}
                onEmptySlotClick={handleEmptySlotClick}
              />
            </Suspense>
          </Canvas>

          {/* Room settings panel */}
          {showSettings && canEdit && (
            <div className="room-settings-panel">
              <h3>{t('room.roomDimensions', 'Room Dimensions')}</h3>
              <div className="form-group">
                <label>{t('room.width', 'Width (m)')}</label>
                <input
                  type="number" min={2} max={50} step={0.5}
                  value={dims.width}
                  onChange={(e) => handleDimensionChange('width', e.target.value)}
                />
              </div>
              <div className="form-group">
                <label>{t('room.depth', 'Depth (m)')}</label>
                <input
                  type="number" min={2} max={50} step={0.5}
                  value={dims.depth}
                  onChange={(e) => handleDimensionChange('depth', e.target.value)}
                />
              </div>
              <div className="form-group">
                <label>{t('room.height', 'Height (m)')}</label>
                <input
                  type="number" min={2} max={10} step={0.5}
                  value={dims.height}
                  onChange={(e) => handleDimensionChange('height', e.target.value)}
                />
              </div>
            </div>
          )}

          {/* Add rack picker */}
          {showAddRackPicker && isEditMode && (
            <div className="room-add-rack-panel">
              <h3>{t('room.addRack', 'Add Rack')}</h3>
              {unplacedRacks.length === 0 ? (
                <p className="room-add-rack-empty">{t('room.allRacksPlaced', 'All racks are placed.')}</p>
              ) : (
                <div className="room-add-rack-list">
                  {unplacedRacks.map(r => (
                    <button
                      key={r._id}
                      className="room-add-rack-item"
                      onClick={() => {
                        handleAddRack(r._id);
                        setSelectedRackIds([r._id]);
                      }}
                    >
                      <span className="room-add-rack-name">{r.name}</span>
                      <span className="room-add-rack-info">
                        {r.isModular ? 'modular' : r.type || 'grid'}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Bottle detail panel (left side) */}
          {selectedBottle && (() => {
            const bottle = selectedBottle.slot?.bottle;
            const wine = bottle?.wineDefinition;
            const rackObj = racks.find(r => r._id === selectedBottle.rackId);
            return (
              <div className="room-bottle-panel">
                <div className="room-bottle-panel-header">
                  <h3>{wine?.name || t('common.unknown', 'Unknown')}</h3>
                  <button className="room-bottle-panel-close" onClick={() => setSelectedBottle(null)} aria-label="Close">&times;</button>
                </div>
                {wine?.image && (
                  <img
                    src={wine.image}
                    alt={wine.name}
                    className="room-bottle-panel-img"
                    onError={e => { e.target.style.display = 'none'; }}
                  />
                )}
                <div className="room-bottle-panel-info">
                  {wine?.producer && <p className="room-bottle-producer">{wine.producer}</p>}
                  <div className="room-bottle-meta">
                    {wine?.type && <span className={`room-bottle-type type-${wine.type}`}>{wine.type}</span>}
                    {bottle?.vintage && <span>{bottle.vintage}</span>}
                  </div>
                  {wine?.country?.name && (
                    <p className="room-bottle-region">
                      {wine.country.name}{wine?.region?.name ? `, ${wine.region.name}` : ''}
                    </p>
                  )}
                  {wine?.appellation && <p className="room-bottle-region">{wine.appellation}</p>}
                  {bottle?.notes && <p className="room-bottle-notes">{bottle.notes}</p>}
                  {rackObj && (
                    <p className="room-bottle-rack">
                      {t('room.inRack', 'In rack')}: {rackObj.name} ({t('room.slot', 'slot')} {selectedBottle.slot.position})
                    </p>
                  )}
                </div>
                {canEdit && (
                  <div className="room-bottle-panel-actions">
                    <button className="btn btn-secondary btn-small" onClick={handleRemoveFromRack}>
                      {t('racks.removeFromRack', 'Remove from Rack')}
                    </button>
                    <button
                      className="btn btn-consume btn-small"
                      onClick={() => {
                        setConsumeModal({ bottleId: bottle._id });
                      }}
                    >
                      {t('racks.remove', 'Remove')}
                    </button>
                  </div>
                )}
              </div>
            );
          })()}

          {/* Empty slot picker (left side) */}
          {emptySlotTarget && canEdit && (() => {
            const rackObj = racks.find(r => r._id === emptySlotTarget.rackId);
            return (
              <div className="room-bottle-panel">
                <div className="room-bottle-panel-header">
                  <h3>{t('racks.slotPlaceBottle', { position: emptySlotTarget.position })}</h3>
                  <button className="room-bottle-panel-close" onClick={() => setEmptySlotTarget(null)} aria-label="Close">&times;</button>
                </div>
                {rackObj && (
                  <p className="room-bottle-rack" style={{ margin: '0 0 0.5rem' }}>
                    {rackObj.name} &middot; {t('room.slot', 'slot')} {emptySlotTarget.position}
                  </p>
                )}
                <input
                  type="text"
                  className="room-slot-search"
                  placeholder={t('racks.searchWines', 'Search wines...')}
                  value={slotSearch}
                  onChange={e => handleSlotSearch(e.target.value)}
                  autoFocus
                />
                <div className="room-slot-bottle-list">
                  {slotLoading ? (
                    <p className="room-slot-empty">…</p>
                  ) : slotResults.length === 0 ? (
                    <p className="room-slot-empty">{t('racks.noUnplacedBottles', 'No available bottles')}</p>
                  ) : (
                    slotResults.map(b => (
                      <button
                        key={b._id}
                        className="room-slot-bottle-item"
                        onClick={() => handleAssignBottle(b._id)}
                      >
                        <span className={`room-slot-type-dot type-${b.wineDefinition?.type || 'red'}`} />
                        <div className="room-slot-bottle-info">
                          <strong>{b.wineDefinition?.name || 'Unknown'}</strong>
                          <span>
                            {b.wineDefinition?.producer}{b.vintage ? ` \u00B7 ${b.vintage}` : ''}
                            {b.wineDefinition?.country?.name ? ` \u00B7 ${b.wineDefinition.country.name}` : ''}
                          </span>
                        </div>
                      </button>
                    ))
                  )}
                </div>
              </div>
            );
          })()}

          {/* Consume modal */}
          {consumeModal && (
            <div className="room-consume-overlay" onClick={() => setConsumeModal(null)}>
              <div className="room-consume-modal" onClick={e => e.stopPropagation()}>
                <RoomConsumeForm
                  onSubmit={handleConsumeSubmit}
                  onCancel={() => setConsumeModal(null)}
                  t={t}
                />
              </div>
            </div>
          )}

          {/* Multi-select detail panel */}
          {selectedRackIds.length > 1 && isEditMode && (
            <div className="room-rack-detail">
              <div className="room-rack-detail-header">
                <h4>{selectedRackIds.length} {t('room.racksSelected', 'racks selected')}</h4>
              </div>
              <p style={{ opacity: 0.6, fontSize: '12px' }}>
                {t('room.shiftClickHint', 'Shift+click to add/remove racks')}
              </p>
              <div className="room-rack-detail-actions">
                <button className="btn btn-secondary btn-small" onClick={handleRotateRack}>
                  {t('room.rotateAll', 'Rotate All')}
                </button>
                <button className="btn btn-secondary btn-small" onClick={handleLinkSelected}>
                  {t('room.linkSelected', 'Link Selected')}
                </button>
                <button
                  className="btn btn-secondary btn-small"
                  onClick={() => setSelectedRackIds([])}
                >
                  {t('room.clearSelection', 'Clear')}
                </button>
                <button className="btn btn-danger btn-small" onClick={handleRemoveFromRoom}>
                  {t('room.removeFromRoom', 'Remove')}
                </button>
              </div>
            </div>
          )}

          {/* Selected rack detail (single selection) */}
          {selectedRackIds.length === 1 && selectedRack && (() => {
            const selectedPlacement = placements.find(
              rp => (rp.rack === selectedRackId || rp.rack?._id === selectedRackId)
            );
            const isInGroup = !!selectedPlacement?.group;
            const groupColor = selectedPlacement?.group ? groupColorMap[selectedPlacement.group] : null;

            return (
              <div className="room-rack-detail">
                <div className="room-rack-detail-header">
                  <h4>{selectedRack.name}</h4>
                  {isInGroup && (
                    <span className="room-group-badge" style={{ background: groupColor }}>
                      {t('room.linked', 'Linked')}
                    </span>
                  )}
                </div>
                <p>
                  {selectedRack.slots?.length || 0} bottles
                  {selectedRack.isModular ? ' (modular)' : ` (${selectedRack.type || 'grid'})`}
                  {(selectedPlacement?.rotation || 0) > 0 && ` · ${selectedPlacement.rotation}°`}
                </p>
                {isEditMode && (
                  <div className="room-rack-size-controls">
                    <div className="form-group form-group-inline">
                      <label>{t('room.rackScale', 'Scale')}</label>
                      <input
                        type="number" min={0.5} max={5} step={0.1}
                        value={selectedPlacement?.scaleOverride || ''}
                        placeholder="1.0"
                        onChange={(e) => handlePlacementField('scaleOverride', e.target.value || null)}
                      />
                    </div>
                    {selectedRack.type !== 'x-rack' && (
                      <>
                        <div className="form-group form-group-inline">
                          <label>{t('room.rackWidth', 'Width (m)')}</label>
                          <input
                            type="number" min={0.1} max={5} step={0.01}
                            value={selectedPlacement?.widthOverride || ''}
                            placeholder="auto"
                            onChange={(e) => handlePlacementField('widthOverride', e.target.value || null)}
                          />
                        </div>
                        <div className="form-group form-group-inline">
                          <label>{t('room.rackDepth', 'Depth (m)')}</label>
                          <input
                            type="number" min={0.1} max={2} step={0.01}
                            value={selectedPlacement?.depthOverride || ''}
                            placeholder="auto"
                            onChange={(e) => handlePlacementField('depthOverride', e.target.value || null)}
                          />
                        </div>
                      </>
                    )}
                  </div>
                )}
                {/* Interaction mode hint */}
                {interactionMode && (
                  <div className="room-interaction-hint">
                    <p>
                      {interactionMode === 'stack'
                        ? t('room.clickToStack', 'Click a rack to stack on top of it')
                        : t('room.clickToLink', 'Click a rack to link with')}
                    </p>
                    <button
                      className="btn btn-secondary btn-small"
                      onClick={() => setInteractionMode(null)}
                    >
                      {t('common.cancel', 'Cancel')}
                    </button>
                  </div>
                )}
                <div className="room-rack-detail-actions">
                  <Link to={`/cellars/${id}/racks?rack=${selectedRackId}`} className="btn btn-secondary btn-small">
                    {t('room.viewRack', 'View Rack')}
                  </Link>
                  {isEditMode && (
                    <>
                      <button
                        className="btn btn-secondary btn-small"
                        onClick={handleRotateRack}
                        title={`${(selectedPlacement?.rotation || 0) + 90}°`}
                      >
                        {t('room.rotateRack', 'Rotate')}
                      </button>
                      <button
                        className={`btn btn-small ${interactionMode === 'stack' ? 'btn-primary' : 'btn-secondary'}`}
                        onClick={() => setInteractionMode(m => m === 'stack' ? null : 'stack')}
                      >
                        {t('room.stackRack', 'Stack')}
                      </button>
                      <button
                        className={`btn btn-small ${interactionMode === 'link' ? 'btn-primary' : 'btn-secondary'}`}
                        onClick={() => setInteractionMode(m => m === 'link' ? null : 'link')}
                      >
                        {t('room.linkRack', 'Link')}
                      </button>
                      {isInGroup && (
                        <button
                          className="btn btn-secondary btn-small"
                          onClick={handleUnlinkRack}
                        >
                          {t('room.unlinkRack', 'Unlink')}
                        </button>
                      )}
                      {(selectedPlacement?.position?.y || 0) > 0 && (
                        <button
                          className="btn btn-secondary btn-small"
                          onClick={handleUnstackRack}
                        >
                          {t('room.unstackRack', 'Unstack')}
                        </button>
                      )}
                      <button
                        className="btn btn-danger btn-small"
                        onClick={handleRemoveFromRoom}
                      >
                        {t('room.removeFromRoom', 'Remove')}
                      </button>
                    </>
                  )}
                </div>
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
}

function RoomConsumeForm({ onSubmit, onCancel, t }) {
  const [reason, setReason] = useState('drank');
  const [note, setNote] = useState('');
  const [rating, setRating] = useState('');
  const [ratingScale, setRatingScale] = useState('5');
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    await onSubmit(reason, note || undefined, rating || undefined, ratingScale);
    setSaving(false);
  };

  return (
    <form onSubmit={handleSubmit}>
      <h3>{t('bottleDetail.removeBottleTitle', 'Remove Bottle')}</h3>
      <div className="form-group">
        <label>{t('common.reason', 'Reason')}</label>
        <select value={reason} onChange={e => setReason(e.target.value)}>
          <option value="drank">{t('bottleDetail.drinkReason', 'Drank')}</option>
          <option value="gifted">{t('bottleDetail.giftedReason', 'Gifted')}</option>
          <option value="sold">{t('bottleDetail.soldReason', 'Sold')}</option>
          <option value="other">{t('bottleDetail.otherReason', 'Other')}</option>
        </select>
      </div>
      {reason === 'drank' && (
        <div className="form-group">
          <label>{t('common.rating', 'Rating')}</label>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <input
              type="number"
              min={0}
              max={Number(ratingScale)}
              step={0.5}
              value={rating}
              onChange={e => setRating(e.target.value)}
              placeholder="—"
              style={{ width: '70px' }}
            />
            <span>/ </span>
            <select value={ratingScale} onChange={e => setRatingScale(e.target.value)} style={{ width: '60px' }}>
              <option value="5">5</option>
              <option value="10">10</option>
              <option value="20">20</option>
              <option value="100">100</option>
            </select>
          </div>
        </div>
      )}
      <div className="form-group">
        <label>{t('common.notes', 'Notes')}</label>
        <textarea value={note} onChange={e => setNote(e.target.value)} rows={2} />
      </div>
      <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem' }}>
        <button type="button" className="btn btn-secondary btn-small" onClick={onCancel}>
          {t('common.cancel', 'Cancel')}
        </button>
        <button type="submit" className="btn btn-consume btn-small" disabled={saving}>
          {saving ? t('common.saving', 'Saving...') : t('common.confirm', 'Confirm')}
        </button>
      </div>
    </form>
  );
}
