/**
 * Reservation helpers — the ONE definition of "reserved" that the suggestion
 * exclusions, the MCP consume guard, the search filters and the notifier all
 * share. If this predicate drifts, every surface drifts together, so pin it.
 */
const { isReserved, reservationLabel } = require('./reservationUtils');

describe('isReserved', () => {
  test('false for unreserved shapes: missing, null, empty and whitespace-only fields', () => {
    expect(isReserved(null)).toBe(false);
    expect(isReserved(undefined)).toBe(false);
    expect(isReserved({})).toBe(false);
    expect(isReserved({ reservedFor: null, reservedUntil: null })).toBe(false);
    expect(isReserved({ reservedFor: '', reservedUntil: undefined })).toBe(false);
    expect(isReserved({ reservedFor: '   ' })).toBe(false);
  });

  test('true when either field is set — including year 0-ish edge shapes', () => {
    expect(isReserved({ reservedFor: "Elias's 18th" })).toBe(true);
    expect(isReserved({ reservedUntil: 2034 })).toBe(true);
    expect(isReserved({ reservedFor: 'Anna', reservedUntil: 2030 })).toBe(true);
  });

  test('a non-string reservedFor never counts as reserved on its own', () => {
    // Defensive: lean docs from bad imports could carry odd types.
    expect(isReserved({ reservedFor: 42 })).toBe(false);
    expect(isReserved({ reservedFor: {} })).toBe(false);
  });
});

describe('reservationLabel', () => {
  test('empty for an unreserved bottle', () => {
    expect(reservationLabel({})).toBe('');
  });

  test('who + year, who only, year only', () => {
    expect(reservationLabel({ reservedFor: "Elias's 18th birthday", reservedUntil: 2034 }))
      .toBe("reserved for Elias's 18th birthday (until 2034)");
    expect(reservationLabel({ reservedFor: 'Anna' })).toBe('reserved for Anna');
    expect(reservationLabel({ reservedUntil: 2030 })).toBe('reserved until 2030');
  });
});
