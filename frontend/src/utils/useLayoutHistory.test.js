import { StrictMode } from 'react';
import { act, renderHook } from '@testing-library/react';
import useLayoutHistory from './useLayoutHistory';

// The app runs in StrictMode, where React calls a state updater twice.
const render = () => renderHook(() => useLayoutHistory(), { wrapper: StrictMode });

const START = { width: 4 };
const widen = (prev) => ({ ...prev, width: prev.width + 1 });

function loaded() {
  const hook = render();
  act(() => hook.result.current.setLayout(START));
  return hook;
}

describe('useLayoutHistory', () => {
  test('starts with no layout and nothing to undo or redo', () => {
    const { result } = render();
    expect(result.current.layout).toBeNull();
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);
  });

  test('setting a layout is not an edit: it records no step', () => {
    const { result } = loaded();
    expect(result.current.layout).toBe(START);
    expect(result.current.canUndo).toBe(false);
  });

  test('one edit records exactly one undo step under StrictMode', () => {
    const { result } = loaded();
    act(() => result.current.setLayoutWithHistory(widen));
    expect(result.current.layout).toEqual({ width: 5 });
    expect(result.current.canUndo).toBe(true);

    act(() => result.current.undo());
    expect(result.current.layout).toBe(START);
    expect(result.current.canUndo).toBe(false);
  });

  test('an edit that hands the same layout back records nothing', () => {
    const { result } = loaded();
    act(() => result.current.setLayoutWithHistory((prev) => prev));
    expect(result.current.layout).toBe(START);
    expect(result.current.canUndo).toBe(false);
  });

  test('an edit can be given as the next layout itself', () => {
    const { result } = loaded();
    act(() => result.current.setLayoutWithHistory({ width: 9 }));
    expect(result.current.layout).toEqual({ width: 9 });
    act(() => result.current.undo());
    expect(result.current.layout).toBe(START);
  });

  test('two edits in one tick each build on the one before', () => {
    const { result } = loaded();
    act(() => {
      result.current.setLayoutWithHistory(widen);
      result.current.setLayoutWithHistory(widen);
    });
    expect(result.current.layout).toEqual({ width: 6 });

    act(() => result.current.undo());
    expect(result.current.layout).toEqual({ width: 5 });
    act(() => result.current.undo());
    expect(result.current.layout).toBe(START);
    expect(result.current.canUndo).toBe(false);
  });

  test('redo puts an undone edit back, step by step', () => {
    const { result } = loaded();
    act(() => result.current.setLayoutWithHistory(widen));
    act(() => result.current.setLayoutWithHistory(widen));
    act(() => result.current.undo());
    act(() => result.current.undo());
    expect(result.current.canRedo).toBe(true);

    act(() => result.current.redo());
    expect(result.current.layout).toEqual({ width: 5 });
    act(() => result.current.redo());
    expect(result.current.layout).toEqual({ width: 6 });
    expect(result.current.canRedo).toBe(false);
    expect(result.current.canUndo).toBe(true);
  });

  test('a new edit after an undo drops what could have been redone', () => {
    const { result } = loaded();
    act(() => result.current.setLayoutWithHistory(widen));
    act(() => result.current.undo());
    act(() => result.current.setLayoutWithHistory({ width: 9 }));
    expect(result.current.canRedo).toBe(false);

    act(() => result.current.redo());
    expect(result.current.layout).toEqual({ width: 9 });
  });

  test('undo and redo with nothing to step to leave the layout alone', () => {
    const { result } = loaded();
    act(() => result.current.undo());
    act(() => result.current.redo());
    expect(result.current.layout).toBe(START);
  });

  test('keeps the last 50 edits', () => {
    const { result } = loaded();
    for (let i = 0; i < 60; i += 1) act(() => result.current.setLayoutWithHistory(widen));
    expect(result.current.layout).toEqual({ width: 64 });

    for (let i = 0; i < 60; i += 1) act(() => result.current.undo());
    expect(result.current.layout).toEqual({ width: 14 });
    expect(result.current.canUndo).toBe(false);
  });

  test('clearHistory forgets both directions and keeps the layout', () => {
    const { result } = loaded();
    act(() => result.current.setLayoutWithHistory(widen));
    act(() => result.current.setLayoutWithHistory(widen));
    act(() => result.current.undo());
    act(() => result.current.clearHistory());

    expect(result.current.layout).toEqual({ width: 5 });
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);
  });
});
