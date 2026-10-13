import { renderHook, act } from '@testing-library/react';
import { COLLAPSIBLE_BLOCKS, storedCollapsed, toggledCollapsed, useCollapsedBlocks } from './collapsedBlocks';

const auth = { user: null, updatePreferences: vi.fn() };
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => auth }));

describe('collapsedBlocks', () => {
  it('storedCollapsed: the account\'s folded blocks, known names only', () => {
    expect(storedCollapsed({ preferences: { collapsedBlocks: ['vintage.reviews', 'gone.block'] } })).toEqual(['vintage.reviews']);
    expect(storedCollapsed({ preferences: {} })).toEqual([]);
    expect(storedCollapsed(null)).toEqual([]);
  });

  it('toggledCollapsed: folds and unfolds one block, ignores unknown names', () => {
    expect(toggledCollapsed([], 'vintage.wine')).toEqual(['vintage.wine']);
    expect(toggledCollapsed(['vintage.wine', 'vintage.tasting'], 'vintage.wine')).toEqual(['vintage.tasting']);
    expect(toggledCollapsed(['vintage.wine'], 'nope')).toEqual(['vintage.wine']);
  });

  it('mirrors the server\'s list of blocks', () => {
    expect(COLLAPSIBLE_BLOCKS).toHaveLength(8);
    expect(COLLAPSIBLE_BLOCKS.every((b) => b.startsWith('vintage.'))).toBe(true);
  });

  it('useCollapsedBlocks: starts from the account, saves every change as the whole list', () => {
    auth.user = { preferences: { collapsedBlocks: ['vintage.reviews'] } };
    auth.updatePreferences = vi.fn().mockResolvedValue({ success: true });
    const { result } = renderHook(() => useCollapsedBlocks());
    expect(result.current.isCollapsed('vintage.reviews')).toBe(true);

    act(() => result.current.toggle('vintage.tasting'));
    expect(result.current.isCollapsed('vintage.tasting')).toBe(true);
    expect(auth.updatePreferences).toHaveBeenLastCalledWith({ collapsedBlocks: ['vintage.reviews', 'vintage.tasting'] });

    // Two changes in one tick build on each other.
    act(() => { result.current.toggle('vintage.wine'); result.current.toggle('vintage.reviews'); });
    expect(auth.updatePreferences).toHaveBeenLastCalledWith({ collapsedBlocks: ['vintage.tasting', 'vintage.wine'] });

    // expand unfolds only what is folded, and saves nothing when there is nothing to unfold.
    act(() => result.current.expand('vintage.wine', 'vintage.record'));
    expect(result.current.isCollapsed('vintage.wine')).toBe(false);
    const calls = auth.updatePreferences.mock.calls.length;
    act(() => result.current.expand('vintage.record'));
    expect(auth.updatePreferences.mock.calls.length).toBe(calls);
  });

  it('a failed save keeps the fold on the page', () => {
    auth.user = { preferences: {} };
    auth.updatePreferences = vi.fn().mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useCollapsedBlocks());
    act(() => result.current.toggle('vintage.bottles'));
    expect(result.current.isCollapsed('vintage.bottles')).toBe(true);
  });
});
