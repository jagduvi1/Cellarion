import { useCallback, useRef, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';

/**
 * The blocks of the wine and vintage page a member can fold away: its three
 * sections and the cards with a title of their own (beta feedback
 * 2026-10-12: "let the user minimise the stuff they don't want to see").
 * The bottle page folds the same cards under the same names (2026-10-14:
 * tasting, record, personal, history, reviews), so a card folded on one page
 * is folded on the other. Mirrors backend config/constants
 * COLLAPSIBLE_BLOCKS — the server refuses a name it doesn't know.
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

const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// The last folded list this tab committed, per account, with the account's
// list as the signed-in user carried it at that moment (`base`). The bottle
// and vintage pages share block names, so a page opened right after a fold on
// the other — before that save has come back into the signed-in user — must
// start from this tab's list: otherwise it shows the fold undone, and its next
// change saves the old list over the new one (audit 2026-10-14). Once the
// user carries something else (the save landed, or another device changed
// it), the user's list wins again.
let session = null; // { userId, list, base }

/** The list a page starts from: the account's, or this tab's newer one. */
function startingList(user) {
  const stored = storedCollapsed(user);
  const uid = user?.id;
  if (!uid || !session || session.userId !== uid) return stored;
  return sameList(stored, session.base) ? session.list : stored;
}

/** Test seam: forget this tab's list. */
export function __resetCollapsedSessionForTest() { session = null; }

/**
 * The page's folded blocks, a toggle and an unfold, both saved. Read from
 * the account when the page opens (or from this tab's newer list, above); a
 * change shows at once and is saved in the background (a failed save only
 * costs the memory, never the fold). Changes read the LATEST list (a ref), so
 * two quick ones never overwrite each other, and saves are queued, so they
 * reach the server in order.
 */
export function useCollapsedBlocks() {
  const { user, updatePreferences } = useAuth();
  const [collapsed, setCollapsed] = useState(() => startingList(user));
  const userRef = useRef(user);
  userRef.current = user;
  const latest = useRef(collapsed);
  // Saves go one at a time, each sending the list as it is when it starts:
  // two quick changes can never land on the server (or come back into the
  // signed-in user) in the wrong order (release audit 2026-10-13). A save
  // whose list an earlier one already sent is skipped.
  const saving = useRef(Promise.resolve());
  const sent = useRef(collapsed);
  const commit = useCallback((next) => {
    if (next === latest.current) return;
    latest.current = next;
    setCollapsed(next);
    const u = userRef.current;
    if (u?.id) session = { userId: u.id, list: next, base: storedCollapsed(u) };
    if (!updatePreferences) return;
    saving.current = saving.current
      .then(() => {
        const list = latest.current;
        if (list === sent.current) return undefined;
        sent.current = list;
        return updatePreferences({ collapsedBlocks: list });
      })
      .catch(() => {});
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
