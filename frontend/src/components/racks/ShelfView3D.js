import { Suspense, useMemo, useRef } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import RackMesh from '../room/RackMesh';
import {
  CELL_W, CELL_H, RACK_DEPTH, PANEL_THICK, getDisplayDims,
} from '../../utils/roomConstants';
import './ShelfView3D.css';

/**
 * True 3D view of a single rack — wraps the existing RackMesh in its own
 * Canvas with camera controls, lighting, and an auto-framed default view.
 *
 * The same RackMesh that the whole-cellar Room scene uses, so any future
 * improvements to bottle/shelf geometry flow through to both views.
 * Click parity with the other views: clicking a bottle or empty slot
 * fires the parent's onSlotClick exactly like Compact / Shelf view do.
 */
export default function ShelfView3D({ rack, activePosition, highlightPos, onSlotClick }) {
  const orbitRef = useRef();

  // Compute reasonable rack dimensions for camera placement (matches the
  // formulas RackMesh uses internally so the camera frames the rack tightly).
  const { displayRows, displayCols } = getDisplayDims(rack);
  const rackType = rack.type || 'grid';
  const hasShelfBack = rackType === 'shelf' && (rack.typeConfig?.backCols || 0) > 0;
  const width  = displayCols * CELL_W + PANEL_THICK * 2;
  const height = displayRows * CELL_H + PANEL_THICK * 2;
  const depth  = hasShelfBack ? RACK_DEPTH * 1.7 : RACK_DEPTH;

  // RackMesh centres the rack at y=0 internally. We shift it up by height/2
  // so it stands ON the ground plane (its base touches y=0) instead of
  // passing through it. The camera then aims at the rack's visual centre
  // (y = height/2) so top and bottom shelves get equal screen real estate.
  const maxDim = Math.max(width, height, depth);
  // Distance needed to frame the rack. Account for BOTH the vertical extent
  // (height) and the horizontal extent (width) so wide-short racks aren't
  // clipped left/right on load. width * 0.85 conservatively covers the
  // horizontal fit at a 45° vertical FOV across typical canvas aspect ratios.
  const fitDistance = Math.max(height * 1.35, width * 0.85) + depth * 0.5;
  const camPos = useMemo(() => ([
    // Cap the sideways offset so very wide racks stay centred.
    Math.min(width * 0.55, fitDistance * 0.5),
    height * 0.65,           // slight elevation above the rack centre
    fitDistance,
  ]), [width, height, fitDistance]);
  const camTarget = [0, height * 0.5, 0];

  // The popup-state in CellarRacks is keyed by SLOT POSITION; RackMesh's
  // highlight prop uses BOTTLE ID. Convert by looking up the bottle that
  // currently occupies highlightPos.
  const highlightBottleId = useMemo(() => {
    if (highlightPos == null) return null;
    const slot = (rack.slots || []).find(s => s.position === highlightPos);
    return slot?.bottle?._id || slot?.bottle || null;
  }, [highlightPos, rack.slots]);

  return (
    <div className="shelf-view-3d">
      <div className="shelf-view-3d-toolbar">
        <div className="shelf-view-hint">
          Drag to rotate · scroll to zoom · click the wooden handle to slide a shelf out
        </div>
      </div>
      <div className="shelf-view-3d-canvas">
        <Canvas
          shadows
          camera={{ position: camPos, fov: 45, near: 0.05, far: 30 }}
          dpr={[1, 2]}
          style={{ width: '100%', height: '100%' }}
        >
          <Suspense fallback={null}>
            {/* Soft ambient + a slightly warm key light from above-front */}
            <ambientLight intensity={1.4} color="#FFFFFF" />
            <hemisphereLight args={['#FFFFFF', '#D8C8B0', 0.5]} />
            <directionalLight
              position={[width * 0.6, height * 2.5, depth * 2.5]}
              intensity={1.4}
              color="#FFF8F0"
              castShadow
              shadow-mapSize={[1024, 1024]}
            />
            <pointLight
              position={[-width * 0.5, height * 1.5, depth * 1.5]}
              intensity={0.6}
              color="#FFFFFF"
              distance={maxDim * 6}
              decay={1.3}
            />

            {/* Soft ground plane catches a hint of shadow */}
            <mesh
              rotation={[-Math.PI / 2, 0, 0]}
              position={[0, -0.01, 0]}
              receiveShadow
            >
              <planeGeometry args={[maxDim * 4, maxDim * 4]} />
              <meshStandardMaterial color="#1A1A1A" roughness={0.95} metalness={0} />
            </mesh>

            <RackMesh
              rack={rack}
              position={[0, height / 2, 0]}
              rotation={0}
              isEditMode={false}
              isSelected={false}
              onBottleClick={(slot) => onSlotClick?.(slot.position, slot)}
              onEmptySlotClick={(slotPos) => onSlotClick?.(slotPos, null)}
              highlightBottleId={highlightBottleId}
              enableShelfPullOut
            />

            <OrbitControls
              ref={orbitRef}
              target={camTarget}
              enableDamping
              dampingFactor={0.1}
              minDistance={Math.max(maxDim * 0.4, 0.3)}
              maxDistance={maxDim * 6}
              maxPolarAngle={Math.PI / 2 - 0.05}
            />
          </Suspense>
        </Canvas>
      </div>
      {activePosition != null && (
        <div className="shelf-view-3d-active-note">
          Slot {activePosition} selected — see the panel for details
        </div>
      )}
    </div>
  );
}
