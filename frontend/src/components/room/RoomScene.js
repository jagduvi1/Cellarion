import { useRef, useMemo, useState, useCallback, useEffect } from 'react';
import { OrbitControls } from '@react-three/drei';
import { useThree, useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import RackMesh from './RackMesh';
import { getRackWorldDims, getRackHeight, clampToRoom, CELL_H, PANEL_THICK } from '../../utils/roomConstants';

// ── Camera auto-focus helper (animates camera to a target position) ──
function CameraFocus({ target, controlsRef }) {
  const { camera } = useThree();
  const animating = useRef(true);
  const frameCount = useRef(0);

  useEffect(() => {
    animating.current = true;
    frameCount.current = 0;
  }, [target]);

  useFrame(() => {
    if (!target || !animating.current) return;
    frameCount.current++;

    // Position camera in front of the rack, rotated to match rack orientation
    const rad = ((target.rotation || 0) * Math.PI) / 180;
    const goalPos = new THREE.Vector3(
      target.x + Math.sin(rad) * 2.5,
      target.y + 0.8,
      target.z + Math.cos(rad) * 2.5
    );
    const goalTarget = new THREE.Vector3(target.x, target.y, target.z);

    const lerpFactor = 0.06;
    camera.position.lerp(goalPos, lerpFactor);

    if (controlsRef.current) {
      const ctrl = controlsRef.current;
      const currentTarget = ctrl.target;
      currentTarget.lerp(goalTarget, lerpFactor);
      ctrl.update();
    }

    // Stop animating after convergence or max frames
    if (frameCount.current > 120 || camera.position.distanceTo(goalPos) < 0.05) {
      animating.current = false;
    }
  });

  return null;
}

// ── Modern cellar palette ────────────────────────────────
const FLOOR_COLOR = '#C8B8A0';
const WALL_COLOR = '#E8E4E0';
const CEILING_COLOR = '#F0EDE8';
const BASEBOARD_COLOR = '#D0C8BE';

export default function RoomScene({
  roomDimensions,
  rackPlacements,
  racks,
  isEditMode,
  selectedRackIds,
  groupColorMap,
  onRackClick,
  onRackDragEnd,
  onBottleClick,
  onEmptySlotClick,
  focusTarget,
  highlightBottleId,
}) {
  const { width: rw, depth: rd, height: rh } = roomDimensions;
  const halfW = rw / 2;
  const halfD = rd / 2;
  const controlsRef = useRef();
  const [isDragging, setIsDragging] = useState(false);

  const rackMap = useMemo(() => {
    const m = {};
    racks.forEach(r => { m[r._id] = r; });
    return m;
  }, [racks]);

  // ── Wall texture: subtle plaster / light concrete ──────
  const wallTexture = useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 256; canvas.height = 256;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#E8E4E0';
    ctx.fillRect(0, 0, 256, 256);
    // Subtle plaster noise
    for (let i = 0; i < 2000; i++) {
      const nx = Math.random() * 256;
      const ny = Math.random() * 256;
      const bright = Math.random() > 0.5;
      ctx.fillStyle = bright
        ? `rgba(255,255,255,${Math.random() * 0.04})`
        : `rgba(0,0,0,${Math.random() * 0.03})`;
      ctx.fillRect(nx, ny, 1 + Math.random() * 2, 1 + Math.random() * 2);
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    return tex;
  }, []);

  // ── Floor texture: light oak herringbone ───────────────
  const floorTexture = useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 256; canvas.height = 256;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#C8B8A0';
    ctx.fillRect(0, 0, 256, 256);
    // Light wood planks
    const plankW = 42;
    for (let i = 0; i < 7; i++) {
      const x = i * plankW;
      const shade = 170 + Math.floor(Math.random() * 25);
      ctx.fillStyle = `rgb(${shade}, ${shade - 15}, ${shade - 40})`;
      ctx.fillRect(x + 1, 0, plankW - 2, 256);
      // Subtle grain
      ctx.strokeStyle = `rgba(120, 90, 50, 0.08)`;
      ctx.lineWidth = 0.5;
      for (let g = 0; g < 5; g++) {
        const gy = Math.random() * 256;
        ctx.beginPath();
        ctx.moveTo(x + 2, gy);
        ctx.bezierCurveTo(
          x + plankW * 0.3, gy + (Math.random() - 0.5) * 6,
          x + plankW * 0.7, gy + (Math.random() - 0.5) * 6,
          x + plankW - 2, gy + (Math.random() - 0.5) * 3
        );
        ctx.stroke();
      }
      // Plank gap
      ctx.strokeStyle = 'rgba(100, 80, 50, 0.12)';
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, 256);
      ctx.stroke();
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    return tex;
  }, []);

  // ── Ceiling: clean white ───────────────────────────────
  const ceilingTexture = useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 64; canvas.height = 64;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#F5F2EE';
    ctx.fillRect(0, 0, 64, 64);
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    return tex;
  }, []);

  // Ref map for group-aware dragging (rackId → Three.js Group)
  const rackRefsMap = useRef({});

  // Keep a ref to selectedRackIds so drag handlers always read current value
  const selectedRackIdsRef = useRef(selectedRackIds);
  useEffect(() => { selectedRackIdsRef.current = selectedRackIds; }, [selectedRackIds]);

  const handleDragMove = useCallback((rackId, dx, dz) => {
    const placement = rackPlacements.find(rp => (rp.rack?._id || rp.rack) === rackId);
    const group = placement?.group;
    const currentSelected = selectedRackIdsRef.current;

    rackPlacements.forEach(rp => {
      const rpId = rp.rack?._id || rp.rack;
      if (rpId === rackId) return;
      const isGroupMember = group && rp.group === group;
      const isAlsoSelected = currentSelected.includes(rpId);
      if (isGroupMember || isAlsoSelected) {
        const ref = rackRefsMap.current[rpId];
        if (ref) {
          ref.position.x += dx;
          ref.position.z += dz;
        }
      }
    });
  }, [rackPlacements]);

  const handleDragStart = useCallback(() => {
    setIsDragging(true);
    if (controlsRef.current) controlsRef.current.enabled = false;
  }, []);

  // Keep a ref to rackPlacements so drag-end reads current positions
  const rackPlacementsRef = useRef(rackPlacements);
  useEffect(() => { rackPlacementsRef.current = rackPlacements; }, [rackPlacements]);

  const handleDragEnd = useCallback((rackId, newPos) => {
    setIsDragging(false);
    if (controlsRef.current) controlsRef.current.enabled = true;
    // Read current placement from ref to avoid stale y-position (Bug 8 fix)
    const currentRp = rackPlacementsRef.current.find(
      rp => (rp.rack?._id || rp.rack) === rackId
    );
    onRackDragEnd?.(rackId, { x: newPos[0], y: currentRp?.position?.y || 0, z: newPos[2] });
  }, [onRackDragEnd]);

  // Edge-snap for stacked racks + room boundary clamping
  const computeSnapPosition = useCallback((rackId, px, pz) => {
    const rp = rackPlacements.find(p => (p.rack?._id || p.rack) === rackId);
    const rack = rackMap[rackId];
    if (!rp || !rack) return { x: px, z: pz };

    let snapX = px, snapZ = pz;

    // Edge-snap for stacked racks: snap edges to align with racks below
    if ((rp.position?.y || 0) > 0) {
      const self = getRackWorldDims(rack, rp);
      const SNAP_T = 0.04;

      for (const otherRp of rackPlacements) {
        const otherId = otherRp.rack?._id || otherRp.rack;
        if (otherId === rackId) continue;
        if ((otherRp.position?.y || 0) >= (rp.position?.y || 0)) continue;
        const otherRack = rackMap[otherId];
        if (!otherRack) continue;
        const other = getRackWorldDims(otherRack, otherRp);
        const ox = otherRp.position?.x || 0;
        const oz = otherRp.position?.z || 0;
        if (Math.abs((px - self.halfW) - (ox - other.halfW)) < SNAP_T) snapX = ox - other.halfW + self.halfW;
        if (Math.abs((px + self.halfW) - (ox + other.halfW)) < SNAP_T) snapX = ox + other.halfW - self.halfW;
        if (Math.abs((pz - self.halfD) - (oz - other.halfD)) < SNAP_T) snapZ = oz - other.halfD + self.halfD;
        if (Math.abs((pz + self.halfD) - (oz + other.halfD)) < SNAP_T) snapZ = oz + other.halfD - self.halfD;
      }
    }

    // Clamp to room walls
    const clamped = clampToRoom(snapX, snapZ, rack, rp, roomDimensions);
    return clamped;
  }, [rackPlacements, rackMap, roomDimensions]);

  // Texture repeats — memoized to avoid cloning on every render
  const { wallTexN, wallTexS, wallTexW, wallTexE, floorTex, ceilTex } = useMemo(() => {
    const wN = wallTexture.clone(); wN.repeat.set(rw / 2, rh / 2);
    const wS = wallTexture.clone(); wS.repeat.set(rw / 2, rh / 2);
    const wW = wallTexture.clone(); wW.repeat.set(rd / 2, rh / 2);
    const wE = wallTexture.clone(); wE.repeat.set(rd / 2, rh / 2);
    const fl = floorTexture.clone(); fl.repeat.set(rw / 2, rd / 2);
    const ce = ceilingTexture.clone(); ce.repeat.set(rw / 4, rd / 4);
    return { wallTexN: wN, wallTexS: wS, wallTexW: wW, wallTexE: wE, floorTex: fl, ceilTex: ce };
  }, [wallTexture, floorTexture, ceilingTexture, rw, rd, rh]);

  return (
    <>
      {/* ── Lighting: bright, clean, modern ────────────── */}
      <ambientLight intensity={1.8} color="#FFFFFF" />

      {/* Overhead recessed downlights */}
      <directionalLight
        position={[0, rh, 0]}
        intensity={1.5}
        color="#FFF8F0"
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-halfW}
        shadow-camera-right={halfW}
        shadow-camera-top={halfD}
        shadow-camera-bottom={-halfD}
      />

      {/* Center pendant / spot */}
      <pointLight
        position={[0, rh - 0.2, 0]}
        intensity={2.0}
        color="#FFF4E8"
        distance={Math.max(rw, rd) * 2}
        decay={1.2}
        castShadow
      />

      {/* Additional fill lights */}
      <pointLight
        position={[halfW * 0.5, rh - 0.2, -halfD * 0.5]}
        intensity={1.2}
        color="#FFFFFF"
        distance={Math.max(rw, rd) * 2}
        decay={1.2}
      />
      <pointLight
        position={[-halfW * 0.5, rh - 0.2, halfD * 0.5]}
        intensity={1.2}
        color="#FFFFFF"
        distance={Math.max(rw, rd) * 2}
        decay={1.2}
      />

      {/* Hemisphere: white sky, warm ground bounce */}
      <hemisphereLight args={['#FFFFFF', '#D8C8B0', 0.5]} />

      {/* ── Camera controls ───────────────────────────── */}
      <OrbitControls
        ref={controlsRef}
        maxPolarAngle={Math.PI / 2 - 0.05}
        minDistance={0.3}
        maxDistance={Math.max(rw, rd) * 2.5}
        target={[0, rh * 0.3, 0]}
        enableDamping
        dampingFactor={0.1}
        enabled={!isDragging}
      />

      {/* ── Camera focus animation (when navigating from bottle detail) ── */}
      {focusTarget && <CameraFocus target={focusTarget} controlsRef={controlsRef} />}

      {/* ── Floor (light oak) ─────────────────────────── */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow>
        <planeGeometry args={[rw, rd]} />
        <meshStandardMaterial map={floorTex} color={FLOOR_COLOR} roughness={0.7} metalness={0.02} />
      </mesh>

      {/* ── Ceiling (clean white) ─────────────────────── */}
      <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, rh, 0]}>
        <planeGeometry args={[rw, rd]} />
        <meshStandardMaterial map={ceilTex} color={CEILING_COLOR} roughness={0.9} metalness={0} />
      </mesh>

      {/* ── Walls (smooth light plaster) ──────────────── */}
      <mesh position={[0, rh / 2, -halfD]}>
        <planeGeometry args={[rw, rh]} />
        <meshStandardMaterial map={wallTexN} color={WALL_COLOR} roughness={0.85} metalness={0} />
      </mesh>
      <mesh position={[0, rh / 2, halfD]} rotation={[0, Math.PI, 0]}>
        <planeGeometry args={[rw, rh]} />
        <meshStandardMaterial map={wallTexS} color={WALL_COLOR} roughness={0.85} metalness={0} />
      </mesh>
      <mesh position={[-halfW, rh / 2, 0]} rotation={[0, Math.PI / 2, 0]}>
        <planeGeometry args={[rd, rh]} />
        <meshStandardMaterial map={wallTexW} color={WALL_COLOR} roughness={0.85} metalness={0} />
      </mesh>
      <mesh position={[halfW, rh / 2, 0]} rotation={[0, -Math.PI / 2, 0]}>
        <planeGeometry args={[rd, rh]} />
        <meshStandardMaterial map={wallTexE} color={WALL_COLOR} roughness={0.85} metalness={0} />
      </mesh>

      {/* ── Baseboards (slim modern trim) ─────────────── */}
      {[
        [0, 0.03, -halfD + 0.005, rw, 0.06, 0.01],
        [0, 0.03, halfD - 0.005, rw, 0.06, 0.01],
        [-halfW + 0.005, 0.03, 0, 0.01, 0.06, rd],
        [halfW - 0.005, 0.03, 0, 0.01, 0.06, rd],
      ].map(([x, y, z, w, h, d], i) => (
        <mesh key={`bb-${i}`} position={[x, y, z]}>
          <boxGeometry args={[w, h, d]} />
          <meshStandardMaterial color={BASEBOARD_COLOR} roughness={0.6} />
        </mesh>
      ))}

      {/* ── Edit-mode floor grid ──────────────────────── */}
      {isEditMode && (
        <group position={[0, 0.002, 0]}>
          {Array.from({ length: Math.floor(rw / 0.5) + 1 }).map((_, i) => {
            const x = -halfW + i * 0.5;
            return (
              <mesh key={`gx-${i}`} rotation={[-Math.PI / 2, 0, 0]} position={[x, 0, 0]}>
                <planeGeometry args={[0.004, rd]} />
                <meshBasicMaterial color="#A0A0A0" transparent opacity={0.15} />
              </mesh>
            );
          })}
          {Array.from({ length: Math.floor(rd / 0.5) + 1 }).map((_, i) => {
            const z = -halfD + i * 0.5;
            return (
              <mesh key={`gz-${i}`} rotation={[-Math.PI / 2, 0, Math.PI / 2]} position={[0, 0, z]}>
                <planeGeometry args={[0.004, rw]} />
                <meshBasicMaterial color="#A0A0A0" transparent opacity={0.15} />
              </mesh>
            );
          })}
        </group>
      )}

      {/* ── Racks ─────────────────────────────────────── */}
      {rackPlacements.map((rp, idx) => {
        const rack = rackMap[rp.rack] || rackMap[rp.rack?._id];
        if (!rack) return null;
        const pos = rp.position || { x: 0, y: 0, z: 0 };
        const rackScale = rp.scaleOverride || 1;
        const rackHeight = getRackHeight(rack) * rackScale;

        return (
          <RackMesh
            key={rack._id || idx}
            rack={rack}
            position={[pos.x, rackHeight / 2 + (pos.y || 0), pos.z]}
            rotation={rp.rotation || 0}
            widthOverride={rp.widthOverride}
            depthOverride={rp.depthOverride}
            scaleOverride={rp.scaleOverride}
            isEditMode={isEditMode}
            isSelected={selectedRackIds.includes(rack._id)}
            groupColor={rp.group ? groupColorMap?.[rp.group] : null}
            onSetRef={(threeGroup) => { rackRefsMap.current[rack._id] = threeGroup; }}
            onDragMove={(dx, dz) => handleDragMove(rack._id, dx, dz)}
            onClick={(shiftKey) => onRackClick?.(rack._id, shiftKey)}
            onDragStart={handleDragStart}
            onDragEnd={(newPos) => handleDragEnd(rack._id, newPos)}
            onSnapPosition={(px, pz) => computeSnapPosition(rack._id, px, pz)}
            onBottleClick={(slot) => onBottleClick?.(rack._id, slot)}
            onEmptySlotClick={(slotPos) => onEmptySlotClick?.(rack._id, slotPos)}
            highlightBottleId={highlightBottleId}
          />
        );
      })}
    </>
  );
}
