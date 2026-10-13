import { useCallback, useRef, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';

/**
 * The blocks of the wine and vintage page a member can fold away: its three
 * sections and the cards with a title of their own (beta feedback
 * 2026-10-12: "let the user minimise the stuff they don't want to see").
 * Mirrors backend config/constants COLLAPSIBLE_BLOCKS — the server refuses a
 * name it doesn't know.
 *
 * The folded set is remembered on the account (preferences.collapsedBlocks),
 * so a fold made on the phone is still there on the computer.
 */
export const COLLAPSIBLE_BLOCKS = [
  'vintage.wine', 'vintage.vintage', 'vintage.bottles',
  'vintage.tasting', 'vintage.record', 'vintage.personal', 'vintage.history', 'vintage.reviews',
];

/** The folded blocks stored on the account — known names only. */
export function storedCollapsed(user) {
  const list = user?.preferences?.collapsedBlocks;
  return Array.isArray(list) ? list.filter((b) => COLLAPSIBLE_BLOCKS.includes(b)) : [];
}

/** The folded list after folding or unfolding `id`. */
export function toggledCollapsed(list, id) {
  if (!COLLAPSIBLE_BLOCKS.includes(id)) return list;
  return list.includes(id) ? list.filter((b) => b !== id) : [...list, id];
}

/**
 * The page's folded blocks, a toggle and an unfold, both saved. Read from
 * the account once, when the page opens; a change shows at once and is saved
 * in the background (a failed save only costs the memory, never the fold).
 * Changes read the LATEST list (a ref), so two quick ones never overwrite
 * each other.
 */
export function useCollapsedBlocks() {
  const { user, updatePreferences } = useAuth();
  const [collapsed, setCollapsed] = useState(() => storedCollapsed(user));
  const latest = useRef(collapsed);
  const commit = useCallback((next) => {
    if (next === latest.current) return;
    latest.current = next;
    setCollapsed(next);
    if (updatePreferences) Promise.resolve(updatePreferences({ collapsedBlocks: next })).catch(() => {});
  }, [updatePreferences]);
  const isCollapsed = useCallback((id) => collapsed.includes(id), [collapsed]);
  const toggle = useCallback((id) => commit(toggledCollapsed(latest.current, id)), [commit]);
  // Unfold blocks something on the page needs open (e.g. "Suggest a fix"
  // opening the wine record's form).
  const expand = useCallback((...ids) => {
    const next = latest.current.filter((b) => !ids.includes(b));
    if (next.length !== latest.current.length) commit(next);
  }, [commit]);
  return { isCollapsed, toggle, expand };
}
