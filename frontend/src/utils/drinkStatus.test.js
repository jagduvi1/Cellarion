import { toInputDate, getMaturityStatus } from './drinkStatus';

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

// ─── getMaturityStatus ───────────────────────────────────────────────────────

describe('getMaturityStatus', () => {
  const CURRENT_YEAR = new Date().getFullYear();

  test('returns null for null or undefined profile', () => {
    expect(getMaturityStatus(null)).toBeNull();
    expect(getMaturityStatus(undefined)).toBeNull();
  });

  test('returns null for non-reviewed profile', () => {
    expect(getMaturityStatus({ status: 'pending', earlyFrom: 2020 })).toBeNull();
  });

  test('returns null when no window boundaries are set', () => {
    expect(getMaturityStatus({ status: 'reviewed' })).toBeNull();
  });

  test('peak-only: returns not-ready when current year is before peakFrom', () => {
    const result = getMaturityStatus({
      status: 'reviewed',
      peakFrom: CURRENT_YEAR + 2,
      peakUntil: CURRENT_YEAR + 5,
    });
    expect(result.status).toBe('not-ready');
  });

  test('peak-only: returns peak when in peak window', () => {
    const result = getMaturityStatus({
      status: 'reviewed',
      peakFrom: CURRENT_YEAR - 1,
      peakUntil: CURRENT_YEAR + 3,
    });
    expect(result.status).toBe('peak');
  });

  test('peak-only: returns declining when past peakUntil', () => {
    const result = getMaturityStatus({
      status: 'reviewed',
      peakFrom: CURRENT_YEAR - 5,
      peakUntil: CURRENT_YEAR - 2,
    });
    expect(result.status).toBe('declining');
  });

  test('returns not-ready when current year is before earlyFrom', () => {
    const result = getMaturityStatus({
      status: 'reviewed',
      earlyFrom: CURRENT_YEAR + 5,
      earlyUntil: CURRENT_YEAR + 8,
      peakFrom: CURRENT_YEAR + 8,
      peakUntil: CURRENT_YEAR + 15,
    });
    expect(result.status).toBe('not-ready');
  });

  test('returns early when current year is within early phase', () => {
    const result = getMaturityStatus({
      status: 'reviewed',
      earlyFrom: CURRENT_YEAR - 2,
      earlyUntil: CURRENT_YEAR + 2,
      peakFrom: CURRENT_YEAR + 3,
      peakUntil: CURRENT_YEAR + 10,
    });
    expect(result.status).toBe('early');
  });

  test('returns peak when current year is within peak phase', () => {
    const result = getMaturityStatus({
      status: 'reviewed',
      earlyFrom: CURRENT_YEAR - 10,
      earlyUntil: CURRENT_YEAR - 5,
      peakFrom: CURRENT_YEAR - 3,
      peakUntil: CURRENT_YEAR + 3,
    });
    expect(result.status).toBe('peak');
  });

  test('returns late when current year is within late phase', () => {
    const result = getMaturityStatus({
      status: 'reviewed',
      earlyFrom: CURRENT_YEAR - 15,
      earlyUntil: CURRENT_YEAR - 10,
      peakFrom: CURRENT_YEAR - 8,
      peakUntil: CURRENT_YEAR - 3,
      lateFrom: CURRENT_YEAR - 2,
      lateUntil: CURRENT_YEAR + 2,
    });
    expect(result.status).toBe('late');
  });

  test('returns declining when past all phases', () => {
    const result = getMaturityStatus({
      status: 'reviewed',
      earlyFrom: CURRENT_YEAR - 20,
      earlyUntil: CURRENT_YEAR - 15,
      peakFrom: CURRENT_YEAR - 12,
      peakUntil: CURRENT_YEAR - 5,
      lateFrom: CURRENT_YEAR - 4,
      lateUntil: CURRENT_YEAR - 1,
    });
    expect(result.status).toBe('declining');
  });
});
