import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getMaturityPhases } from '../../utils/maturityUtils';
import { maturityBadgeText } from '../../utils/drinkStatus';
import './MaturityTimeline.css';

// How many years an open-ended last phase is drawn past this year (or past
// its own start), fading out: long enough to read as "goes on", short enough
// not to squeeze the closed phases.
const OPEN_TAIL_YEARS = 3;

// The least distance, in percent of the bar, between two year labels under
// it. A four-digit year is about a tenth of the bar on a phone, so a label
// closer than this to the one before is left out (the details list keeps it).
const MIN_TICK_GAP = 12;

/**
 * Lay the phases (getMaturityPhases: end to end, display-adjusted) out on one
 * axis of whole years. A phase missing a start begins the year after the one
 * before it (the first one: this year, at the latest its end); a phase missing
 * an end runs to the year before the next one starts, and the last one is
 * drawn open, fading out. Gaps between phases stay empty. The axis always
 * holds this year, so a wine not ready yet has its marker before the bar and
 * a wine past its window has it after.
 *
 * Positions are percentages of the axis; a year occupies one cell and the
 * marker sits in the middle of this year's cell. `ticks` are the years
 * printed under the bar: where each phase starts, where one ends before a
 * gap, and where a closed window ends, minus any that would run into the
 * label before them (the window's last year outranks a boundary in the
 * middle; the first year always stays).
 *
 * `axis` ({ lo, hi }) fixes the axis instead, for a bar whose years must not
 * move while handles are dragged along it; it has to hold every phase.
 *
 * @returns {null | { segments: Array<{ cls, label, start, end, open, left, width }>, ticks: Array<{ year, pos }>, lo, hi, marker, firstYear, lastYear }}
 */
export function timelineModel(phases, year, axis = null) {
  if (!Array.isArray(phases) || phases.length === 0) return null;
  const fin = (v) => (Number.isFinite(v) ? v : null);
  const segs = phases.map((p) => ({ cls: p.cls, label: p.label, start: fin(p.from), end: fin(p.until), open: false }));

  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const prev = segs[i - 1];
    if (s.start === null) {
      if (prev && prev.end !== null) s.start = prev.end + 1;
      else if (!prev && s.end !== null) s.start = Math.min(s.end, year);
    }
  }
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const next = segs[i + 1];
    if (s.start === null) s.start = i > 0 ? segs[i - 1].end + 1 : year; // the one before was just given an end
    if (s.end === null) {
      if (next && next.start !== null) s.end = Math.max(s.start, next.start - 1);
      else if (next) s.end = s.start;
      else { s.end = Math.max(s.start, year) + OPEN_TAIL_YEARS; s.open = true; }
    }
    if (s.end < s.start) s.end = s.start;
  }

  const firstYear = segs[0].start;
  const lastYear = segs[segs.length - 1].end;
  const lo = axis ? axis.lo : Math.min(firstYear, year);
  const hi = axis ? axis.hi : Math.max(lastYear, year);
  const span = hi - lo + 1;
  const pct = (n) => (n / span) * 100;
  const segments = segs.map((s) => ({ ...s, left: pct(s.start - lo), width: pct(s.end - s.start + 1) }));

  const candidates = [];
  segments.forEach((s, i) => {
    candidates.push({ year: s.start, pos: s.left });
    // A gap follows: print where this phase ends too, or the reader cannot
    // tell from the bar alone.
    const next = segments[i + 1];
    if (next && next.start > s.end + 1) candidates.push({ year: s.end, pos: s.left + s.width });
  });
  const last = segments[segments.length - 1];
  if (!last.open) candidates.push({ year: last.end, pos: last.left + last.width, end: true });
  const ticks = [];
  for (const c of candidates) {
    const prev = ticks[ticks.length - 1];
    if (prev && c.year === prev.year) continue;
    if (prev && c.pos - prev.pos < MIN_TICK_GAP) {
      if (c.end && ticks.length > 1) ticks[ticks.length - 1] = { year: c.year, pos: c.pos };
      continue;
    }
    ticks.push({ year: c.year, pos: c.pos });
  }

  return {
    segments,
    ticks,
    lo,
    hi,
    marker: pct(year - lo + 0.5),
    firstYear,
    lastYear: last.open ? null : lastYear,
  };
}

// A label anchored at `left` % that never runs past either edge: shifting it
// back by the same percentage of its own width puts its left edge at 0 % and
// its right edge at 100 %.
const edgeSafe = (left) => ({ left: `${left}%`, transform: `translateX(-${left}%)` });

// A phase's years in words — the same wording as the phase table.
function phaseRange(p, t) {
  if (p.from && p.until) return p.from === p.until ? `${p.from}` : `${p.from}–${p.until}`;
  if (p.from) return t('bottleDetail.maturityPhaseFrom', { year: p.from, defaultValue: 'from {{year}}' });
  return t('bottleDetail.maturityPhaseUntil', { year: p.until, defaultValue: 'until {{year}}' });
}

/**
 * A wine's drink window as one bar — its phases in their colours, the year
 * each one starts under it, and a marker on this year carrying the status
 * (the same words as the badge it replaces). With `status` null (a personal
 * window is set, which takes precedence over the sommelier's status) the
 * marker says only the year. `details` (the phase table) folds away behind a
 * toggle: the bar already carries the years.
 *
 * The phases come from the sommelier's `profile`, or ready-made in `phases`
 * (the member's own window: getPersonalWindowPhases) with `statusLabel` as
 * the marker's words, since a personal status has wording of its own.
 */
function MaturityTimeline({ profile, anchorYear, phases: givenPhases = null, status, statusLabel = null, details = null, year = new Date().getFullYear() }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const phases = givenPhases || getMaturityPhases(profile, {
    early: t('bottleDetail.maturityPhaseEarly'),
    peak:  t('bottleDetail.maturityPhasePeak'),
    late:  t('bottleDetail.maturityPhaseLate'),
  }, anchorYear);
  const model = timelineModel(phases, year);
  if (!model) return null;

  const statusCls = status?.status || 'pending';
  const label = status ? `${year} · ${statusLabel ?? maturityBadgeText(status, t)}` : String(year);

  return (
    <div className="mt-timeline" data-testid="maturity-timeline">
      <div className="mt-now-row">
        <span className={`maturity-badge maturity-badge--${statusCls} mt-now-label`} style={edgeSafe(model.marker)}>
          {label}
        </span>
      </div>
      <div className="mt-track" aria-hidden="true">
        {model.segments.map((s) => (
          <span
            key={s.cls}
            className={`mt-seg mt-seg--${s.cls}${s.open ? ' mt-seg--open' : ''}`}
            style={{ left: `${s.left}%`, width: `${s.width}%` }}
          />
        ))}
        <span className={`mt-marker mt-marker--${statusCls}`} style={{ left: `${model.marker}%` }} />
      </div>
      <div className="mt-years" aria-hidden="true">
        {model.ticks.map((tk) => (
          <span key={tk.year} className="mt-year" style={edgeSafe(tk.pos)}>{tk.year}</span>
        ))}
      </div>
      <div className="mt-legend" aria-hidden="true">
        {model.segments.map((s) => (
          <span key={s.cls} className="mt-legend-item">
            <span className={`mt-legend-dot mt-legend-dot--${s.cls}`} />
            {s.label}
          </span>
        ))}
      </div>
      {/* What the bar shows, for a screen reader: the phases with their years
          (not while the details are open: the table says the same). */}
      {(!details || !open) && (
        <span className="mt-sr-only">
          {phases.map((p) => `${p.label} ${phaseRange(p, t)}`).join(', ')}
        </span>
      )}
      {details && (
        <>
          <button
            type="button"
            className="bd-somm-notes-btn mt-details-toggle"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-controls={detailsId}
          >
            {open
              ? t('bottleDetail.maturityHideDetails', 'Hide details')
              : t('bottleDetail.maturityShowDetails', 'Show details')}
            <span className={`bd-somm-notes-chevron${open ? ' bd-somm-notes-chevron--open' : ''}`} aria-hidden="true">&rsaquo;</span>
          </button>
          <div id={detailsId} className="mt-details" hidden={!open}>
            {details}
          </div>
        </>
      )}
    </div>
  );
}

export default MaturityTimeline;
