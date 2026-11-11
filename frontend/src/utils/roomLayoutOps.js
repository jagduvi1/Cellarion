// The room editor's layout changes, each a pure function from one layout to
// the next: (layout, what the user did) -> layout, the same object when
// nothing changes. pages/CellarRoom.js calls them through its undo history
// and keeps everything else (selection, modes, saving).

import { getRackHeight, clampToRoom } from './roomConstants';

// The room a cellar gets before its owner has set one.
export const DEFAULT_DIMENSIONS = { width: 10, depth: 10, height: 3 };

/**
 * A rack dropped at `newPosition`: its group and the other selected racks
 * (`currentSelected`) move by the same step, each kept inside the room.
 */
export function dragRack(prev, { rackId, newPosition, currentSelected, racks }) {
  const draggedPlacement = prev.rackPlacements.find(
    rp => (rp.rack === rackId || rp.rack?._id === rackId)
  );
  if (!draggedPlacement) return prev;

  const group = draggedPlacement.group;
  const oldX = draggedPlacement.position?.x || 0;
  const oldZ = draggedPlacement.position?.z || 0;
  const dx = newPosition.x - oldX;
  const dz = newPosition.z - oldZ;
  const dims = prev.roomDimensions || DEFAULT_DIMENSIONS;

  return {
    ...prev,
    rackPlacements: prev.rackPlacements.map(rp => {
      const rpId = rp.rack?._id || rp.rack;
      if (rpId === rackId) {
        return { ...rp, position: newPosition };
      }
      const isGroupMember = group && rp.group === group;
      const isAlsoSelected = currentSelected.includes(rpId);
      if (isGroupMember || isAlsoSelected) {
        let nx = (rp.position?.x || 0) + dx;
        let nz = (rp.position?.z || 0) + dz;
        const rack = racks.find(r => r._id === rpId);
        if (rack) {
          const clamped = clampToRoom(nx, nz, rack, rp, dims);
          nx = clamped.x;
          nz = clamped.z;
        }
        return {
          ...rp,
          position: { x: nx, y: rp.position?.y || 0, z: nz },
        };
      }
      return rp;
    }),
  };
}

/**
 * One room dimension changed, held to the range the layout schema takes;
 * racks the new walls would cut through are pulled back inside.
 */
export function changeRoomDimension(prev, { field, value, racks }) {
  // Clamp to the schema's per-field range (height caps at 10, width/depth
  // at 50). Typed/pasted values bypass the input's HTML max, so without
  // this an out-of-range height fails server validation and blocks the
  // entire layout save.
  const maxForField = field === 'height' ? 10 : 50;
  const newDims = { ...prev.roomDimensions, [field]: Math.max(2, Math.min(maxForField, Number(value) || 2)) };
  // Clamp all racks that would end up outside the new room boundaries
  const clampedPlacements = prev.rackPlacements.map(rp => {
    const rpId = rp.rack?._id || rp.rack;
    const rack = racks.find(r => r._id === rpId);
    if (!rack) return rp;
    const clamped = clampToRoom(rp.position?.x || 0, rp.position?.z || 0, rack, rp, newDims);
    if (clamped.x === (rp.position?.x || 0) && clamped.z === (rp.position?.z || 0)) return rp;
    return { ...rp, position: { ...rp.position, x: clamped.x, z: clamped.z } };
  });
  return { ...prev, roomDimensions: newDims, rackPlacements: clampedPlacements };
}

/**
 * A quarter turn. One rack selected: its group orbits it. Several: each turns
 * in place.
 */
export function rotateRacks(prev, { selectedRackIds }) {
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
}

/**
 * A rack not in the room yet is placed at its centre.
 */
export function addRackToRoom(prev, { rackId }) {
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
}

/**
 * The selected rack goes on top of the target (the caller worked out where
 * that is); its group moves by the same step.
 */
export function stackRackOnTarget(prev, { selectedRackId, targetPlacement, targetX, targetY, targetZ, group, dx, dy, dz }) {
  return {
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
  };
}

/**
 * The selected rack back on the floor, with the group members that stood at
 * its height.
 */
export function unstackRack(prev, { selectedRackId }) {
  const selectedPlacement = prev.rackPlacements.find(
    rp => (rp.rack?._id || rp.rack) === selectedRackId
  );
  if (!selectedPlacement) return prev;
  const oldY = selectedPlacement.position?.y || 0;
  if (oldY === 0) return prev; // already on floor
  const group = selectedPlacement.group;

  return {
    ...prev,
    rackPlacements: prev.rackPlacements.map(rp => {
      const rpId = rp.rack?._id || rp.rack;
      const rpY = rp.position?.y || 0;
      // Move the selected rack to floor
      if (rpId === selectedRackId) {
        return { ...rp, position: { ...rp.position, y: 0 } };
      }
      // Move group members at the same elevation by the same offset
      if (group && rp.group === group && Math.abs(rpY - oldY) < 0.001) {
        return { ...rp, position: { ...rp.position, y: 0 } };
      }
      return rp;
    }),
  };
}

/**
 * The selected rack and the target in one group; groups either was in merge
 * into it.
 */
export function linkRackToTarget(prev, { selectedRackId, targetRackId }) {
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
}

/**
 * The selected rack leaves its group.
 */
export function unlinkRack(prev, { selectedRackId }) {
  return {
  ...prev,
  rackPlacements: prev.rackPlacements.map(rp => {
    const rpId = rp.rack?._id || rp.rack;
    if (rpId === selectedRackId) {
      return { ...rp, group: null };
    }
    return rp;
  }),
  };
}

/**
 * The racks in `removeSet` leave the room layout (the racks themselves stay).
 */
export function removeRacksFromRoom(prev, { removeSet }) {
  return {
  ...prev,
  rackPlacements: prev.rackPlacements.filter(
    rp => !removeSet.has(rp.rack?._id || rp.rack)
  ),
  };
}

/**
 * One placement field of the selected rack (a width, depth or scale override)
 * set, or cleared by an empty value. A new scale lifts or lowers what is
 * stacked on the rack; a rack pushed through a wall is pulled back inside.
 */
export function setPlacementField(prev, { field, value, selectedRackId, racks }) {
  // First, apply the field change
  const updatedPlacements = prev.rackPlacements.map(rp => {
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
  });

  // If scaleOverride changed, reposition any racks stacked on top
  if (field === 'scaleOverride') {
    const changedRp = updatedPlacements.find(
      rp => (rp.rack?._id || rp.rack) === selectedRackId
    );
    if (changedRp) {
      const rackObj = racks.find(r => r._id === selectedRackId);
      if (rackObj) {
        const oldScale = prev.rackPlacements.find(
          rp => (rp.rack?._id || rp.rack) === selectedRackId
        )?.scaleOverride || 1;
        const newScale = changedRp.scaleOverride || 1;
        const oldTop = (changedRp.position?.y || 0) + getRackHeight(rackObj) * oldScale;
        const newTop = (changedRp.position?.y || 0) + getRackHeight(rackObj) * newScale;
        const dy = newTop - oldTop;

        if (dy !== 0) {
          // Shift every rack whose base y matches the old top of this rack
          const EPSILON = 0.001;
          for (let i = 0; i < updatedPlacements.length; i++) {
            const rp = updatedPlacements[i];
            const rpId = rp.rack?._id || rp.rack;
            if (rpId === selectedRackId) continue;
            const rpY = rp.position?.y || 0;
            if (Math.abs(rpY - oldTop) < EPSILON) {
              updatedPlacements[i] = {
                ...rp,
                position: { ...rp.position, y: rpY + dy },
              };
            }
          }
        }
      }
    }
  }

  // Clamp the changed rack if scale/width/depth change pushed it out of bounds
  if (['scaleOverride', 'widthOverride', 'depthOverride'].includes(field)) {
    const dims = prev.roomDimensions || DEFAULT_DIMENSIONS;
    for (let i = 0; i < updatedPlacements.length; i++) {
      const rp = updatedPlacements[i];
      const rpId = rp.rack?._id || rp.rack;
      const rack = racks.find(r => r._id === rpId);
      if (!rack) continue;
      const clamped = clampToRoom(rp.position?.x || 0, rp.position?.z || 0, rack, rp, dims);
      if (clamped.x !== (rp.position?.x || 0) || clamped.z !== (rp.position?.z || 0)) {
        updatedPlacements[i] = { ...rp, position: { ...rp.position, x: clamped.x, z: clamped.z } };
      }
    }
  }

  return { ...prev, rackPlacements: updatedPlacements };
}

/**
 * An arrow-key step for the selected racks and their groups, on the 5 cm
 * grid and inside the room.
 */
export function nudgeRacks(prev, { selectedRackIds, dx, dz, racks }) {
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
  const dims = prev.roomDimensions || DEFAULT_DIMENSIONS;
  return {
    ...prev,
    rackPlacements: prev.rackPlacements.map(rp => {
      const rpId = rp.rack?._id || rp.rack;
      if (moveIds.has(rpId)) {
        const rack = racks.find(r => r._id === rpId);
        let nx = Math.round(((rp.position?.x || 0) + dx) * 20) / 20;
        let nz = Math.round(((rp.position?.z || 0) + dz) * 20) / 20;
        if (rack) {
          const clamped = clampToRoom(nx, nz, rack, rp, dims);
          nx = clamped.x;
          nz = clamped.z;
        }
        return {
          ...rp,
          position: { x: nx, y: rp.position?.y || 0, z: nz },
        };
      }
      return rp;
    }),
  };
}

/**
 * Every selected rack in one group; groups any of them was in merge into it.
 */
export function linkSelectedRacks(prev, { selectedRackIds }) {
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
}

/**
 * What a layout sends to the server: every rack by its plain id, no unknown
 * fields, and every number held to the range the layout schema takes (one
 * value out of range would refuse the whole save).
 */
export function layoutForSave(layout) {
  // Clamp a value to the schema range (a single out-of-range field would
  // otherwise fail server validation and block the whole layout save).
  const clamp = (v, lo, hi, fallback = 0) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(lo, Math.min(hi, n));
  };

  // Sanitize placements: ensure rack is a plain ID string, strip unknown
  // fields, and clamp every numeric field to its CellarLayout schema range.
  const cleanPlacements = layout.rackPlacements.map(rp => {
    const clean = {
      rack: rp.rack?._id || rp.rack,
      position: {
        x: clamp(rp.position?.x, -100, 100),
        y: clamp(rp.position?.y, -10, 50),
        z: clamp(rp.position?.z, -100, 100),
      },
      rotation: rp.rotation || 0,
      wall: rp.wall || 'none',
    };
    if (rp.group) clean.group = String(rp.group).slice(0, 50);
    if (rp.widthOverride) clean.widthOverride = clamp(rp.widthOverride, 0.1, 5, 1);
    if (rp.depthOverride) clean.depthOverride = clamp(rp.depthOverride, 0.1, 2, 1);
    if (rp.scaleOverride) clean.scaleOverride = clamp(rp.scaleOverride, 0.5, 5, 1);
    return clean;
  });

  const cleanDims = {
    width: clamp(layout.roomDimensions?.width, 2, 50, 10),
    depth: clamp(layout.roomDimensions?.depth, 2, 50, 10),
    height: clamp(layout.roomDimensions?.height, 2, 10, 3),
  };

  return { roomDimensions: cleanDims, rackPlacements: cleanPlacements };
}

/**
 * The layout of a cellar that has none saved: its racks in a line along the
 * north wall of the default room, each kept inside it.
 */
export function autoLayoutFor(cellarId, racks) {
  const autoPlace = racks.map((r, i) => {
    const clamped = clampToRoom(-3 + i * 1.5, -3, r, {}, DEFAULT_DIMENSIONS);
    return {
      rack: r._id,
      position: { x: clamped.x, y: 0, z: clamped.z },
      rotation: 0,
      wall: 'north',
    };
  });
  return {
    cellar: cellarId,
    roomDimensions: DEFAULT_DIMENSIONS,
    rackPlacements: autoPlace,
  };
}

/**
 * A colour for each group of linked racks, by the order the groups appear in
 * the layout; the palette repeats after six.
 */
export function groupColors(rackPlacements) {
  const map = {};
  const palette = ['#E74C3C', '#3498DB', '#2ECC71', '#F39C12', '#9B59B6', '#1ABC9C'];
  const groups = [...new Set(
    (rackPlacements || []).map(rp => rp.group).filter(Boolean)
  )];
  groups.forEach((g, i) => { map[g] = palette[i % palette.length]; });
  return map;
}
