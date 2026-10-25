/**
 * The word a "type X to confirm" prompt asks for, read from the instruction
 * itself: the <strong> part of the translated sentence. Reading it from there
 * keeps the instruction and the check from drifting apart — a translator who
 * renders DELETE as LÖSCHEN in the sentence gets LÖSCHEN accepted. Falls back
 * to `fallback` when the sentence has no <strong> part.
 */
export function confirmWordFrom(sentence, fallback) {
  const m = /<strong>([^<]+)<\/strong>/.exec(String(sentence || ''));
  const word = m ? m[1].trim() : '';
  return word || fallback;
}

/**
 * Whether `typed` is one of `words`, ignoring surrounding spaces and case.
 * The English word stays accepted next to the translated one, so a
 * translation that still says DELETE, or a user following an English guide,
 * is never stuck.
 */
export function matchesConfirmWord(typed, words) {
  const v = String(typed || '').trim().toLocaleUpperCase();
  return v !== '' && words.some((w) => w && v === String(w).trim().toLocaleUpperCase());
}
