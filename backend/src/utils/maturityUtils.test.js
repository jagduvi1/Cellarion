jest.mock('../models/WineVintageProfile', () => ({}));

const { classifyMaturity, maturityLabel } = require('./maturityUtils');

// Fix the system clock to 2026 for all tests
beforeAll(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-06-15T00:00:00Z'));
});

afterAll(() => {
  jest.useRealTimers();
});

// ─── classifyMaturity ────────────────────────────────────────────────────────

describe('classifyMaturity', () => {
  const wdId = 'abc123';

  function makeBottle(vintage) {
    return { wineDefinition: { _id: wdId }, vintage };
  }

  function makeProfileMap(overrides = {}) {
    const defaults = {
      status: 'reviewed',
      earlyFrom: 2024,
      earlyUntil: 2026,
      peakFrom: 2027,
      peakUntil: 2032,
      lateFrom: 2033,
      lateUntil: 2036,
    };
    const profile = { ...defaults, ...overrides };
    const map = new Map();
    map.set(`${wdId}:${profile._vintage || 2020}`, profile);
    return map;
  }

  function makeMap(vintage, profile) {
    const map = new Map();
    map.set(`${wdId}:${vintage}`, profile);
    return map;
  }

  test('returns null for NV vintage', () => {
    const bottle = makeBottle('NV');
    const map = makeMap('NV', { status: 'reviewed', earlyFrom: 2020 });
    expect(classifyMaturity(bottle, map)).toBeNull();
  });

  test('returns null for missing vintage', () => {
    const bottle = makeBottle(null);
    expect(classifyMaturity(bottle, new Map())).toBeNull();
  });

  test('returns null for missing wineDefinition', () => {
    const bottle = { wineDefinition: null, vintage: 2020 };
    expect(classifyMaturity(bottle, new Map())).toBeNull();
  });

  test('returns null for unreviewed profile', () => {
    const bottle = makeBottle(2020);
    const map = makeMap(2020, { status: 'pending', earlyFrom: 2024 });
    expect(classifyMaturity(bottle, map)).toBeNull();
  });

  test('returns null when no profile exists in map', () => {
    const bottle = makeBottle(2020);
    expect(classifyMaturity(bottle, new Map())).toBeNull();
  });

  test('returns null when earlyFrom is missing', () => {
    const bottle = makeBottle(2020);
    const map = makeMap(2020, { status: 'reviewed', earlyFrom: null });
    expect(classifyMaturity(bottle, map)).toBeNull();
  });

  test('returns "not-ready" when currentYear < earlyFrom', () => {
    // currentYear=2026, earlyFrom=2028
    const bottle = makeBottle(2020);
    const map = makeMap(2020, {
      status: 'reviewed',
      earlyFrom: 2028, earlyUntil: 2030,
      peakFrom: 2031, peakUntil: 2035,
      lateFrom: 2036, lateUntil: 2040,
    });
    expect(classifyMaturity(bottle, map)).toBe('not-ready');
  });

  test('returns "early" when in early window (earlyUntil check)', () => {
    // currentYear=2026, earlyFrom=2024, earlyUntil=2027
    const bottle = makeBottle(2020);
    const map = makeMap(2020, {
      status: 'reviewed',
      earlyFrom: 2024, earlyUntil: 2027,
      peakFrom: 2028, peakUntil: 2032,
      lateFrom: 2033, lateUntil: 2036,
    });
    expect(classifyMaturity(bottle, map)).toBe('early');
  });

  test('returns "early" when before peakFrom but after earlyUntil', () => {
    // currentYear=2026, earlyFrom=2023, earlyUntil=2025, peakFrom=2028
    const bottle = makeBottle(2020);
    const map = makeMap(2020, {
      status: 'reviewed',
      earlyFrom: 2023, earlyUntil: 2025,
      peakFrom: 2028, peakUntil: 2032,
      lateFrom: 2033, lateUntil: 2036,
    });
    expect(classifyMaturity(bottle, map)).toBe('early');
  });

  test('returns "peak" when in peak window', () => {
    // currentYear=2026, peakFrom=2025, peakUntil=2030
    const bottle = makeBottle(2020);
    const map = makeMap(2020, {
      status: 'reviewed',
      earlyFrom: 2022, earlyUntil: 2024,
      peakFrom: 2025, peakUntil: 2030,
      lateFrom: 2031, lateUntil: 2035,
    });
    expect(classifyMaturity(bottle, map)).toBe('peak');
  });

  test('returns "peak" when before lateFrom but after peakUntil', () => {
    // currentYear=2026, peakFrom=2024, peakUntil=2025, lateFrom=2028
    const bottle = makeBottle(2020);
    const map = makeMap(2020, {
      status: 'reviewed',
      earlyFrom: 2020, earlyUntil: 2023,
      peakFrom: 2024, peakUntil: 2025,
      lateFrom: 2028, lateUntil: 2032,
    });
    expect(classifyMaturity(bottle, map)).toBe('peak');
  });

  test('returns "late" when in late window', () => {
    // currentYear=2026, lateFrom=2025, lateUntil=2028
    const bottle = makeBottle(2020);
    const map = makeMap(2020, {
      status: 'reviewed',
      earlyFrom: 2018, earlyUntil: 2020,
      peakFrom: 2021, peakUntil: 2024,
      lateFrom: 2025, lateUntil: 2028,
    });
    expect(classifyMaturity(bottle, map)).toBe('late');
  });

  test('returns "declining" when past lateUntil', () => {
    // currentYear=2026, lateUntil=2024
    const bottle = makeBottle(2020);
    const map = makeMap(2020, {
      status: 'reviewed',
      earlyFrom: 2015, earlyUntil: 2017,
      peakFrom: 2018, peakUntil: 2021,
      lateFrom: 2022, lateUntil: 2024,
    });
    expect(classifyMaturity(bottle, map)).toBe('declining');
  });

  test('returns "declining" when past peakUntil and no lateFrom', () => {
    // currentYear=2026, peakUntil=2024, no late window defined
    const bottle = makeBottle(2020);
    const map = makeMap(2020, {
      status: 'reviewed',
      earlyFrom: 2015, earlyUntil: 2018,
      peakFrom: 2019, peakUntil: 2024,
    });
    expect(classifyMaturity(bottle, map)).toBe('declining');
  });

  test('handles wineDefinition as plain string ID', () => {
    const bottle = { wineDefinition: wdId, vintage: 2020 };
    const map = makeMap(2020, {
      status: 'reviewed',
      earlyFrom: 2028, earlyUntil: 2030,
      peakFrom: 2031, peakUntil: 2035,
      lateFrom: 2036, lateUntil: 2040,
    });
    // wineDefinition is a string — toString() called on it
    // The code does: bottle.wineDefinition?._id?.toString() || bottle.wineDefinition?.toString()
    expect(classifyMaturity(bottle, map)).toBe('not-ready');
  });

  test('returns "peak" when currentYear >= peakFrom and no other window matches', () => {
    // currentYear=2026, earlyFrom=2020, no earlyUntil/peakUntil/late windows
    // Only earlyFrom and peakFrom are set
    const bottle = makeBottle(2020);
    const map = makeMap(2020, {
      status: 'reviewed',
      earlyFrom: 2020,
      peakFrom: 2025,
    });
    expect(classifyMaturity(bottle, map)).toBe('peak');
  });
});

// ─── maturityLabel ───────────────────────────────────────────────────────────

describe('maturityLabel', () => {
  test('returns null for null status', () => {
    expect(maturityLabel(null)).toBeNull();
  });

  test('returns null for undefined status', () => {
    expect(maturityLabel(undefined)).toBeNull();
  });

  test('returns correct string for "not-ready"', () => {
    const profile = { earlyFrom: 2028 };
    const label = maturityLabel('not-ready', profile);
    expect(label).toBe('Not ready yet — early drinking from 2028');
  });

  test('returns correct string for "not-ready" with missing earlyFrom', () => {
    const label = maturityLabel('not-ready', {});
    expect(label).toBe('Not ready yet — early drinking from ?');
  });

  test('returns correct string for "early" with peakFrom', () => {
    const profile = { peakFrom: 2030 };
    const label = maturityLabel('early', profile);
    expect(label).toBe('Early drinking — peak from 2030');
  });

  test('returns correct string for "early" without peakFrom', () => {
    const label = maturityLabel('early', {});
    expect(label).toBe('Early drinking window');
  });

  test('returns correct string for "peak" with peakUntil', () => {
    const profile = { peakUntil: 2032 };
    const label = maturityLabel('peak', profile);
    expect(label).toBe('At peak — drink now through 2032');
  });

  test('returns correct string for "peak" without peakUntil', () => {
    const label = maturityLabel('peak', {});
    expect(label).toBe('At peak maturity — drink now');
  });

  test('returns correct string for "late" with lateUntil', () => {
    const profile = { lateUntil: 2036 };
    const label = maturityLabel('late', profile);
    expect(label).toBe('Late maturity — drink soon, until 2036');
  });

  test('returns correct string for "late" without lateUntil', () => {
    const label = maturityLabel('late', {});
    expect(label).toBe('Late maturity — drink soon');
  });

  test('returns correct string for "declining"', () => {
    const label = maturityLabel('declining', {});
    expect(label).toBe('Past peak — declining, drink immediately if at all');
  });

  test('returns null for unknown status', () => {
    expect(maturityLabel('unknown-status', {})).toBeNull();
  });

  test('returns null for empty string status', () => {
    // Empty string is falsy so the !status guard returns null
    expect(maturityLabel('', {})).toBeNull();
  });

  test('handles null profile gracefully', () => {
    // Uses optional chaining: profile?.earlyFrom
    const label = maturityLabel('not-ready', null);
    expect(label).toBe('Not ready yet — early drinking from ?');
  });
});
