import { renderHook, act, waitFor } from '@testing-library/react';
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

  it('useCollapsedBlocks: starts from the account, saves every change as the whole list', async () => {
    auth.user = { preferences: { collapsedBlocks: ['vintage.reviews'] } };
    auth.updatePreferences = vi.fn().mockResolvedValue({ success: true });
    const { result } = renderHook(() => useCollapsedBlocks());
    expect(result.current.isCollapsed('vintage.reviews')).toBe(true);

    act(() => result.current.toggle('vintage.tasting'));
    expect(result.current.isCollapsed('vintage.tasting')).toBe(true);
    await waitFor(() => expect(auth.updatePreferences).toHaveBeenLastCalledWith({ collapsedBlocks: ['vintage.reviews', 'vintage.tasting'] }));

    // Two changes in one tick build on each other.
    act(() => { result.current.toggle('vintage.wine'); result.current.toggle('vintage.reviews'); });
    await waitFor(() => expect(auth.updatePreferences).toHaveBeenLastCalledWith({ collapsedBlocks: ['vintage.tasting', 'vintage.wine'] }));

    // expand unfolds only what is folded, and saves nothing when there is nothing to unfold.
    act(() => result.current.expand('vintage.wine', 'vintage.record'));
    expect(result.current.isCollapsed('vintage.wine')).toBe(false);
    await waitFor(() => expect(auth.updatePreferences).toHaveBeenLastCalledWith({ collapsedBlocks: ['vintage.tasting'] }));
    const calls = auth.updatePreferences.mock.calls.length;
    act(() => result.current.expand('vintage.record'));
    await act(async () => {});
    expect(auth.updatePreferences.mock.calls.length).toBe(calls);
  });

  // Release audit 2026-10-13: two quick changes could be saved out of order.
  it('saves one at a time, each sending the latest list, never the same list twice', async () => {
    auth.user = { preferences: {} };
    const answer = [];
    auth.updatePreferences = vi.fn(() => new Promise((resolve) => answer.push(resolve)));
    const { result } = renderHook(() => useCollapsedBlocks());

    act(() => result.current.toggle('vintage.wine'));
    await waitFor(() => expect(auth.updatePreferences).toHaveBeenCalledTimes(1));
    expect(auth.updatePreferences).toHaveBeenLastCalledWith({ collapsedBlocks: ['vintage.wine'] });

    // Two more changes while the first save is still on its way: nothing is sent yet.
    act(() => { result.current.toggle('vintage.tasting'); result.current.toggle('vintage.reviews'); });
    await act(async () => {});
    expect(auth.updatePreferences).toHaveBeenCalledTimes(1);

    // Once it answers, ONE save carries both changes.
    await act(async () => answer[0]({ success: true }));
    await waitFor(() => expect(auth.updatePreferences).toHaveBeenCalledTimes(2));
    expect(auth.updatePreferences).toHaveBeenLastCalledWith({ collapsedBlocks: ['vintage.wine', 'vintage.tasting', 'vintage.reviews'] });
    await act(async () => answer[1]({ success: true }));
    expect(auth.updatePreferences).toHaveBeenCalledTimes(2);
  });

  it('a save that fails does not stop the next one', async () => {
    auth.user = { preferences: {} };
    auth.updatePreferences = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ success: true });
    const { result } = renderHook(() => useCollapsedBlocks());
    act(() => result.current.toggle('vintage.wine'));
    await waitFor(() => expect(auth.updatePreferences).toHaveBeenCalledTimes(1));
    act(() => result.current.toggle('vintage.history'));
    await waitFor(() => expect(auth.updatePreferences).toHaveBeenCalledTimes(2));
    expect(auth.updatePreferences).toHaveBeenLastCalledWith({ collapsedBlocks: ['vintage.wine', 'vintage.history'] });
  });

  it('a failed save keeps the fold on the page', () => {
    auth.user = { preferences: {} };
    auth.updatePreferences = vi.fn().mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useCollapsedBlocks());
    act(() => result.current.toggle('vintage.bottles'));
    expect(result.current.isCollapsed('vintage.bottles')).toBe(true);
  });
});
