/**
 * Shared JSON-extraction helpers.
 *
 * Both functions rely on the same brace-matching loop that handles
 * nested objects/arrays and quoted strings with escape sequences.
 */

/**
 * Walks the string tracking brace depth and calls `onClose` when the
 * first top-level `}` is found.  Returns whatever `onClose` produces,
 * or `fallback()` if no balanced object is found.
 */
function walkBraces(str, onClose, fallback) {
  let depth = 0, inStr = false, esc = false;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (esc)               { esc = false; continue; }
    if (c === '\\' && inStr) { esc = true; continue; }
    if (c === '"')           { inStr = !inStr; continue; }
    if (inStr)               continue;
    if (c === '{')           depth++;
    if (c === '}' && --depth === 0) return onClose(str, i);
  }
  return fallback(str);
}

/**
 * Extracts the first balanced {...} JSON object from a string.
 * Prevents trailing model commentary from breaking JSON.parse.
 */
function extractFirstJsonObject(str) {
  return walkBraces(
    str,
    (s, i) => s.slice(0, i + 1),
    (s) => s               // no balanced object — return as-is
  );
}

/**
 * Extracts any plain-text explanation the model appended after its
 * JSON object.  Models sometimes add "**Reason**: ..." or similar
 * after the closing brace.
 */
function extractAiExplanation(raw) {
  if (!raw) return null;
  return walkBraces(
    raw,
    (_s, i) => raw.slice(i + 1).replace(/^\s*\*{0,2}Reason\*{0,2}:?\s*/i, '').trim() || null,
    () => null
  );
}

module.exports = { extractFirstJsonObject, extractAiExplanation };
