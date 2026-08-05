jest.mock('../models/WineVintageProfile', () => ({ find: jest.fn() }));

const WineVintageProfile = require('../models/WineVintageProfile');
const {
  classifyMaturity, classifyPersonalWindow, maturityLabel,
  buildProfileMap, bottleAnchorYear, resolveWindow,
} = require('./maturityUtils');

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

  test('NV vintage with a reviewed absolute-year profile classifies (matches the frontend)', () => {
    // Non-relative NV profile: numbers are absolute years, no anchor needed.
    // The old backend returned null for every NV bottle (audit 2026-08-03 H6).
    const bottle = makeBottle('NV');
    const map = makeMap('NV', { status: 'reviewed', earlyFrom: 2020 });
    expect(classifyMaturity(bottle, map)).toBe('early');
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

  test('returns null when no window boundaries are set', () => {
    const bottle = makeBottle(2020);
    const map = makeMap(2020, { status: 'reviewed' });
    expect(classifyMaturity(bottle, map)).toBeNull();
  });

  // ── Peak-only profiles (no early window) ──────────────────────────────────

  test('peak-only: returns "not-ready" when currentYear < peakFrom', () => {
    // currentYear=2026, peakFrom=2028, peakUntil=2030
    const bottle = makeBottle(2020);
    const map = makeMap(2020, {
      status: 'reviewed',
      peakFrom: 2028, peakUntil: 2030,
    });
    expect(classifyMaturity(bottle, map)).toBe('not-ready');
  });

  test('peak-only: returns "peak" when in peak window', () => {
    // currentYear=2026, peakFrom=2025, peakUntil=2028
    const bottle = makeBottle(2020);
    const map = makeMap(2020, {
      status: 'reviewed',
      peakFrom: 2025, peakUntil: 2028,
    });
    expect(classifyMaturity(bottle, map)).toBe('peak');
  });

  test('peak-only: returns "declining" when past peakUntil', () => {
    // currentYear=2026, peakFrom=2020, peakUntil=2024
    const bottle = makeBottle(2020);
    const map = makeMap(2020, {
      status: 'reviewed',
      peakFrom: 2020, peakUntil: 2024,
    });
    expect(classifyMaturity(bottle, map)).toBe('declining');
  });

  test('peak-only with late: returns "late" when in late window', () => {
    // currentYear=2026, peakFrom=2020, peakUntil=2024, lateFrom=2025, lateUntil=2028
    const bottle = makeBottle(2020);
    const map = makeMap(2020, {
      status: 'reviewed',
      peakFrom: 2020, peakUntil: 2024,
      lateFrom: 2025, lateUntil: 2028,
    });
    expect(classifyMaturity(bottle, map)).toBe('late');
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

// ─── Personal drink window (bottle.drinkFrom / drinkTo) ──────────────────────
// System clock is fixed to 2026 above.

describe('classifyPersonalWindow', () => {
  test('returns null when neither drinkFrom nor drinkTo is set', () => {
    expect(classifyPersonalWindow({})).toBeNull();
    expect(classifyPersonalWindow({ drinkFrom: null, drinkTo: null })).toBeNull();
    expect(classifyPersonalWindow(undefined)).toBeNull();
  });

  test('classifies not-ready / peak / declining against a full window', () => {
    expect(classifyPersonalWindow({ drinkFrom: 2028, drinkTo: 2032 })).toBe('not-ready');
    expect(classifyPersonalWindow({ drinkFrom: 2024, drinkTo: 2028 })).toBe('peak');
    expect(classifyPersonalWindow({ drinkFrom: 2020, drinkTo: 2024 })).toBe('declining');
  });

  test('boundary years are inclusive', () => {
    expect(classifyPersonalWindow({ drinkFrom: 2026, drinkTo: 2026 })).toBe('peak');
  });

  test('only drinkFrom set: open-ended after the from year', () => {
    expect(classifyPersonalWindow({ drinkFrom: 2028 })).toBe('not-ready');
    expect(classifyPersonalWindow({ drinkFrom: 2024 })).toBe('peak');
  });

  test('only drinkTo set: drinkable now until the to year', () => {
    expect(classifyPersonalWindow({ drinkTo: 2030 })).toBe('peak');
    expect(classifyPersonalWindow({ drinkTo: 2024 })).toBe('declining');
  });
});

describe('classifyMaturity — personal window precedence', () => {
  const wdId = 'abc123';
  const profilePeakNow = {
    status: 'reviewed',
    earlyFrom: 2022, earlyUntil: 2024,
    peakFrom: 2025, peakUntil: 2030,
  };

  function mapFor(vintage, profile = profilePeakNow) {
    const map = new Map();
    map.set(`${wdId}:${vintage}`, profile);
    return map;
  }

  test('personal window overrides a reviewed profile (profile says peak, personal says not-ready)', () => {
    const bottle = { wineDefinition: { _id: wdId }, vintage: 2020, drinkFrom: 2030, drinkTo: 2035 };
    expect(classifyMaturity(bottle, mapFor(2020))).toBe('not-ready');
  });

  test('personal window overrides a reviewed profile (profile says peak, personal says declining)', () => {
    const bottle = { wineDefinition: { _id: wdId }, vintage: 2020, drinkFrom: 2018, drinkTo: 2022 };
    expect(classifyMaturity(bottle, mapFor(2020))).toBe('declining');
  });

  test('only drinkFrom set still takes precedence', () => {
    const bottle = { wineDefinition: { _id: wdId }, vintage: 2020, drinkFrom: 2029 };
    expect(classifyMaturity(bottle, mapFor(2020))).toBe('not-ready');
  });

  test('only drinkTo set still takes precedence', () => {
    const bottle = { wineDefinition: { _id: wdId }, vintage: 2020, drinkTo: 2040 };
    expect(classifyMaturity(bottle, mapFor(2020))).toBe('peak');
  });

  test('personal window applies to NV bottles and bottles without a wine definition', () => {
    expect(classifyMaturity({ vintage: 'NV', drinkFrom: 2024, drinkTo: 2028 }, new Map())).toBe('peak');
    expect(classifyMaturity({ wineDefinition: null, vintage: 2020, drinkTo: 2024 }, new Map())).toBe('declining');
  });

  test('no personal window → profile classification unchanged', () => {
    const bottle = { wineDefinition: { _id: wdId }, vintage: 2020 };
    expect(classifyMaturity(bottle, mapFor(2020))).toBe('peak');
  });
});

// ─── Relative (NV) profiles — audit 2026-08-03 H6 ────────────────────────────
// Offsets are anchored on the bottle's purchase year (falling back to
// createdAt), mirroring frontend resolveWindow/bottleAnchorYear. Clock: 2026.

describe('classifyMaturity — relative (NV) profiles', () => {
  const wdId = 'abc123';
  const nvBottle = (over = {}) => ({ wineDefinition: { _id: wdId }, vintage: 'NV', ...over });

  // Early 0–1y, peak 2–5y, late 6–8y after purchase.
  function relMap(overrides = {}) {
    const map = new Map();
    map.set(`${wdId}:NV`, {
      status: 'reviewed', relative: true,
      earlyFrom: 0, earlyUntil: 1, peakFrom: 2, peakUntil: 5, lateFrom: 6, lateUntil: 8,
      ...overrides,
    });
    return map;
  }

  test('offsets anchor on the purchase year: bought 2024 → peak in 2026', () => {
    // Peak = 2024+2 … 2024+5 = 2026–2029.
    expect(classifyMaturity(nvBottle({ purchaseDate: '2024-03-01' }), relMap())).toBe('peak');
  });

  test('bought this year → early', () => {
    expect(classifyMaturity(nvBottle({ purchaseDate: '2026-01-10' }), relMap())).toBe('early');
  });

  test('bought long ago → declining', () => {
    // Late until 2015+8 = 2023 < 2026.
    expect(classifyMaturity(nvBottle({ purchaseDate: '2015-06-01' }), relMap())).toBe('declining');
  });

  test('falls back to createdAt when purchaseDate is missing', () => {
    expect(classifyMaturity(nvBottle({ createdAt: '2024-08-20' }), relMap())).toBe('peak');
  });

  test('no anchor at all → null (offsets must never be read as calendar years)', () => {
    expect(classifyMaturity(nvBottle(), relMap())).toBeNull();
  });

  test('a zero offset resolves to the anchor year itself', () => {
    // earlyFrom 0 → drinkable from 2026; peak from 2028 → early now.
    const map = relMap({ earlyFrom: 0, earlyUntil: 1, peakFrom: 2, peakUntil: 5 });
    expect(classifyMaturity(nvBottle({ purchaseDate: '2026-02-02' }), map)).toBe('early');
  });

  test('personal drink window still wins over a relative profile', () => {
    const bottle = nvBottle({ purchaseDate: '2024-03-01', drinkFrom: 2030 });
    expect(classifyMaturity(bottle, relMap())).toBe('not-ready');
  });

  test('unreviewed relative profile → null', () => {
    const map = relMap({ status: 'pending' });
    expect(classifyMaturity(nvBottle({ purchaseDate: '2024-03-01' }), map)).toBeNull();
  });
});

describe('bottleAnchorYear / resolveWindow', () => {
  test('anchor prefers purchaseDate over createdAt', () => {
    expect(bottleAnchorYear({ purchaseDate: '2019-05-01', createdAt: '2023-01-01' })).toBe(2019);
    expect(bottleAnchorYear({ createdAt: '2023-01-01' })).toBe(2023);
    expect(bottleAnchorYear({})).toBeNull();
    expect(bottleAnchorYear(null)).toBeNull();
  });

  test('resolveWindow adds the anchor to every offset of a relative profile', () => {
    const w = resolveWindow({ relative: true, earlyFrom: 0, peakFrom: 2, peakUntil: 5 }, 2020);
    expect(w).toMatchObject({ earlyFrom: 2020, peakFrom: 2022, peakUntil: 2025 });
    expect(w.lateFrom).toBeUndefined();
  });

  test('resolveWindow passes absolute profiles through untouched, anchor ignored', () => {
    const w = resolveWindow({ earlyFrom: 2024, peakUntil: 2030 }, 2020);
    expect(w).toMatchObject({ earlyFrom: 2024, peakUntil: 2030 });
  });
});

describe('buildProfileMap — NV pairs included', () => {
  beforeEach(() => jest.clearAllMocks());

  test('NV bottles are queried and their profiles land in the map', async () => {
    const profiles = [
      { wineDefinition: 'wd1', vintage: 'NV', status: 'reviewed', relative: true, peakFrom: 2, peakUntil: 5 },
      { wineDefinition: 'wd1', vintage: '2019', status: 'reviewed', peakFrom: 2024, peakUntil: 2030 },
    ];
    WineVintageProfile.find.mockReturnValue({ lean: () => Promise.resolve(profiles) });

    const map = await buildProfileMap([
      { wineDefinition: { _id: 'wd1' }, vintage: 'NV' },
      { wineDefinition: { _id: 'wd1' }, vintage: '2019' },
    ]);

    expect(map.get('wd1:NV')).toMatchObject({ relative: true });
    expect(map.get('wd1:2019')).toMatchObject({ peakFrom: 2024 });
  });

  test('an NV-only bottle set still issues the profile query (previously skipped entirely)', async () => {
    WineVintageProfile.find.mockReturnValue({ lean: () => Promise.resolve([]) });
    const map = await buildProfileMap([{ wineDefinition: { _id: 'wd1' }, vintage: 'NV' }]);
    expect(WineVintageProfile.find).toHaveBeenCalledTimes(1);
    expect(map.size).toBe(0);
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

  test('returns correct string for "not-ready" with earlyFrom', () => {
    const profile = { earlyFrom: 2028 };
    const label = maturityLabel('not-ready', profile);
    expect(label).toBe('Not ready yet — drinking from 2028');
  });

  test('returns correct string for "not-ready" with peakFrom only', () => {
    const profile = { peakFrom: 2030 };
    const label = maturityLabel('not-ready', profile);
    expect(label).toBe('Not ready yet — drinking from 2030');
  });

  test('returns correct string for "not-ready" with missing windows', () => {
    const label = maturityLabel('not-ready', {});
    expect(label).toBe('Not ready yet — drinking from ?');
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
    expect(label).toBe('Not ready yet — drinking from ?');
  });
});

// ── BUG 3: label must quote the PERSONAL window years when it governs ─────────
// System clock is fixed to 2026 above. The profile deliberately disagrees with
// the personal window so a leak of profile years is visible.
describe('maturityLabel — personal window precedence', () => {
  const profileSaysNow = { earlyFrom: 2018, peakFrom: 2020, peakUntil: 2028, lateUntil: 2032 };

  test('not-ready: quotes the personal drinkFrom, not the profile early/peak year', () => {
    const bottle = { drinkFrom: 2035, drinkTo: 2040 };
    // status derived from the personal window (currentYear 2026 < 2035)
    expect(maturityLabel('not-ready', profileSaysNow, bottle)).toBe('Not ready yet — drinking from 2035');
  });

  test('peak: quotes the personal drinkTo, not the profile peakUntil', () => {
    const bottle = { drinkFrom: 2024, drinkTo: 2038 };
    expect(maturityLabel('peak', profileSaysNow, bottle)).toBe('At peak — drink now through 2038');
  });

  test('peak with only drinkFrom set: open-ended personal peak has no year suffix', () => {
    const bottle = { drinkFrom: 2024 };
    expect(maturityLabel('peak', profileSaysNow, bottle)).toBe('At peak maturity — drink now');
  });

  test('declining: personal window → year-free past-peak label', () => {
    const bottle = { drinkFrom: 2018, drinkTo: 2022 };
    expect(maturityLabel('declining', profileSaysNow, bottle)).toBe('Past peak — declining, drink immediately if at all');
  });

  test('no personal window on the bottle → unchanged profile-based label', () => {
    const bottle = { vintage: 2020 }; // no drinkFrom/drinkTo
    expect(maturityLabel('peak', profileSaysNow, bottle)).toBe('At peak — drink now through 2028');
    expect(maturityLabel('not-ready', { earlyFrom: 2028 }, bottle)).toBe('Not ready yet — drinking from 2028');
  });

  test('omitting the bottle arg keeps the legacy profile-based behaviour', () => {
    expect(maturityLabel('peak', profileSaysNow)).toBe('At peak — drink now through 2028');
  });
});

describe('maturityLabel — relative (NV) profiles quote resolved years', () => {
  const relProfile = { status: 'reviewed', relative: true, earlyFrom: 0, peakFrom: 2, peakUntil: 5, lateUntil: 8 };

  test('peak label quotes anchor + offset, not the raw offset', () => {
    const bottle = { vintage: 'NV', purchaseDate: '2024-03-01' };
    expect(maturityLabel('peak', relProfile, bottle)).toBe('At peak — drink now through 2029');
  });

  test('late label resolves lateUntil the same way', () => {
    const bottle = { vintage: 'NV', purchaseDate: '2020-03-01' };
    expect(maturityLabel('late', relProfile, bottle)).toBe('Late maturity — drink soon, until 2028');
  });

  test('no anchor → generic year-free labels, never a bare offset', () => {
    expect(maturityLabel('peak', relProfile, { vintage: 'NV' })).toBe('At peak maturity — drink now');
    expect(maturityLabel('not-ready', relProfile, { vintage: 'NV' })).toBe('Not ready yet — drinking from ?');
  });
});
