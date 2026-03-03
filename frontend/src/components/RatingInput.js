import React from 'react';
import { SCALE_META, VALID_SCALES } from '../utils/ratingUtils';
import './RatingInput.css';

/**
 * RatingInput — reusable wine rating input supporting all three scales.
 *
 * Props:
 *   value            {number|string} — current rating value (raw, in `scale`)
 *   scale            {string}        — current scale: '5', '20', or '100'
 *   onChange         {fn(value)}     — called with new numeric value (or null)
 *   onScaleChange    {fn(scale)}     — called with new scale string
 *   allowScaleOverride {boolean}     — show the scale picker (default false)
 */
export default function RatingInput({ value, scale, onChange, onScaleChange, allowScaleOverride = false }) {
  const resolvedScale = VALID_SCALES.includes(scale) ? scale : '5';
  const meta = SCALE_META[resolvedScale];
  const numVal = value !== '' && value !== null && value !== undefined ? Number(value) : null;

  function handleChange(e) {
    const raw = e.target.value;
    if (raw === '') { onChange(null); return; }
    const n = parseFloat(raw);
    if (!isNaN(n)) onChange(n);
  }

  function handleScaleChange(e) {
    onScaleChange(e.target.value);
    onChange(null); // clear value when scale changes
  }

  // Build fractional star display for scale '5'
  const starFill = resolvedScale === '5' && numVal != null
    ? Math.max(0, Math.min(100, (numVal / 5) * 100))
    : null;

  return (
    <div className="rating-input">
      <div className="rating-input__controls">
        <input
          type="number"
          className="rating-input__number"
          min={meta.min}
          max={meta.max}
          step={meta.step}
          value={numVal != null ? numVal : ''}
          onChange={handleChange}
          placeholder={`${meta.min}–${meta.max}`}
        />
        {resolvedScale === '5' && (
          <div className="rating-stars-preview" aria-hidden="true">
            <span className="rating-stars-preview__bg">★★★★★</span>
            <span
              className="rating-stars-preview__fill"
              style={{ width: `${starFill ?? 0}%` }}
            >★★★★★</span>
          </div>
        )}
        <span className="rating-input__suffix">{meta.suffix}</span>
        {allowScaleOverride && (
          <select
            className="rating-input__scale-select"
            value={resolvedScale}
            onChange={handleScaleChange}
            title="Change rating scale"
          >
            {VALID_SCALES.map(s => (
              <option key={s} value={s}>{SCALE_META[s].label}</option>
            ))}
          </select>
        )}
      </div>
      <div className="rating-input__hint">
        {meta.label} · {meta.min}–{meta.max}
      </div>
    </div>
  );
}
