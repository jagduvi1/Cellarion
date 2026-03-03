import React from 'react';
import { allScales, SCALE_META } from '../utils/ratingUtils';
import './RatingDisplay.css';

/**
 * RatingDisplay — shows a wine rating in all three scales.
 *
 * The original recorded value is shown prominently. All three scale
 * equivalents (Star, Davis 20-Point, Parker 100-Point) are shown inline.
 *
 * Props:
 *   value  {number} — raw rating value as stored
 *   scale  {string} — scale used when stored: '5', '20', or '100'
 */
export default function RatingDisplay({ value, scale }) {
  if (value == null || isNaN(value)) return <span className="rating-display rating-display--empty">—</span>;

  const resolvedScale = SCALE_META[scale] ? scale : '5';
  const scales = allScales(value, resolvedScale);
  if (!scales) return <span className="rating-display rating-display--empty">—</span>;

  const meta = SCALE_META[resolvedScale];
  const numVal = Number(value);
  const precision = meta.step < 1 ? 1 : 0;
  const originalFormatted = `${numVal.toFixed(precision)}${meta.suffix}`;

  // Star fill % for the original scale '5' star bar, or the converted star value
  const starNorm = scales.normalized;
  const starFill = Math.max(0, Math.min(100, starNorm));

  return (
    <span className="rating-display">
      <span className="rating-display__original" title={`Recorded as ${meta.label}`}>
        {resolvedScale === '5' && (
          <span className="rating-display__stars" aria-hidden="true">
            <span className="rating-display__stars-bg">★★★★★</span>
            <span className="rating-display__stars-fill" style={{ width: `${starFill}%` }}>★★★★★</span>
          </span>
        )}
        <span className="rating-display__value">{originalFormatted}</span>
      </span>
      <span className="rating-display__all-scales">
        {resolvedScale !== '5'   && <span title="Star Rating">{scales.star}</span>}
        {resolvedScale !== '20'  && <span title="Davis 20-Point">{scales.davis}</span>}
        {resolvedScale !== '100' && <span title="Parker 100-Point">{scales.parker}</span>}
      </span>
    </span>
  );
}
