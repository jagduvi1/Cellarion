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
// (Cancel, Escape, Save) their entries are taken off again in one step — but
// only while they are still the current ones: a pop-up that closes by
// navigating elsewhere leaves its entry behind the new page, where Back
// simply shows the page it was on.

const MARK = 'cellarionDialog';
// The entries we pushed, oldest first, mirroring the top of the history.
const stack = []; // { id, onCloseRef, open, closedByBack }
let seq = 0;
let listening = false;
let flushTimer = null;
// When we ourselves step back to take closed pop-ups' entries off: that pop is
// ours, not the user's Back (it could otherwise close a pop-up that opened in
// between). Skipped once, and only for a moment — a stale mark must never
// swallow a real Back.
let ownBackAt = 0;
const OWN_BACK_WINDOW_MS = 1000;

const currentMark = () => (window.history.state ? window.history.state[MARK] : undefined);

// A pop arrived. Every entry of ours above the one we landed on is now gone
// from the user's point of view: its pop-up closes (normally just one).
function onPopState() {
  if (ownBackAt && Date.now() - ownBackAt < OWN_BACK_WINDOW_MS) { ownBackAt = 0; return; }
  ownBackAt = 0;
  const mark = currentMark();
  const landed = mark ? stack.findIndex((e) => e.id === mark) : -1;
  const above = stack.splice(landed + 1);
  for (const e of above.reverse()) {
    if (!e.open) continue;
    e.open = false;
    e.closedByBack = true;
    if (e.onCloseRef.current) e.onCloseRef.current();
  }
}

// Take off, in one step, the entries of pop-ups that closed another way —
// all the closed ones at the top (a form inside a picker closes with it).
function flush() {
  flushTimer = null;
  let n = 0;
  for (let i = stack.length - 1; i >= 0 && !stack[i].open; i -= 1) n += 1;
  if (!n) return;
  const top = stack[stack.length - 1];
  stack.splice(stack.length - n, n);
  if (currentMark() === top.id) {
    ownBackAt = Date.now();
    window.history.go(-n);
  }
  // Otherwise the app has moved on (a navigation in the same handler): the
  // entries stay behind the new page, where Back just shows that page.
}

function listen() {
  if (listening) return;
  window.addEventListener('popstate', onPopState);
  listening = true;
}

/**
 * Call in a pop-up component while it is open. `onClose` is what Back does
 * (usually the same as its Cancel/Escape); without one nothing is added —
 * a pop-up that must not be dismissed stays that way.
 */
export function useBackToClose(onClose, enabled = true) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const hasClose = typeof onClose === 'function';
  const entryRef = useRef(null);

  useEffect(() => {
    if (!enabled || !hasClose || typeof window === 'undefined' || !window.history?.pushState) return undefined;

    let entry = entryRef.current;
    if (entry && stack.includes(entry) && !entry.closedByBack) {
      // React's dev StrictMode unmounted and mounted again at once: the entry
      // pushed a moment ago is still there — keep it.
      entry.open = true;
    } else {
      entry = { id: `d${++seq}`, onCloseRef, open: true, closedByBack: false };
      try {
        window.history.pushState({ ...(window.history.state || {}), [MARK]: entry.id }, '');
      } catch {
        return undefined;
      }
      stack.push(entry);
      entryRef.current = entry;
    }
    listen();

    return () => {
      if (entry.closedByBack) return; // its entry is already gone
      entry.open = false;
      // A tick later: a StrictMode re-mount keeps it, a navigation made in the
      // same handler has already moved past it, and pop-ups closing together
      // are taken off together.
      if (!flushTimer) flushTimer = setTimeout(flush, 0);
    };
  }, [enabled, hasClose]);
}

// Tests only: forget every entry and pending removal, so one test's pop-ups
// (and jsdom's shared history) cannot reach into the next.
export function resetBackToCloseForTests() {
  stack.length = 0;
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  ownBackAt = 0;
}
