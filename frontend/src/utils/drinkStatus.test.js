import {
  getDrinkStatus,
  getGroupWorstStatus,
  formatDrinkDate,
  toInputDate,
  toMonthInput,
  monthToLastDay,
} from './drinkStatus';

// Helper: build an ISO date string relative to today
function daysFromNow(n) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + n);
  return d.toISOString();
}

// ─── getDrinkStatus ───────────────────────────────────────────────────────────

describe('getDrinkStatus', () => {
  test('returns null when neither date is set', () => {
    expect(getDrinkStatus({ drinkFrom: null, drinkBefore: null })).toBeNull();
    expect(getDrinkStatus({})).toBeNull();
  });

  test('overdue when drinkBefore is in the past', () => {
    const result = getDrinkStatus({ drinkBefore: daysFromNow(-10) });
    expect(result.status).toBe('overdue');
    expect(result.daysLeft).toBe(-10);
    expect(result.label).toContain('overdue');
  });

  test('soon when drinkBefore is within 90 days', () => {
    const result = getDrinkStatus({ drinkBefore: daysFromNow(30) });
    expect(result.status).toBe('soon');
    expect(result.daysLeft).toBe(30);
  });

  test('soon at exactly 90 days (boundary)', () => {
    const result = getDrinkStatus({ drinkBefore: daysFromNow(90) });
    expect(result.status).toBe('soon');
  });

  test('inWindow when drinkBefore is beyond 90 days and no drinkFrom constraint', () => {
    const result = getDrinkStatus({ drinkBefore: daysFromNow(200) });
    expect(result.status).toBe('inWindow');
    expect(result.daysLeft).toBe(200);
  });

  test('notReady when drinkFrom is in the future', () => {
    const result = getDrinkStatus({ drinkFrom: daysFromNow(100) });
    expect(result.status).toBe('notReady');
    expect(result.label).toContain('Ready in');
  });

  test('inWindow when only drinkFrom is set and it is in the past', () => {
    const result = getDrinkStatus({ drinkFrom: daysFromNow(-30) });
    expect(result.status).toBe('inWindow');
    expect(result.daysLeft).toBeNull();
  });

  test('overdue takes priority over notReady when drinkBefore is past', () => {
    // drinkBefore already passed — should be overdue regardless of drinkFrom
    const result = getDrinkStatus({
      drinkFrom: daysFromNow(-100),
      drinkBefore: daysFromNow(-5),
    });
    expect(result.status).toBe('overdue');
  });

  test('notReady when drinkFrom is future even with a far drinkBefore', () => {
    const result = getDrinkStatus({
      drinkFrom: daysFromNow(50),
      drinkBefore: daysFromNow(300),
    });
    expect(result.status).toBe('notReady');
  });
});

// ─── getGroupWorstStatus ──────────────────────────────────────────────────────

describe('getGroupWorstStatus', () => {
  test('returns null for empty array', () => {
    expect(getGroupWorstStatus([])).toBeNull();
  });

  test('returns null when all bottles have no dates', () => {
    expect(getGroupWorstStatus([{}, {}])).toBeNull();
  });

  test('overdue beats all other statuses', () => {
    const bottles = [
      { drinkBefore: daysFromNow(30) },   // soon
      { drinkBefore: daysFromNow(-5) },   // overdue
      { drinkFrom: daysFromNow(100) },    // notReady
    ];
    expect(getGroupWorstStatus(bottles).status).toBe('overdue');
  });

  test('soon beats inWindow and notReady', () => {
    const bottles = [
      { drinkFrom: daysFromNow(-10) },    // inWindow
      { drinkBefore: daysFromNow(45) },   // soon
      { drinkFrom: daysFromNow(200) },    // notReady
    ];
    expect(getGroupWorstStatus(bottles).status).toBe('soon');
  });

  test('inWindow beats notReady', () => {
    const bottles = [
      { drinkFrom: daysFromNow(-5) },     // inWindow
      { drinkFrom: daysFromNow(200) },    // notReady
    ];
    expect(getGroupWorstStatus(bottles).status).toBe('inWindow');
  });
});

// ─── formatDrinkDate ──────────────────────────────────────────────────────────

describe('formatDrinkDate', () => {
  test('returns empty string for falsy input', () => {
    expect(formatDrinkDate('')).toBe('');
    expect(formatDrinkDate(null)).toBe('');
    expect(formatDrinkDate(undefined)).toBe('');
  });

  test('formats to short month + year (no day)', () => {
    const result = formatDrinkDate('2027-03-15T00:00:00.000Z');
    expect(result).toMatch(/Mar/);
    expect(result).toMatch(/2027/);
    // Day number must NOT appear
    expect(result).not.toMatch(/15/);
  });
});

// ─── toInputDate ─────────────────────────────────────────────────────────────

describe('toInputDate', () => {
  test('returns empty string for falsy input', () => {
    expect(toInputDate('')).toBe('');
    expect(toInputDate(null)).toBe('');
  });

  test('returns yyyy-mm-dd format', () => {
    expect(toInputDate('2025-06-15T00:00:00.000Z')).toBe('2025-06-15');
  });
});

// ─── toMonthInput ─────────────────────────────────────────────────────────────

describe('toMonthInput', () => {
  test('returns empty string for falsy input', () => {
    expect(toMonthInput('')).toBe('');
    expect(toMonthInput(null)).toBe('');
  });

  test('returns yyyy-mm format (7 chars)', () => {
    const result = toMonthInput('2025-06-15T00:00:00.000Z');
    expect(result).toBe('2025-06');
    expect(result).toHaveLength(7);
  });
});

// ─── monthToLastDay ───────────────────────────────────────────────────────────

describe('monthToLastDay', () => {
  test('returns null for falsy input', () => {
    expect(monthToLastDay('')).toBeNull();
    expect(monthToLastDay(null)).toBeNull();
  });

  test('March (31 days)', () => {
    expect(monthToLastDay('2025-03')).toBe('2025-03-31');
  });

  test('April (30 days)', () => {
    expect(monthToLastDay('2025-04')).toBe('2025-04-30');
  });

  test('February non-leap year (28 days)', () => {
    expect(monthToLastDay('2025-02')).toBe('2025-02-28');
  });

  test('February leap year (29 days)', () => {
    expect(monthToLastDay('2024-02')).toBe('2024-02-29');
  });

  test('December (31 days)', () => {
    expect(monthToLastDay('2025-12')).toBe('2025-12-31');
  });
});
