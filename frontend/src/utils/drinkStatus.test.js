import { toInputDate, getMaturityStatus, getPersonalWindowStatus, getBottleDrinkStatus } from './drinkStatus';

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

// ─── getMaturityStatus — relative (NV) profiles ──────────────────────────────

describe('getMaturityStatus — relative (NV) profiles', () => {
  const CURRENT_YEAR = new Date().getFullYear();

  // Offsets in years after the bottle's anchor: early 0–2, peak 2–4, late 4–6.
  const nvProfile = {
    status: 'reviewed',
    relative: true,
    earlyFrom: 0, earlyUntil: 2,
    peakFrom: 2, peakUntil: 4,
    lateFrom: 4, lateUntil: 6,
  };

  test('same NV profile classifies differently per bottle anchor (purchase) year', () => {
    expect(getMaturityStatus(nvProfile, CURRENT_YEAR).status).toBe('early');
    expect(getMaturityStatus(nvProfile, CURRENT_YEAR - 3).status).toBe('peak');
    expect(getMaturityStatus(nvProfile, CURRENT_YEAR - 7).status).toBe('declining');
  });
});

// ─── getPersonalWindowStatus — the bottle's OWN drinkFrom/drinkTo window ─────

describe('getPersonalWindowStatus', () => {
  const CURRENT_YEAR = new Date().getFullYear();

  test('returns null when neither drinkFrom nor drinkTo is set', () => {
    expect(getPersonalWindowStatus({})).toBeNull();
    expect(getPersonalWindowStatus({ drinkFrom: null, drinkTo: null })).toBeNull();
    expect(getPersonalWindowStatus(null)).toBeNull();
  });

  test('full window: not-ready / peak / declining', () => {
    expect(getPersonalWindowStatus({ drinkFrom: CURRENT_YEAR + 2, drinkTo: CURRENT_YEAR + 6 }).status).toBe('not-ready');
    expect(getPersonalWindowStatus({ drinkFrom: CURRENT_YEAR - 1, drinkTo: CURRENT_YEAR + 3 }).status).toBe('peak');
    expect(getPersonalWindowStatus({ drinkFrom: CURRENT_YEAR - 6, drinkTo: CURRENT_YEAR - 2 }).status).toBe('declining');
  });

  test('boundary years are inclusive', () => {
    expect(getPersonalWindowStatus({ drinkFrom: CURRENT_YEAR, drinkTo: CURRENT_YEAR }).status).toBe('peak');
  });

  // ── Optional personal peak ("drinkable ≠ peak") — MUST mirror the backend
  // classifyPersonalWindow (utils/maturityUtils): the two are documented as
  // never allowed to drift. Explicit currentYear for determinism.
  describe('with peakFrom/peakUntil', () => {
    const w = { drinkFrom: 2026, drinkTo: 2035, peakFrom: 2028, peakUntil: 2031 };

    test('five stages across the years', () => {
      expect(getPersonalWindowStatus(w, 2025).status).toBe('not-ready');
      expect(getPersonalWindowStatus(w, 2027).status).toBe('early');
      expect(getPersonalWindowStatus(w, 2030).status).toBe('peak');
      expect(getPersonalWindowStatus(w, 2033).status).toBe('late');
      expect(getPersonalWindowStatus(w, 2036).status).toBe('declining');
    });

    test('carries the peak bounds for display', () => {
      const s = getPersonalWindowStatus(w, 2027);
      expect(s.peakFrom).toBe(2028);
      expect(s.peakUntil).toBe(2031);
      expect(s.source).toBe('personal');
    });

    test('without peak fields the whole window stays peak', () => {
      expect(getPersonalWindowStatus({ drinkFrom: 2026, drinkTo: 2035 }, 2034).status).toBe('peak');
    });
  });

  test('only drinkFrom set: open-ended after the from year', () => {
    expect(getPersonalWindowStatus({ drinkFrom: CURRENT_YEAR + 3 }).status).toBe('not-ready');
    expect(getPersonalWindowStatus({ drinkFrom: CURRENT_YEAR - 3 }).status).toBe('peak');
  });

  test('only drinkTo set: drinkable now until the to year', () => {
    expect(getPersonalWindowStatus({ drinkTo: CURRENT_YEAR + 4 }).status).toBe('peak');
    expect(getPersonalWindowStatus({ drinkTo: CURRENT_YEAR - 1 }).status).toBe('declining');
  });

  test('tags the result as personal and echoes the window bounds', () => {
    const r = getPersonalWindowStatus({ drinkFrom: CURRENT_YEAR - 1, drinkTo: CURRENT_YEAR + 1 });
    expect(r.source).toBe('personal');
    expect(r.from).toBe(CURRENT_YEAR - 1);
    expect(r.to).toBe(CURRENT_YEAR + 1);
  });
});

// ─── getBottleDrinkStatus — personal window takes precedence over profile ────

describe('getBottleDrinkStatus', () => {
  const CURRENT_YEAR = new Date().getFullYear();

  // Profile that classifies as peak right now
  const peakProfile = {
    status: 'reviewed',
    peakFrom: CURRENT_YEAR - 2,
    peakUntil: CURRENT_YEAR + 3,
  };

  test('personal window overrides the profile window', () => {
    const bottle = { drinkFrom: CURRENT_YEAR + 2, drinkTo: CURRENT_YEAR + 6 };
    const r = getBottleDrinkStatus(bottle, peakProfile);
    expect(r.status).toBe('not-ready'); // profile alone would say peak
    expect(r.source).toBe('personal');
  });

  test('only-from personal window still overrides', () => {
    const bottle = { drinkFrom: CURRENT_YEAR + 1 };
    const r = getBottleDrinkStatus(bottle, peakProfile);
    expect(r.status).toBe('not-ready');
    expect(r.source).toBe('personal');
  });

  test('only-to personal window still overrides', () => {
    const bottle = { drinkTo: CURRENT_YEAR - 1 };
    const r = getBottleDrinkStatus(bottle, peakProfile);
    expect(r.status).toBe('declining'); // profile alone would say peak
    expect(r.source).toBe('personal');
  });

  test('no personal window → profile-based status, unchanged', () => {
    const r = getBottleDrinkStatus({}, peakProfile);
    expect(r.status).toBe('peak');
    expect(r.source).toBe('profile');
    expect(r.label).toBe(getMaturityStatus(peakProfile).label);
  });

  test('no personal window and no usable profile → null (unchanged behavior)', () => {
    expect(getBottleDrinkStatus({}, null)).toBeNull();
    expect(getBottleDrinkStatus({}, { status: 'pending', earlyFrom: 2020 })).toBeNull();
  });

  test('personal window works without any profile at all', () => {
    const r = getBottleDrinkStatus({ drinkFrom: CURRENT_YEAR - 1, drinkTo: CURRENT_YEAR + 1 }, null);
    expect(r.status).toBe('peak');
    expect(r.source).toBe('personal');
  });

  test('relative (NV) profile still resolved via anchor year when no personal window', () => {
    const nvProfile = { status: 'reviewed', relative: true, peakFrom: 2, peakUntil: 4 };
    expect(getBottleDrinkStatus({}, nvProfile, CURRENT_YEAR - 3).status).toBe('peak');
  });
});
