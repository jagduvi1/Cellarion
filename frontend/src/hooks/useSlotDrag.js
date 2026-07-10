import { useState, useRef, useEffect, useCallback } from 'react';

/**
 * Find the slot whose center is nearest to (x, y) within its own hit radius
 * (scaled by `factor` to be a little forgiving). Returns the slot's position
 * or null. Pure — exported for tests.
 */
export function findNearestSlot(slotCenters, x, y, { exclude = null, factor = 1.2 } = {}) {
  let best = null;
  let bestD = Infinity;
  for (const s of slotCenters) {
    if (s.position === exclude) continue;
    const dx = s.cx - x;
    const dy = s.cy - y;
    const d = dx * dx + dy * dy;
    const hit = s.r * factor;
    if (d <= hit * hit && d < bestD) {
      bestD = d;
      best = s.position;
    }
  }
  return best;
}

/**
 * Pointer-based drag & drop between the slots of an SVG rack renderer.
 *
 * Mouse/pen only — on touch the tap→popup flow already covers moving a
 * bottle, and capturing touch drags would fight page scrolling.
 *
 * A drag only begins once the pointer travels past a small threshold, so
 * plain clicks still open the slot popup; after a drop the next click on
 * the rack is suppressed (shouldSuppressClick) so the popup doesn't open
 * on top of the just-finished drag.
 *
 * @param {object}   opts
 * @param {object}   opts.svgRef        ref to the <svg> element (viewBox coords)
 * @param {Array}    opts.slotCenters   [{ position, cx, cy, r }] in viewBox coords
 * @param {Function} opts.isValidTarget (position) => boolean
 * @param {Function} opts.onMove        (fromPosition, toPosition) => void
 * @param {boolean}  opts.enabled
 * @returns {{ drag: null | { from, x, y, over }, startDrag, shouldSuppressClick }}
 */
export default function useSlotDrag({ svgRef, slotCenters, isValidTarget, onMove, enabled }) {
  const [drag, setDrag] = useState(null);
  const pendingRef = useRef(null); // pointer down on a slot, threshold not yet passed
  const dragRef = useRef(null);
  const suppressUntilRef = useRef(0);

  const toSvgPoint = useCallback((clientX, clientY) => {
    const svg = svgRef.current;
    const ctm = svg?.getScreenCTM();
    if (!ctm) return null;
    const pt = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
    return { x: pt.x, y: pt.y };
  }, [svgRef]);

  const findTarget = useCallback((x, y, from) => {
    const pos = findNearestSlot(slotCenters, x, y, { exclude: from });
    return pos != null && isValidTarget(pos) ? pos : null;
  }, [slotCenters, isValidTarget]);

  useEffect(() => {
    if (!enabled) return undefined;

    const onPointerMove = (e) => {
      const pending = pendingRef.current;
      if (pending && !dragRef.current) {
        const dx = e.clientX - pending.clientX;
        const dy = e.clientY - pending.clientY;
        if (dx * dx + dy * dy < 36) return; // < 6px — still a click
        dragRef.current = { from: pending.from };
      }
      if (!dragRef.current) return;
      const p = toSvgPoint(e.clientX, e.clientY);
      if (!p) return;
      setDrag({
        from: dragRef.current.from,
        x: p.x,
        y: p.y,
        over: findTarget(p.x, p.y, dragRef.current.from),
      });
    };

    const onPointerUp = (e) => {
      const active = dragRef.current;
      pendingRef.current = null;
      dragRef.current = null;
      if (!active) return;
      suppressUntilRef.current = Date.now() + 400;
      setDrag(null);
      const p = toSvgPoint(e.clientX, e.clientY);
      const target = p ? findTarget(p.x, p.y, active.from) : null;
      if (target != null) onMove(active.from, target);
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
    };
  }, [enabled, toSvgPoint, findTarget, onMove]);

  const startDrag = useCallback((e, position) => {
    if (!enabled || e.pointerType === 'touch' || e.button !== 0) return;
    pendingRef.current = { from: position, clientX: e.clientX, clientY: e.clientY };
  }, [enabled]);

  const shouldSuppressClick = useCallback(() => Date.now() < suppressUntilRef.current, []);

  return { drag, startDrag, shouldSuppressClick };
}
