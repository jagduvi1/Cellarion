import { useCallback, useRef, useState } from 'react';

// Undo steps kept; older ones fall off.
const MAX_UNDO = 50;

/**
 * The room layout with its undo and redo history: the state behind the room
 * planner's edit mode (pages/CellarRoom).
 *
 * An edit is worked out here, from the layout as last written, and only its
 * result is handed to React. A state updater must be pure: React runs it twice
 * in StrictMode, so a history step recorded inside one is recorded twice and
 * one edit takes two undos.
 *
 * Returns:
 *   layout                 the current layout (null until one is set)
 *   setLayout(next)        replace it without a history step (a load, a save's answer)
 *   setLayoutWithHistory   an edit: takes the next layout or `(prev) => next`;
 *                          returning `prev` itself records nothing
 *   undo(), redo()         step through the history
 *   canUndo, canRedo       whether there is a step to take
 *   clearHistory()         forget both directions (after a save)
 */
export default function useLayoutHistory() {
  const [layout, setLayoutState] = useState(null);
  const [depth, setDepth] = useState({ undo: 0, redo: 0 });
  const layoutRef = useRef(null); // the layout as last written
  const undoStackRef = useRef([]);
  const redoStackRef = useRef([]);

  const write = useCallback((next) => {
    layoutRef.current = next;
    setLayoutState(next);
    setDepth({ undo: undoStackRef.current.length, redo: redoStackRef.current.length });
  }, []);

  const setLayoutWithHistory = useCallback((updater) => {
    const prev = layoutRef.current;
    const next = typeof updater === 'function' ? updater(prev) : updater;
    if (next === prev) return;
    undoStackRef.current = [...undoStackRef.current.slice(-(MAX_UNDO - 1)), prev];
    redoStackRef.current = [];
    write(next);
  }, [write]);

  const undo = useCallback(() => {
    const stack = undoStackRef.current;
    if (stack.length === 0) return;
    redoStackRef.current = [...redoStackRef.current, layoutRef.current];
    undoStackRef.current = stack.slice(0, -1);
    write(stack[stack.length - 1]);
  }, [write]);

  const redo = useCallback(() => {
    const stack = redoStackRef.current;
    if (stack.length === 0) return;
    undoStackRef.current = [...undoStackRef.current, layoutRef.current];
    redoStackRef.current = stack.slice(0, -1);
    write(stack[stack.length - 1]);
  }, [write]);

  const clearHistory = useCallback(() => {
    undoStackRef.current = [];
    redoStackRef.current = [];
    setDepth({ undo: 0, redo: 0 });
  }, []);

  return {
    layout,
    setLayout: write,
    setLayoutWithHistory,
    undo,
    redo,
    canUndo: depth.undo > 0,
    canRedo: depth.redo > 0,
    clearHistory,
  };
}
