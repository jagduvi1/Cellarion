import { useTranslation } from 'react-i18next';
import { getMaturityPhases } from '../../utils/maturityUtils';
import { maturityBadgeText } from '../../utils/drinkStatus';
import './MaturityTimeline.css';

// How many years an open-ended last phase is drawn past this year (or past
// its own start), fading out: long enough to read as "goes on", short enough
// not to squeeze the closed phases.
const OPEN_TAIL_YEARS = 3;

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
 * marker sits in the middle of this year's cell.
 *
 * @returns {null | { segments: Array<{ cls, start, end, open, left, width }>, lo, hi, marker, firstYear, lastYear }}
 */
export function timelineModel(phases, year) {
  if (!Array.isArray(phases) || phases.length === 0) return null;
  const fin = (v) => (Number.isFinite(v) ? v : null);
  const segs = phases.map((p) => ({ cls: p.cls, start: fin(p.from), end: fin(p.until), open: false }));

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
    if (s.start === null) s.start = segs[i - 1].end + 1; // the one before was just given an end
    if (s.end === null) {
      if (next && next.start !== null) s.end = Math.max(s.start, next.start - 1);
      else if (next) s.end = s.start;
      else { s.end = Math.max(s.start, year) + OPEN_TAIL_YEARS; s.open = true; }
    }
    if (s.end < s.start) s.end = s.start;
  }

  const firstYear = segs[0].start;
  const lastYear = segs[segs.length - 1].end;
  const lo = Math.min(firstYear, year);
  const hi = Math.max(lastYear, year);
  const span = hi - lo + 1;
  const pct = (n) => (n / span) * 100;

  return {
    segments: segs.map((s) => ({ ...s, left: pct(s.start - lo), width: pct(s.end - s.start + 1) })),
    lo,
    hi,
    marker: pct(year - lo + 0.5),
    firstYear,
    lastYear: segs[segs.length - 1].open ? null : lastYear,
  };
}

// A label anchored at `left` % that never runs past either edge: shifting it
// back by the same percentage of its own width puts its left edge at 0 % and
// its right edge at 100 %.
const edgeSafe = (left) => ({ left: `${left}%`, transform: `translateX(-${left}%)` });

/**
 * A wine's drink window as one bar — its phases in their colours, with a
 * marker on this year — and the status (the same words as the badge it
 * replaces) above the marker. With `status` null (a personal window is set,
 * which takes precedence over the sommelier's status) the marker says only
 * the year. The phase table below keeps the exact years.
 */
function MaturityTimeline({ profile, anchorYear, status, year = new Date().getFullYear() }) {
  const { t } = useTranslation();
  const phases = getMaturityPhases(profile, {
    early: t('bottleDetail.maturityPhaseEarly'),
    peak:  t('bottleDetail.maturityPhasePeak'),
    late:  t('bottleDetail.maturityPhaseLate'),
  }, anchorYear);
  const model = timelineModel(phases, year);
  if (!model) return null;

  const statusCls = status?.status || 'pending';
  const label = status ? `${year} · ${maturityBadgeText(status, t)}` : String(year);

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
        <span className="mt-year" style={edgeSafe(model.segments[0].left)}>{model.firstYear}</span>
        {model.lastYear !== null && model.lastYear !== model.firstYear && (
          <span className="mt-year" style={edgeSafe(model.segments[model.segments.length - 1].left + model.segments[model.segments.length - 1].width)}>
            {model.lastYear}
          </span>
        )}
      </div>
    </div>
  );
}

export default MaturityTimeline;
