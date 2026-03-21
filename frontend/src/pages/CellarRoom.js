import { useState, useEffect, useCallback, useMemo, Suspense } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Canvas } from '@react-three/fiber';
import { useAuth } from '../contexts/AuthContext';
import { getCellar } from '../api/cellars';
import { getRacks } from '../api/racks';
import { getCellarLayout, saveCellarLayout } from '../api/cellarLayout';
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
  const [showStackPicker, setShowStackPicker] = useState(false);
  const [showLinkPicker, setShowLinkPicker] = useState(false);

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
        setLayout(layoutData.layout);
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
    try {
      const res = await saveCellarLayout(apiFetch, {
        cellar: id,
        roomDimensions: layout.roomDimensions,
        rackPlacements: layout.rackPlacements,
      });
      if (res.ok) {
        const data = await res.json();
        setLayout(data.layout);
      }
    } catch (err) {
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

  // Add racks that aren't yet placed in the room
  const handleAddUnplacedRacks = useCallback(() => {
    setLayout(prev => {
      const placedIds = new Set(prev.rackPlacements.map(rp => rp.rack?._id || rp.rack));
      const unplaced = racks.filter(r => !placedIds.has(r._id));
      if (unplaced.length === 0) return prev;

      const newPlacements = unplaced.map((r, i) => ({
        rack: r._id,
        position: { x: i * 1.5, y: 0, z: 0 },
        rotation: 0,
        wall: 'none',
      }));
      return {
        ...prev,
        rackPlacements: [...prev.rackPlacements, ...newPlacements],
      };
    });
  }, [racks]);

  // Stack a rack on top of the currently selected rack
  const handleStackRack = useCallback((stackRackId) => {
    if (!selectedRackId || !layout) return;
    const selectedPlacement = layout.rackPlacements.find(
      rp => (rp.rack === selectedRackId || rp.rack?._id === selectedRackId)
    );
    if (!selectedPlacement) return;

    const selectedRackObj = racks.find(r => r._id === selectedRackId);
    if (!selectedRackObj) return;

    const baseY = selectedPlacement.position?.y || 0;
    const baseHeight = getRackHeight(selectedRackObj);
    const stackY = baseY + baseHeight;

    setLayout(prev => {
      const alreadyPlaced = prev.rackPlacements.some(
        rp => (rp.rack === stackRackId || rp.rack?._id === stackRackId)
      );

      if (alreadyPlaced) {
        // Move existing placement on top of selected rack
        return {
          ...prev,
          rackPlacements: prev.rackPlacements.map(rp =>
            (rp.rack === stackRackId || rp.rack?._id === stackRackId)
              ? {
                  ...rp,
                  position: {
                    x: selectedPlacement.position?.x || 0,
                    y: stackY,
                    z: selectedPlacement.position?.z || 0,
                  },
                  rotation: selectedPlacement.rotation || 0,
                }
              : rp
          ),
        };
      } else {
        // Add new placement on top
        return {
          ...prev,
          rackPlacements: [
            ...prev.rackPlacements,
            {
              rack: stackRackId,
              position: {
                x: selectedPlacement.position?.x || 0,
                y: stackY,
                z: selectedPlacement.position?.z || 0,
              },
              rotation: selectedPlacement.rotation || 0,
              wall: 'none',
            },
          ],
        };
      }
    });
    setShowStackPicker(false);
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

  // Link racks into a group (move together)
  const handleLinkRack = useCallback((targetRackId) => {
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
          // Merge existing groups
          if (oldGroupA && rp.group === oldGroupA) return { ...rp, group: groupId };
          if (oldGroupB && rp.group === oldGroupB) return { ...rp, group: groupId };
          return rp;
        }),
      };
    });
    setShowLinkPicker(false);
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
                <button className="btn btn-secondary btn-small" onClick={handleAddUnplacedRacks}>
                  {t('room.addAllRacks', 'Add Racks')}
                </button>
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
                  if (shiftKey) {
                    setSelectedRackIds(prev =>
                      prev.includes(rackId) ? prev.filter(id => id !== rackId) : [...prev, rackId]
                    );
                  } else {
                    setSelectedRackIds([rackId]);
                  }
                  setShowStackPicker(false);
                  setShowLinkPicker(false);
                }}
                onRackDragEnd={handleRackDragEnd}
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
                        className="btn btn-secondary btn-small"
                        onClick={() => { setShowStackPicker(p => !p); setShowLinkPicker(false); }}
                      >
                        {t('room.stackRack', 'Stack')}
                      </button>
                      <button
                        className="btn btn-secondary btn-small"
                        onClick={() => { setShowLinkPicker(p => !p); setShowStackPicker(false); }}
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
                    </>
                  )}
                </div>
                {showStackPicker && isEditMode && (
                  <div className="room-stack-picker">
                    <p className="room-stack-picker-label">
                      {t('room.stackOnTop', 'Place a rack on top:')}
                    </p>
                    {racks.filter(r => r._id !== selectedRackId).length === 0 ? (
                      <p className="room-stack-picker-empty">
                        {t('room.noOtherRacks', 'No other racks available.')}
                      </p>
                    ) : (
                      <div className="room-stack-picker-list">
                        {racks.filter(r => r._id !== selectedRackId).map(r => (
                          <button
                            key={r._id}
                            className="room-stack-picker-item"
                            onClick={() => handleStackRack(r._id)}
                          >
                            <span className="room-stack-picker-name">{r.name}</span>
                            <span className="room-stack-picker-info">
                              {r.isModular ? 'modular' : r.type || 'grid'}
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                {showLinkPicker && isEditMode && (
                  <div className="room-stack-picker">
                    <p className="room-stack-picker-label">
                      {t('room.linkToRack', 'Link to a rack (move together):')}
                    </p>
                    {racks.filter(r => r._id !== selectedRackId).length === 0 ? (
                      <p className="room-stack-picker-empty">
                        {t('room.noOtherRacksToLink', 'No other racks to link.')}
                      </p>
                    ) : (
                      <div className="room-stack-picker-list">
                        {racks.filter(r => r._id !== selectedRackId).map(r => {
                          const rPlacement = placements.find(
                            rp => (rp.rack === r._id || rp.rack?._id === r._id)
                          );
                          const alreadyLinked = isInGroup && rPlacement?.group === selectedPlacement?.group;
                          return (
                            <button
                              key={r._id}
                              className={`room-stack-picker-item ${alreadyLinked ? 'already-linked' : ''}`}
                              onClick={() => !alreadyLinked && handleLinkRack(r._id)}
                              disabled={alreadyLinked}
                            >
                              <span className="room-stack-picker-name">{r.name}</span>
                              <span className="room-stack-picker-info">
                                {alreadyLinked ? t('room.linked', 'Linked') : (r.isModular ? 'modular' : r.type || 'grid')}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
}
