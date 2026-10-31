import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../contexts/AuthContext';
import { updateBottle } from '../../api/bottles';
import { getPersonalWindowPhases } from '../../utils/maturityUtils';
import { validateDrinkWindowFields } from '../../utils/drinkStatus';
import { timelineModel } from './MaturityTimeline';
import BetaBadge from '../BetaBadge';
import './DrinkWindowEditor.css';

// The four boundaries in their order on the bar.
const HANDLES = ['drinkFrom', 'peakFrom', 'peakUntil', 'drinkTo'];
// A start handle sits on the left edge of its year, an end handle on the
// right edge, so a one-year window or peak still has a width to see.
const IS_END = { drinkFrom: false, peakFrom: false, peakUntil: true, drinkTo: true };
// The other handle in the same row: the window's ends above the bar, the
// peak's below it.
const ROW_PARTNER = { drinkFrom: 'drinkTo', drinkTo: 'drinkFrom', peakFrom: 'peakUntil', peakUntil: 'peakFrom' };
// A handle's width in px (DrinkWindowEditor.css): two handles closer than
// this cover each other.
const HANDLE_PX = 32;
const KEY_STEP = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1, PageDown: -5, PageUp: 5 };

/**
 * The years a handle may take: up to its neighbours (drinkFrom ≤ peakFrom ≤
 * peakUntil ≤ drinkTo, the order the server enforces) and, for the window's
 * ends, the ends of the axis.
 */
export function handleLimits(win, key, axis) {
  const hasPeak = win.peakFrom != null;
  switch (key) {
    case 'drinkFrom': return [axis.lo, hasPeak ? win.peakFrom : win.drinkTo];
    case 'peakFrom':  return [win.drinkFrom, win.peakUntil];
    case 'peakUntil': return [win.peakFrom, win.drinkTo];
    default:          return [hasPeak ? win.peakUntil : win.drinkFrom, axis.hi];
  }
}

/** A new peak: the middle third of the window (all of it when it is shorter than three years). */
export function middleThird(from, to) {
  const third = Math.floor((to - from + 1) / 3);
  return { peakFrom: from + third, peakUntil: to - third };
}

const windowOf = (b) => ({
  drinkFrom: b?.drinkFrom ?? null,
  peakFrom:  b?.peakFrom ?? null,
  peakUntil: b?.peakUntil ?? null,
  drinkTo:   b?.drinkTo ?? null,
});

/**
 * The member's own drink window on the timeline's bar, with a handle on each
 * boundary to slide in whole years. Saves the same four fields the classic
 * edit form writes; `onSaved` gets them as the server stored them.
 *
 * `initial` is a closed window ({ drinkFrom, peakFrom, peakUntil, drinkTo },
 * the peak null when there is none) and `axis` ({ lo, hi }) the years the bar
 * spans, both fixed by the caller for the whole edit.
 *
 * `save` writes the four fields somewhere else than the one bottle (the
 * vintage page: every bottle of the vintage at once). It gets them and
 * answers { ok, error?, stored? }, `stored` being the years as kept.
 */
function DrinkWindowEditor({ bottleId, initial, axis, labels, year, canRemove = false, openSides = null, save: saveFields = null, intro = null, saveLabel = null, onSaved, onCancel }) {
  const { t } = useTranslation();
  const { apiFetch } = useAuth();
  const [win, setWin] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const hintId = useId();
  const axisRef = useRef(null);
  const handleRefs = useRef({});
  const drag = useRef(null);
  // The handles the member has moved: an end the stored window leaves open
  // is drawn somewhere to have a handle, and stays open unless it was moved.
  const moved = useRef(new Set());
  const hasPeak = win.peakFrom != null;

  // Opening the editor puts the keyboard on its first handle.
  useEffect(() => { handleRefs.current.drinkFrom?.focus(); }, []);

  const span = axis.hi - axis.lo + 1;
  const posOf = (key) => ((win[key] - axis.lo + (IS_END[key] ? 1 : 0)) / span) * 100;

  const setYear = (key, value) => setWin((w) => {
    const [min, max] = handleLimits(w, key, axis);
    const v = Math.min(max, Math.max(min, value));
    if (v === w[key]) return w;
    moved.current.add(key);
    return { ...w, [key]: v };
  });

  const onKeyDown = (key) => (e) => {
    if (saving) return;
    const [min, max] = handleLimits(win, key, axis);
    let next;
    if (KEY_STEP[e.key]) next = win[key] + KEY_STEP[e.key];
    else if (e.key === 'Home') next = min;
    else if (e.key === 'End') next = max;
    else return;
    e.preventDefault();
    setYear(key, next);
  };

  const yearAt = (key, clientX) => {
    const rect = axisRef.current?.getBoundingClientRect();
    if (!rect || !rect.width) return null;
    const cell = Math.round(((clientX - rect.left) / rect.width) * span);
    return axis.lo + cell - (IS_END[key] ? 1 : 0);
  };

  const onPointerDown = (key) => (e) => {
    if (e.button > 0 || saving) return;
    e.preventDefault();
    e.currentTarget.focus();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* no capture: moves still arrive while over the handle */ }
    // A press where the two handles of a row are drawn over each other: the
    // first move decides which one is dragged, so neither is ever stuck
    // under the other.
    const rect = axisRef.current?.getBoundingClientRect();
    const partner = ROW_PARTNER[key];
    const covered = !!rect?.width && win[partner] != null
      && Math.abs(e.clientX - (rect.left + (posOf(partner) / 100) * rect.width)) < HANDLE_PX / 2;
    drag.current = { key, pointerId: e.pointerId, x: e.clientX, undecided: covered };
  };

  const onPointerMove = (e) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    // A mouse released outside the handle never sent its pointerup here:
    // with no button held the drag is over, not a hover that moves things.
    if (e.pointerType === 'mouse' && e.buttons === 0) { drag.current = null; return; }
    if (d.undecided) {
      if (Math.abs(e.clientX - d.x) < 3) return;
      const startKey = IS_END[d.key] ? ROW_PARTNER[d.key] : d.key;
      d.key = e.clientX < d.x ? startKey : ROW_PARTNER[startKey];
      d.undecided = false;
      handleRefs.current[d.key]?.focus();
    }
    const y = yearAt(d.key, e.clientX);
    if (y !== null) setYear(d.key, y);
  };

  const endDrag = (e) => {
    if (drag.current?.pointerId === e.pointerId) drag.current = null;
  };

  const togglePeak = () => setWin((w) => (w.peakFrom != null
    ? { ...w, peakFrom: null, peakUntil: null }
    : { ...w, ...middleThird(w.drinkFrom, w.drinkTo) }));

  const failed = t('bottleDetail.windowSaveFailed', 'Could not save your window. Please try again.');
  const store = saveFields || (async (next) => {
    const res = await updateBottle(apiFetch, bottleId, next);
    const data = await res.json().catch(() => ({}));
    return res.ok ? { ok: true, stored: data.bottle } : { ok: false, error: data.error };
  });
  const save = async (next) => {
    const invalid = validateDrinkWindowFields(next, t);
    if (invalid) { setError(invalid); return; }
    setSaving(true);
    setError(null);
    try {
      const result = await store(next);
      if (!result?.ok) {
        setError(result?.error || failed);
        setSaving(false);
        return;
      }
      onSaved(windowOf(result.stored || next));
    } catch {
      setError(failed);
      setSaving(false);
    }
  };

  const keepOpenEnds = (w) => {
    const out = { ...w };
    for (const k of ['drinkFrom', 'drinkTo']) if (openSides?.[k] && !moved.current.has(k)) out[k] = null;
    return out;
  };

  const onEditorKeyDown = (e) => {
    // Escape in a dialog opened from inside the editor (the Beta feedback)
    // closes that dialog, not the editor.
    if (e.key === 'Escape' && !saving && !e.target.closest?.('[role="dialog"]')) { e.stopPropagation(); onCancel(); }
  };

  const names = {
    drinkFrom: t('bottleDetail.windowHandleDrinkFrom', 'Drink from'),
    peakFrom:  t('bottleDetail.windowHandlePeakFrom', 'Peak from'),
    peakUntil: t('bottleDetail.windowHandlePeakUntil', 'Peak until'),
    drinkTo:   t('bottleDetail.windowHandleDrinkTo', 'Drink until'),
  };
  const valueText = (key, y) => {
    switch (key) {
      case 'drinkFrom': return t('bottleDetail.windowHandleDrinkFromValue', { year: y, defaultValue: 'Drink from {{year}}' });
      case 'peakFrom':  return t('bottleDetail.windowHandlePeakFromValue', { year: y, defaultValue: 'Peak from {{year}}' });
      case 'peakUntil': return t('bottleDetail.windowHandlePeakUntilValue', { year: y, defaultValue: 'Peak until {{year}}' });
      default:          return t('bottleDetail.windowHandleDrinkToValue', { year: y, defaultValue: 'Drink until {{year}}' });
    }
  };

  const model = timelineModel(getPersonalWindowPhases(
    { from: win.drinkFrom, to: win.drinkTo, peakFrom: win.peakFrom, peakUntil: win.peakUntil }, labels, year,
  ), year, axis);

  return (
    <div className="dwe" onKeyDown={onEditorKeyDown}>
      <BetaBadge feature="maturityTimeline" note={t('bottleDetail.windowAdjustBeta', 'Sliding your own drink window is in early access.')} />
      {intro && <p className="dwe-hint">{intro}</p>}
      <p id={hintId} className="dwe-hint">{t('bottleDetail.windowAdjustHint', 'Drag a handle, or use the arrow keys, one year at a time.')}</p>
      <div className="dwe-axis-wrap">
        <div className="dwe-axis" ref={axisRef}>
          <div className="mt-track dwe-track" aria-hidden="true">
            {model.segments.map((s) => (
              <span key={s.cls} className={`mt-seg mt-seg--${s.cls}`} style={{ left: `${s.left}%`, width: `${s.width}%` }} />
            ))}
            <span className="mt-marker" style={{ left: `${model.marker}%` }} />
          </div>
          {HANDLES.filter((k) => win[k] != null).map((k) => {
            const [min, max] = handleLimits(win, k, axis);
            const pos = posOf(k);
            // The year reads away from the inside of its range, so a row's
            // two years never cover each other; near an end of the bar it
            // turns inward to stay on the card.
            const outward = IS_END[k] ? 'right' : 'left';
            const nearEdge = IS_END[k] ? pos > 88 : pos < 12;
            const side = nearEdge ? (outward === 'right' ? 'left' : 'right') : outward;
            const row = k === 'drinkFrom' || k === 'drinkTo' ? 'window' : 'peak';
            return (
              <span
                key={k}
                ref={(el) => { handleRefs.current[k] = el; }}
                role="slider"
                tabIndex={0}
                aria-label={names[k]}
                aria-describedby={hintId}
                aria-orientation="horizontal"
                aria-valuemin={min}
                aria-valuemax={max}
                aria-valuenow={win[k]}
                aria-valuetext={valueText(k, win[k])}
                aria-disabled={saving || undefined}
                className={`dwe-handle dwe-handle--${row}`}
                style={{ left: `${pos}%` }}
                onKeyDown={onKeyDown(k)}
                onPointerDown={onPointerDown(k)}
                onPointerMove={onPointerMove}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
                onLostPointerCapture={endDrag}
              >
                <span className="dwe-knob" />
                <span className={`dwe-year dwe-year--${side}`}>{win[k]}</span>
              </span>
            );
          })}
        </div>
      </div>
      <div className="mt-legend" aria-hidden="true">
        {model.segments.map((s) => (
          <span key={s.cls} className="mt-legend-item">
            <span className={`mt-legend-dot mt-legend-dot--${s.cls}`} />
            {s.label}
          </span>
        ))}
      </div>
      <div className="dwe-tools">
        <button type="button" className="bd-somm-notes-btn dwe-link" onClick={togglePeak} disabled={saving}>
          {hasPeak
            ? t('bottleDetail.windowRemovePeak', 'Remove peak')
            : t('bottleDetail.windowMarkPeak', 'Mark a peak')}
        </button>
        {canRemove && (
          <button type="button" className="bd-somm-notes-btn dwe-link dwe-link--danger" onClick={() => save(windowOf(null))} disabled={saving}>
            {t('bottleDetail.windowRemoveMine', 'Remove my window')}
          </button>
        )}
      </div>
      {error && <div className="alert alert-error dwe-error" role="alert">{error}</div>}
      <div className="dwe-actions">
        <button type="button" className="btn btn-secondary btn-small" onClick={onCancel} disabled={saving}>
          {t('common.cancel', 'Cancel')}
        </button>
        <button type="button" className="btn btn-primary btn-small" onClick={() => save(keepOpenEnds(windowOf(win)))} disabled={saving}>
          {saving ? t('common.saving', 'Saving…') : (saveLabel || t('common.save', 'Save'))}
        </button>
      </div>
    </div>
  );
}

export default DrinkWindowEditor;
