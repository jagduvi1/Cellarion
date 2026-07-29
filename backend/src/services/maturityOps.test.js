const {
  parseVintageYear,
  computeDefaultDeferUntil,
  buildQueueFilter,
  isDeferralDue,
  parseDeferUntil,
  parseDeferReason,
  canDefer,
  snapshotDeferral,
  restoreDeferral,
  applyDefer,
  clearDeferral,
  returnToQueue,
  MAX_DEFER_YEARS,
  REASON_MAX,
} = require('./maturityOps');

// Fixed clock: every assertion about "a year from now" has to be reproducible.
const NOW = new Date('2026-07-29T10:00:00.000Z');

describe('parseVintageYear', () => {
  test('reads a bare four-digit year', () => {
    expect(parseVintageYear('2018')).toBe(2018);
    expect(parseVintageYear(' 2018 ')).toBe(2018);
  });

  test('rejects the non-year vintages the queue actually holds', () => {
    // Bottle.vintage defaults to 'NV' and imports write 'Unknown'; neither is a
    // year to reason from.
    for (const v of ['NV', 'Nv', 'Unknown', '', '20', '20188', 'MMXVIII', null, undefined]) {
      expect(parseVintageYear(v)).toBeNull();
    }
  });
});

describe('computeDefaultDeferUntil', () => {
  test('future vintage → 1 January two years after it', () => {
    expect(computeDefaultDeferUntil('2027', NOW).toISOString()).toBe('2029-01-01T00:00:00.000Z');
  });

  test('never returns a date less than a year out, however old the vintage', () => {
    // vintage+2 is long past here — without the floor the row would come
    // straight back on the next queue load and the defer would look broken.
    const got = computeDefaultDeferUntil('2005', NOW);
    expect(got.toISOString()).toBe('2027-07-29T10:00:00.000Z');
    expect(got.getTime()).toBeGreaterThan(NOW.getTime());
  });

  test('the floor also catches a vintage whose +2 lands just inside the year', () => {
    // 2026 + 2 = 2028-01-01, which is more than a year from 2026-07-29 → kept.
    expect(computeDefaultDeferUntil('2026', NOW).toISOString()).toBe('2028-01-01T00:00:00.000Z');
    // 2025 + 2 = 2027-01-01, which is LESS than a year out → floored.
    expect(computeDefaultDeferUntil('2025', NOW).toISOString()).toBe('2027-07-29T10:00:00.000Z');
  });

  test('NV and Unknown get the floor — no year to reason from', () => {
    expect(computeDefaultDeferUntil('NV', NOW).toISOString()).toBe('2027-07-29T10:00:00.000Z');
    expect(computeDefaultDeferUntil('Unknown', NOW).toISOString()).toBe('2027-07-29T10:00:00.000Z');
  });
});

describe('buildQueueFilter', () => {
  test('pending includes deferred rows whose date has passed', () => {
    const f = buildQueueFilter('pending', NOW);
    expect(f).toEqual({
      $or: [
        { status: 'pending' },
        { status: 'deferred', deferredUntil: { $ne: null, $lte: NOW } },
      ],
    });
  });

  test('an indefinite deferral can never match the pending filter', () => {
    // $ne: null is the guard — a null deferredUntil must not be swept back in.
    const f = buildQueueFilter('pending', NOW);
    expect(f.$or[1].deferredUntil.$ne).toBeNull();
  });

  test('deferred excludes rows that are already due, so no row is in two views', () => {
    expect(buildQueueFilter('deferred', NOW)).toEqual({
      status: 'deferred',
      $or: [{ deferredUntil: null }, { deferredUntil: { $gt: NOW } }],
    });
  });

  test('reviewed is exact, anything else is everything', () => {
    expect(buildQueueFilter('reviewed', NOW)).toEqual({ status: 'reviewed' });
    expect(buildQueueFilter('all', NOW)).toEqual({});
    expect(buildQueueFilter(undefined, NOW)).toEqual({});
  });
});

describe('isDeferralDue', () => {
  const due = { status: 'deferred', deferredUntil: new Date('2026-01-01T00:00:00Z') };
  const held = { status: 'deferred', deferredUntil: new Date('2030-01-01T00:00:00Z') };

  test('true only for a deferred row past its date', () => {
    expect(isDeferralDue(due, NOW)).toBe(true);
    expect(isDeferralDue(held, NOW)).toBe(false);
    expect(isDeferralDue({ status: 'deferred', deferredUntil: null }, NOW)).toBe(false);
    expect(isDeferralDue({ status: 'pending' }, NOW)).toBe(false);
    expect(isDeferralDue(null, NOW)).toBe(false);
  });
});

describe('parseDeferUntil', () => {
  test('undefined → the computed default (the curator did not choose)', () => {
    const r = parseDeferUntil(undefined, '2027', NOW);
    expect(r.ok).toBe(true);
    expect(r.value.toISOString()).toBe('2029-01-01T00:00:00.000Z');
  });

  test('null and empty string → indefinite, which is NOT the same as the default', () => {
    expect(parseDeferUntil(null, '2027', NOW)).toEqual({ ok: true, value: null });
    expect(parseDeferUntil('', '2027', NOW)).toEqual({ ok: true, value: null });
  });

  test('an ISO date is taken as given', () => {
    const r = parseDeferUntil('2028-03-01', '2027', NOW);
    expect(r.ok).toBe(true);
    expect(r.value.toISOString()).toBe('2028-03-01T00:00:00.000Z');
  });

  test('rejects garbage, the past, today, and absurd futures', () => {
    expect(parseDeferUntil('not-a-date', '2027', NOW).ok).toBe(false);
    expect(parseDeferUntil('2020-01-01', '2027', NOW).ok).toBe(false);
    expect(parseDeferUntil(NOW, '2027', NOW).ok).toBe(false);
    const tooFar = new Date(Date.UTC(NOW.getUTCFullYear() + MAX_DEFER_YEARS + 1, 0, 1));
    expect(parseDeferUntil(tooFar.toISOString(), '2027', NOW).ok).toBe(false);
  });
});

describe('parseDeferReason', () => {
  test('blank inputs collapse to an empty string', () => {
    for (const v of [undefined, null, '']) expect(parseDeferReason(v)).toEqual({ ok: true, value: '' });
  });

  test('trims, and rejects a non-string or an over-long reason', () => {
    expect(parseDeferReason('  not released  ')).toEqual({ ok: true, value: 'not released' });
    expect(parseDeferReason({ evil: true }).ok).toBe(false);
    expect(parseDeferReason('x'.repeat(REASON_MAX + 1)).ok).toBe(false);
    expect(parseDeferReason('x'.repeat(REASON_MAX)).ok).toBe(true);
  });
});

describe('canDefer', () => {
  test('a reviewed row must be reset first — deferring it would retire live data', () => {
    expect(canDefer({ status: 'reviewed' }).ok).toBe(false);
    expect(canDefer({ status: 'pending' }).ok).toBe(true);
    expect(canDefer({ status: 'deferred' }).ok).toBe(true); // re-defer with a new date
  });
});

describe('applyDefer / clearDeferral / returnToQueue', () => {
  const fresh = () => ({
    status: 'pending',
    vintage: '2027',
    earlyFrom: undefined,
    peakFrom: undefined,
    deferredUntil: null,
    deferredReason: '',
    deferredBy: null,
    deferredAt: null,
  });

  test('deferring records who/when/why and leaves the phases alone', () => {
    const p = fresh();
    p.peakFrom = 2035; // a stray value must not be silently wiped
    applyDefer(p, { until: new Date('2029-01-01T00:00:00Z'), reason: 'not released', userId: 'u1', now: NOW });
    expect(p.status).toBe('deferred');
    expect(p.deferredUntil.toISOString()).toBe('2029-01-01T00:00:00.000Z');
    expect(p.deferredReason).toBe('not released');
    expect(p.deferredBy).toBe('u1');
    expect(p.deferredAt).toBe(NOW);
    expect(p.peakFrom).toBe(2035);
  });

  test('an indefinite defer stores null, not a date', () => {
    const p = fresh();
    applyDefer(p, { until: null, userId: 'u1', now: NOW });
    expect(p.deferredUntil).toBeNull();
    expect(p.status).toBe('deferred');
  });

  test('clearDeferral wipes the deferral but does not touch status', () => {
    const p = fresh();
    applyDefer(p, { until: new Date('2029-01-01T00:00:00Z'), reason: 'x', userId: 'u1', now: NOW });
    p.status = 'reviewed';
    clearDeferral(p);
    expect(p.status).toBe('reviewed');
    expect(p.deferredUntil).toBeNull();
    expect(p.deferredReason).toBe('');
    expect(p.deferredBy).toBeNull();
    expect(p.deferredAt).toBeNull();
  });

  test('returnToQueue sends it back to pending and clears the deferral', () => {
    const p = fresh();
    applyDefer(p, { until: new Date('2029-01-01T00:00:00Z'), reason: 'x', userId: 'u1', now: NOW });
    returnToQueue(p);
    expect(p.status).toBe('pending');
    expect(p.deferredUntil).toBeNull();
    expect(p.deferredBy).toBeNull();
  });
});

describe('snapshotDeferral / restoreDeferral', () => {
  test('round-trips a pending row back to pending', () => {
    const p = { status: 'pending', deferredUntil: null, deferredReason: '', deferredBy: null, deferredAt: null };
    const snap = snapshotDeferral(p);
    applyDefer(p, { until: new Date('2029-01-01T00:00:00Z'), reason: 'x', userId: 'u1', now: NOW });
    restoreDeferral(p, snap);
    expect(p).toEqual({ status: 'pending', deferredUntil: null, deferredReason: '', deferredBy: null, deferredAt: null });
  });

  test('undoing a RE-defer restores the previous deferral, not pending', () => {
    const first = new Date('2028-01-01T00:00:00Z');
    const p = { status: 'deferred', deferredUntil: first, deferredReason: 'first', deferredBy: 'u1', deferredAt: NOW };
    const snap = snapshotDeferral(p);
    applyDefer(p, { until: new Date('2031-01-01T00:00:00Z'), reason: 'second', userId: 'u2', now: NOW });
    restoreDeferral(p, snap);
    expect(p.status).toBe('deferred');
    expect(p.deferredUntil).toBe(first);
    expect(p.deferredReason).toBe('first');
    expect(p.deferredBy).toBe('u1');
  });

  test('a missing snapshot degrades to pending rather than throwing', () => {
    const p = { status: 'deferred', deferredUntil: NOW, deferredReason: 'x', deferredBy: 'u1', deferredAt: NOW };
    restoreDeferral(p, undefined);
    expect(p.status).toBe('pending');
    expect(p.deferredUntil).toBeNull();
  });
});
