import { useState, useEffect } from 'react';

const readInteger = (text) => (/^\s*-?\d+\s*$/.test(String(text)) ? parseInt(text, 10) : NaN);
// A min/max prop may be a number, a numeric string ("1"), or absent.
const readBound = (b, absent) => (b == null || b === '' || !Number.isFinite(Number(b)) ? absent : Number(b));

/**
 * A whole-number input that can be cleared and typed over.
 *
 * Why it keeps its own text: a field that parses every keystroke and falls
 * back to a default when the text is empty puts the default back the moment
 * it is cleared, and a phone keyboard has no arrows to step the number, so
 * the value could not be changed at all.
 *
 * The owner's state only ever receives an integer within [min, max], through
 * `onCommit`: on a keystroke that forms one; on a keystroke past `max` (more
 * digits can only make it larger), as `max`; and on blur, where a number out
 * of range is clamped and an empty or unreadable text puts the last committed
 * value back. A form submitted without a blur therefore never sends NaN or an
 * out-of-range number. Other props (className, style, aria-label, onFocus,
 * required…) go to the input.
 */
export default function IntegerField({ value, onCommit, min, max, onBlur, ...rest }) {
  const lo = readBound(min, -Infinity);
  const hi = readBound(max, Infinity);
  const [text, setText] = useState(value == null ? '' : String(value));

  // A value set from outside (another rack type's defaults, a preset) replaces
  // the text, unless the text already reads as that number.
  useEffect(() => {
    setText((prev) => (readInteger(prev) === Number(value) ? prev : (value == null ? '' : String(value))));
  }, [value]);

  const commit = (n) => { if (n !== Number(value)) onCommit(n); };

  return (
    <input
      type="number"
      inputMode="numeric"
      {...rest}
      min={min}
      max={max}
      value={text}
      onChange={(e) => {
        const next = e.target.value;
        const n = readInteger(next);
        if (Number.isInteger(n) && n > hi && hi >= 0) {
          setText(String(hi));
          commit(hi);
          return;
        }
        setText(next);
        if (Number.isInteger(n) && n >= lo && n <= hi) commit(n);
      }}
      onBlur={(e) => {
        const n = readInteger(e.target.value);
        if (Number.isInteger(n)) {
          const clamped = Math.min(hi, Math.max(lo, n));
          setText(String(clamped));
          commit(clamped);
        } else {
          setText(value == null ? '' : String(value));
        }
        if (onBlur) onBlur(e);
      }}
    />
  );
}
