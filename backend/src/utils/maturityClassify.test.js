/**
 * utils/maturityClassify — the phase of a drink window in a given year. The
 * bottle classifier's own suite (utils/maturityUtils.test.js) pins what a
 * bottle reads; this file pins the reading itself, including the cases where
 * a simpler reading gives a different answer.
 */
const { windowPhase } = require('./maturityClassify');

const Y = 2030;

test.each([
  ['before the first year', { earlyFrom: 2032, peakFrom: 2035 }, 'not-ready'],
  ['before a peak with no early phase', { peakFrom: 2032, peakUntil: 2040 }, 'not-ready'],
  ['in the early phase', { earlyFrom: 2028, earlyUntil: 2031, peakFrom: 2032 }, 'early'],
  ['between early and peak', { earlyFrom: 2026, earlyUntil: 2028, peakFrom: 2032 }, 'early'],
  ['at peak', { peakFrom: 2028, peakUntil: 2033 }, 'peak'],
  ['in the late phase', { peakFrom: 2020, peakUntil: 2027, lateFrom: 2028, lateUntil: 2034 }, 'late'],
  ['past a window with a late end', { peakFrom: 2015, peakUntil: 2020, lateFrom: 2021, lateUntil: 2026 }, 'declining'],
  ['past a peak with no late phase', { peakFrom: 2015, peakUntil: 2025 }, 'declining'],
  ['a peak with no end, once begun', { peakFrom: 2025 }, 'peak'],
])('%s', (_label, window, phase) => {
  expect(windowPhase(window, Y)).toBe(phase);
});

// The readings a shorter rule gets wrong.
test.each([
  ['an early phase still open, the peak without a start', { earlyFrom: 2028, earlyUntil: 2031, peakUntil: 2036 }, 'early'],
  ['early and peak overlapping: the early phase runs to its end', { earlyFrom: 2027, earlyUntil: 2030, peakFrom: 2029, peakUntil: 2035 }, 'early'],
  ['the gap between peak and late belongs to the peak', { peakFrom: 2024, peakUntil: 2028, lateFrom: 2032, lateUntil: 2036 }, 'peak'],
  ['a late phase with no end stays late', { peakFrom: 2020, peakUntil: 2025, lateFrom: 2026 }, 'late'],
  ['an early phase alone, once begun', { earlyFrom: 2029 }, 'early'],
])('%s', (_label, window, phase) => {
  expect(windowPhase(window, Y)).toBe(phase);
});

test('a window with no early or peak boundary cannot be read', () => {
  expect(windowPhase({ lateFrom: 2028, lateUntil: 2034 }, Y)).toBeNull();
  expect(windowPhase({}, Y)).toBeNull();
  expect(windowPhase(null, Y)).toBeNull();
});

test('the year defaults to this year', () => {
  const now = new Date().getFullYear();
  expect(windowPhase({ peakFrom: now - 1, peakUntil: now + 1 })).toBe('peak');
});
