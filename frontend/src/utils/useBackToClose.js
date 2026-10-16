import { useEffect, useRef } from 'react';

// Back closes the open pop-up instead of leaving the page.
//
// In the Android app (and any browser) the Back button is history.back().
// No pop-up added a history entry, so Back with one open left the page —
// and a half-filled form with it (live walkthrough 2026-10-15). Each pop-up
// that can be closed now adds one entry for the SAME page while it is open:
// Back lands on the page itself, and the newest pop-up closes.
//
// The entry keeps the router's own state (usr/key/idx) and only adds a mark,
// so the router sees the same location. When pop-ups close any other way
// (Cancel, Escape, Save) their entries are taken off again, in one step, a
// tick later — while they are still the current entry. A pop-up that closed
// by opening another page leaves its entry under that page; Back from there
// skips it, and Forward onto an entry whose pop-up is gone steps off it again.
// (One case is left: a page reloaded with a pop-up open keeps that entry, and
// the first Back after it lands on the same page.)

const MARK = 'cellarionDialog';
const OWN_STEP_WINDOW_MS = 1000;
// Marks carry this page load's own prefix: an entry left by an earlier load
// (the page was reloaded with a pop-up open) is never taken for one of ours.
const LOAD = Math.random().toString(36).slice(2, 8);
// Our entries in history order, oldest first. Each sits above the entry of
// the page it was opened on (`at` = the router's index of that page), in the
// order it was pushed (`n`).
const stack = []; // { id, n, at, order, onCloseRef, open, mounted, closedByBack }
let seq = 0;
// First-render order of the pop-ups: a parent renders before its child, but
// their effects (which push the entries) run child first.
let renderSeq = 0;
// Entries pushed in this task (one commit's effects), in history order.
let batch = null;
let flushTimer = null;
// Our own history step in flight: its pop is ours, never the user's Back.
let ownStep = null; // { time, delta, removed: Set<id> }
// Entries we took off that may still be in the history (forward of where
// Back went, or under a page opened over them): landing on one steps off it.
const gone = new Set();
const forget = (ids) => {
  if (gone.size > 500) gone.clear();
  ids.forEach((id) => gone.add(id));
};
// While another history guard owns Back (the room's unsaved-changes prompt),
// pop-ups add no entries and Back is left to that guard.
let suspended = 0;

const historyState = () => window.history.state || {};
const pageIndex = () => {
  const { idx } = historyState();
  return Number.isInteger(idx) ? idx : null;
};
// Where the current entry is: [page index, our order above that page] — the
// page's own entry (or one left by an earlier load) is 0.
function position() {
  const mark = historyState()[MARK];
  const own = typeof mark === 'string' && mark.startsWith(`${LOAD}.`);
  return [pageIndex(), own ? Number(mark.slice(LOAD.length + 1)) : 0];
}
const isAbove = (e, [at, n]) => e.at > at || (e.at === at && e.n > n);

function step(delta, removedIds) {
  forget(removedIds);
  ownStep = { time: Date.now(), delta, removed: new Set(removedIds) };
  window.history.go(delta);
}

// The closed entries at the top, all on the top one's page: [count, ids].
function closedOnTop() {
  const top = stack[stack.length - 1];
  let k = 0;
  for (let i = stack.length - 1; i >= 0 && !stack[i].open && stack[i].at === top.at; i -= 1) k += 1;
  return stack.splice(stack.length - k, k).map((e) => e.id);
}

function scheduleFlush() {
  if (!flushTimer) flushTimer = setTimeout(flush, 0);
}

function pushEntry(entry) {
  const here = position();
  if (here[0] == null) return false;
  // Anything of ours above here is about to be cut off by this push.
  const cut = stack.findIndex((e) => isAbove(e, here));
  if (cut >= 0) stack.splice(cut);
  const n = ++seq;
  const id = `${LOAD}.${n}`;
  try {
    window.history.pushState({ ...historyState(), [MARK]: id }, '');
  } catch {
    return false;
  }
  Object.assign(entry, { id, n, at: here[0], open: true, closedByBack: false });
  stack.push(entry);
  // Pop-ups opened in the same commit (a form shown inside its picker from the
  // start): the entries were pushed child first, so hand the history slots out
  // again in render order — Back then closes the inner one first.
  if (!batch) {
    batch = [];
    queueMicrotask(() => { batch = null; });
  }
  batch.push(entry);
  if (batch.length > 1 && stack.slice(-batch.length).every((e, i) => e === batch[i])) {
    const slots = batch.map((e) => ({ id: e.id, n: e.n }));
    const byRender = [...batch].sort((a, b) => a.order - b.order);
    byRender.forEach((e, i) => Object.assign(e, slots[i]));
    stack.splice(stack.length - batch.length, batch.length, ...byRender);
    batch = byRender;
  }
  return true;
}

// The pop-up closes a task later: by then the router has taken this Back as
// what it is (the same page), so a close that opens another page is a plain
// push, not part of the Back. A pop-up with no close just now (busy saving)
// gets its entry straight back; one whose close did not close it (it asks
// first, say) gets it back once it is clear it stayed.
const STAYED_OPEN_MS = 500;
function closeByBack(e) {
  e.open = false;
  e.closedByBack = true;
  setTimeout(() => {
    const close = e.onCloseRef.current;
    if (!close) {
      if (e.mounted && e.closedByBack) pushEntry(e);
      return;
    }
    close();
    setTimeout(() => { if (e.mounted && e.closedByBack) pushEntry(e); }, STAYED_OPEN_MS);
  }, 0);
}

function onPopState() {
  if (suspended) return;
  const mark = historyState()[MARK];
  if (ownStep && Date.now() - ownStep.time < OWN_STEP_WINDOW_MS) {
    const { delta, removed } = ownStep;
    ownStep = null;
    // Our step back started from an entry the app pushed in the meantime (a
    // page opened just as a pop-up closed): go forward to it again.
    if (delta < 0 && removed.has(mark)) step(-delta, []);
    // Skipping down a run of entries whose pop-ups are gone: keep going.
    else if (delta < 0 && gone.has(mark)) step(-1, [mark]);
    return;
  }
  ownStep = null;

  const here = position();
  if (here[0] == null) return; // not an entry the router made: not ours to judge
  // Every entry of ours above where Back landed is gone: its pop-up closes
  // (normally just one — the newest).
  const first = stack.findIndex((e) => isAbove(e, here));
  const above = first < 0 ? [] : stack.splice(first);
  forget(above.map((e) => e.id));
  for (const e of above.reverse()) if (e.open) closeByBack(e);
  const top = stack[stack.length - 1];
  if (top && !top.open && top.id === mark) {
    // Landed on the entry of a pop-up that closed by opening another page:
    // skip it (and any closed under it) down to the page itself.
    const skipped = closedOnTop();
    step(-skipped.length, skipped);
  } else if (gone.has(mark)) {
    // An entry whose pop-up is gone (Forward onto it, or Back onto one left
    // under another page): step off it, onto what is under it.
    step(-1, [mark]);
  }
}

// Take off, in one step, the entries of pop-ups that closed another way — all
// the closed ones at the top (a form inside a picker closes with it).
function flush() {
  flushTimer = null;
  const top = stack[stack.length - 1];
  if (suspended || !top || top.open) return;
  // Only while the top one is still the current entry: once the app has
  // opened another page over it, Back skips these instead.
  if (historyState()[MARK] !== top.id) return;
  const removed = closedOnTop();
  step(-removed.length, removed);
}

// Listening from the start keeps this listener ahead of every page's own
// (the room's unsaved-changes guard relies on that order).
if (typeof window !== 'undefined') window.addEventListener('popstate', onPopState);

/**
 * Hand Back to another guard while it needs it (the room's unsaved-changes
 * prompt): pop-ups opened meanwhile add no entries, and Back is not acted on.
 * Returns the function that gives it back.
 */
export function suspendBackToClose() {
  suspended += 1;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    suspended -= 1;
    scheduleFlush(); // entries of pop-ups that closed meanwhile
  };
}

/**
 * Call in a pop-up component while it is open. `onClose` is what Back does
 * (usually the same as its Cancel/Escape); without one nothing is added —
 * a pop-up that must not be dismissed stays that way.
 */
export function useBackToClose(onClose, enabled = true) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // Once a pop-up could be closed, it keeps its entry while it is open: many
  // drop onClose while saving (`onClose={busy ? undefined : close}`), and Back
  // then must not leave the page — it does nothing until the save is done.
  const closableRef = useRef(false);
  if (typeof onClose === 'function') closableRef.current = true;
  const wanted = enabled && closableRef.current;
  const entryRef = useRef(null);
  const orderRef = useRef(0);
  if (!orderRef.current) orderRef.current = ++renderSeq;

  useEffect(() => {
    if (!wanted || suspended || typeof window === 'undefined' || !window.history?.pushState) return undefined;

    let entry = entryRef.current;
    if (entry && stack.includes(entry) && !entry.closedByBack) {
      // React's dev StrictMode unmounted and mounted again at once: the entry
      // pushed a moment ago is still there — keep it.
      entry.open = true;
      entry.mounted = true;
    } else {
      entry = { onCloseRef, mounted: true, order: orderRef.current };
      if (!pushEntry(entry)) return undefined;
      entryRef.current = entry;
    }

    return () => {
      entry.mounted = false;
      if (entry.closedByBack) return; // its entry is already gone
      entry.open = false;
      // A tick later: a StrictMode re-mount keeps it, a page opened in the
      // same handler has already moved past it, and pop-ups closing together
      // are taken off together.
      scheduleFlush();
    };
  }, [wanted]);
}

// Tests only: forget every entry and pending step, so one test's pop-ups (and
// jsdom's shared history) cannot reach into the next.
/**
 * The state for another entry of the SAME page (the room's unsaved-changes
 * guard): the router's own state (usr/key/idx) so later pages keep counting
 * from the right index, without a pop-up's mark, plus `extra`. A bare
 * `{ … }` made React Router count from NaN after a replace, which switched
 * Back-to-close off everywhere after (release audit 2026-10-16).
 */
export function pageEntryState(extra = {}) {
  const { [MARK]: _mark, ...routerState } = historyState();
  return { ...routerState, ...extra };
}

/**
 * Run `fn` once the current history entry is no longer a pop-up's own (one
 * that just closed is taken off a tick later): a navigation from a closing
 * pop-up's handler would otherwise replace or step from that entry, not the
 * page's (release audit 2026-10-16). Runs at once when there is none; gives
 * up waiting after `timeoutMs`.
 */
export function afterPopupEntryGone(fn, timeoutMs = 1500) {
  const start = Date.now();
  const own = () => {
    const mark = historyState()[MARK];
    return typeof mark === 'string' && mark.startsWith(`${LOAD}.`);
  };
  const check = () => {
    if (!own() || Date.now() - start > timeoutMs) { fn(); return; }
    setTimeout(check, 25);
  };
  check();
}

export function resetBackToCloseForTests() {
  stack.length = 0;
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  ownStep = null;
  suspended = 0;
  gone.clear();
  batch = null;
}
