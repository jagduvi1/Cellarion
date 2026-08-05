import { isReserved, reservationSummary } from './reservation';

// t stub: returns the key with interpolations appended, so assertions can pin
// BOTH which key was chosen and which values were passed.
const t = (key, vars) => `${key}${vars ? ':' + Object.values(vars).join(',') : ''}`;

// ─── isReserved ──────────────────────────────────────────────────────────────

describe('isReserved', () => {
  test('false for unreserved shapes: missing, null, empty, whitespace-only', () => {
    expect(isReserved(null)).toBe(false);
    expect(isReserved(undefined)).toBe(false);
    expect(isReserved({})).toBe(false);
    expect(isReserved({ reservedFor: null, reservedUntil: null })).toBe(false);
    expect(isReserved({ reservedFor: '', reservedUntil: undefined })).toBe(false);
    expect(isReserved({ reservedFor: '   ' })).toBe(false);
  });

  test('true when either field is set', () => {
    expect(isReserved({ reservedFor: "Elias's 18th" })).toBe(true);
    expect(isReserved({ reservedUntil: 2034 })).toBe(true);
    expect(isReserved({ reservedFor: 'Anna', reservedUntil: 2030 })).toBe(true);
  });
});

// ─── reservationSummary ──────────────────────────────────────────────────────

describe('reservationSummary', () => {
  test('empty string when unreserved (no translation lookup)', () => {
    expect(reservationSummary({}, t)).toBe('');
  });

  test('picks the who+year, who-only and year-only keys with the right values', () => {
    expect(reservationSummary({ reservedFor: 'Elias', reservedUntil: 2034 }, t))
      .toBe('bottleDetail.reservedForUntil:Elias,2034');
    expect(reservationSummary({ reservedFor: 'Anna' }, t))
      .toBe('bottleDetail.reservedForOnly:Anna');
    expect(reservationSummary({ reservedUntil: 2030 }, t))
      .toBe('bottleDetail.reservedUntilOnly:2030');
  });

  test('trims the who text before rendering', () => {
    expect(reservationSummary({ reservedFor: '  Anna  ' }, t))
      .toBe('bottleDetail.reservedForOnly:Anna');
  });
});
