import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getMaturityPhases, getPersonalWindowPhases } from '../../utils/maturityUtils';
import { personalWindowBadgeText, DRINK_YEAR_MIN, DRINK_YEAR_MAX } from '../../utils/drinkStatus';
import MaturityTimeline, { timelineModel } from './MaturityTimeline';
import DrinkWindowEditor from './DrinkWindowEditor';

// A window set with nothing to start from: this year and the five after it.
const DEFAULT_WINDOW_YEARS = 5;
// How far the vintage may pull the editing bar back before the window
// starts: far enough to move the start towards the vintage, not so far that
// an old wine's bar makes a year too thin to aim at.
const VINTAGE_REACH_YEARS = 10;

export const personalPhaseLabels = (t) => ({
  early: t('bottleDetail.maturityPhaseEarly'),
  peak:  t('bottleDetail.maturityPhasePeak'),
  late:  t('bottleDetail.maturityPhaseLate'),
  drink: t('bottleDetail.personalPhaseDrink', 'Ready to drink'),
});

const clampYear = (y) => Math.min(DRINK_YEAR_MAX, Math.max(DRINK_YEAR_MIN, y));
const lastEnd = (m) => (m ? m.segments[m.segments.length - 1].end : null);

/**
 * The window the handles start from, always closed (every handle needs a
 * year): the member's own as the timeline draws it (a missing start this
 * year, an open end where the bar fades out); else the sommelier's, from
 * where its first phase starts to where its last one ends, with its peak
 * when that lies inside; else this year and the five after.
 *
 * @returns {{ drinkFrom: number, peakFrom: number|null, peakUntil: number|null, drinkTo: number }}
 */
export function startingWindow(personalWindow, sommPhases, labels, year) {
  const own = !!personalWindow;
  const m = timelineModel(own ? getPersonalWindowPhases(personalWindow, labels, year) : sommPhases, year);
  if (!m) return { drinkFrom: year, peakFrom: null, peakUntil: null, drinkTo: year + DEFAULT_WINDOW_YEARS };
  const first = m.segments[0];
  const last = m.segments[m.segments.length - 1];
  const drinkFrom = clampYear(first.start);
  const drinkTo = Math.max(drinkFrom, clampYear(last.end));
  const peak = m.segments.find((s) => s.cls === 'peak');
  // A personal window without a peak is drawn as one peak-coloured phase,
  // so it is the stored peak years that say whether there is one.
  const hasPeak = own
    ? Number.isFinite(personalWindow.peakFrom) || Number.isFinite(personalWindow.peakUntil)
    : !!peak && (peak.start > first.start || peak.end < last.end);
  if (!hasPeak || !peak) return { drinkFrom, peakFrom: null, peakUntil: null, drinkTo };
  const peakFrom = Math.min(drinkTo, Math.max(drinkFrom, peak.start));
  const peakUntil = Math.min(drinkTo, Math.max(peakFrom, peak.end));
  return { drinkFrom, peakFrom, peakUntil, drinkTo };
}

/**
 * The years the editing bar spans, fixed for the whole edit so a handle never
 * shifts under the finger. From the year before the earlier of the window's
 * start and this year — pulled back towards the vintage by up to ten years —
 * to five years past the latest of the window's end, the sommelier's last
 * year and ten years from now: room to slide either way.
 */
export function editorAxis(win, { vintageYear, sommLastYear, year }) {
  const start = Math.min(win.drinkFrom, year);
  const back = Number.isFinite(vintageYear)
    ? Math.max(Math.min(vintageYear, start), start - VINTAGE_REACH_YEARS)
    : start;
  const hi = Math.max(...[win.drinkTo, sommLastYear, year + 10].filter(Number.isFinite)) + 5;
  return { lo: Math.max(DRINK_YEAR_MIN, back - 1), hi: Math.min(DRINK_YEAR_MAX, hi) };
}

/**
 * What an edit opens on: the window the handles start from, the years the
 * bar spans and, for the member's own window, which of its ends are open —
 * saved open again unless their handle is moved (the editor needs a year to
 * draw it at). `sommPhases` are the sommelier's reviewed phases, or none.
 */
export function editorStart({ personalWindow, sommPhases, vintageYear, labels, year }) {
  const initial = startingWindow(personalWindow, sommPhases, labels, year);
  const axis = editorAxis(initial, { vintageYear, sommLastYear: lastEnd(timelineModel(sommPhases, year)), year });
  const openSides = personalWindow
    ? { drinkFrom: !Number.isFinite(personalWindow.from), drinkTo: !Number.isFinite(personalWindow.to) }
    : null;
  return { initial, axis, openSides };
}

/**
 * "Your drink window" in early access: the member's own window as a timeline
 * (the sommelier's bar, with the personal status on the marker), and for
 * whoever may edit the bottle an "Adjust" that slides its years on the same
 * bar. Without a window of their own, an editor is offered one starting from
 * the sommelier's reviewed years, else from this year. `onSaved` gets the
 * four stored years.
 *
 * `inline` drops the section and its heading: the offer of a window then
 * sits inside the sommelier's section, under the window it starts from.
 * `focusAction` puts the keyboard on the action when it appears — the window
 * was just made or removed in the other place.
 */
function PersonalWindowTimeline({ bottle, personalWindow, vintageProfile, anchorYear, sommReviewed = false, canEdit = false, inline = false, focusAction = false, onSaved, year = new Date().getFullYear() }) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(null);
  const actionRef = useRef(null);
  const refocus = useRef(false);

  // Closing the editor hands the keyboard back to the button that opened it.
  useEffect(() => {
    if (editing || !refocus.current) return;
    refocus.current = false;
    actionRef.current?.focus();
  }, [editing]);
  useEffect(() => {
    if (focusAction) actionRef.current?.focus();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (!personalWindow && !editing && !canEdit) return null;
  const labels = personalPhaseLabels(t);

  const startEditing = () => {
    const sommPhases = sommReviewed && vintageProfile ? getMaturityPhases(vintageProfile, labels, anchorYear) : [];
    setEditing(editorStart({ personalWindow, sommPhases, vintageYear: parseInt(bottle.vintage, 10), labels, year }));
  };
  const stopEditing = () => {
    refocus.current = true;
    setEditing(null);
  };

  const body = editing ? (
    <DrinkWindowEditor
      bottleId={bottle._id}
      initial={editing.initial}
      axis={editing.axis}
      labels={labels}
      year={year}
      canRemove={!!personalWindow}
      openSides={editing.openSides}
      onCancel={stopEditing}
      onSaved={(win) => { onSaved?.(win); stopEditing(); }}
    />
  ) : personalWindow ? (
    <>
      <MaturityTimeline
        phases={getPersonalWindowPhases(personalWindow, labels, year)}
        status={personalWindow}
        statusLabel={personalWindowBadgeText(personalWindow, t)}
        year={year}
      />
      {canEdit && (
        <button
          ref={actionRef}
          type="button"
          className="bd-somm-notes-btn dwe-link"
          onClick={startEditing}
          aria-label={t('bottleDetail.windowAdjustLabel', 'Adjust your drink window')}
        >
          {t('bottleDetail.windowAdjust', 'Adjust')}
        </button>
      )}
    </>
  ) : (
    <button ref={actionRef} type="button" className="bd-somm-notes-btn dwe-link" onClick={startEditing}>
      {t('bottleDetail.windowSetOwn', 'Set your own window')}
    </button>
  );

  if (inline) return <div className="bd-own-window-offer" data-testid="personal-window-offer">{body}</div>;
  return (
    <div className="bd-section" data-testid="personal-window">
      <span className="bd-section-label">{t('bottleDetail.personalWindow')}</span>
      {body}
    </div>
  );
}

export default PersonalWindowTimeline;
