/**
 * Climate alert hysteresis (docs/climate-monitoring.md).
 *
 * WHY THIS TEST EXISTS:
 * The alert engine is a per-channel state machine whose whole job is to NOT
 * notify naively: a breach must be sustained before alerting, repeated alerts
 * are cooldown-suppressed, and recoveries only notify when their breach
 * actually did. Off-by-one here means either silent outages or notification
 * spam — both kill trust in the feature.
 */

const {
  evaluateDeviceAlerts,
  effectiveClimateConfig,
  SUSTAIN_MS,
  COOLDOWN_MS,
} = require('./climateAlerts');

const T0 = new Date('2026-07-10T12:00:00Z');
const at = (offsetMs) => new Date(T0.getTime() + offsetMs);

const channel = (over = {}) => ({
  key: 'ambient',
  type: 'temperature',
  label: '',
  calibrationOffset: 0,
  lastValue: null,
  lastValueAt: null,
  alertState: 'ok',
  breachedSince: null,
  lastAlertAt: null,
  ...over,
});

const device = (channels) => ({ name: 'Cellar ESP32', channels });

const cellar = (climateOver = {}) => ({
  _id: 'c1',
  name: 'Main cellar',
  climate: { tempMin: 8, tempMax: 16, rhMin: 45, rhMax: 80, offlineAfterMin: 60, alertsEnabled: true, ...climateOver },
});

describe('effectiveClimateConfig', () => {
  test('falls back to shipped defaults when the cellar never configured climate', () => {
    expect(effectiveClimateConfig(null)).toEqual({
      tempMin: 8, tempMax: 16, rhMin: 45, rhMax: 80, offlineAfterMin: 60, alertsEnabled: true,
    });
    expect(effectiveClimateConfig({ climate: undefined })).toMatchObject({ tempMin: 8, tempMax: 16 });
  });

  test('stored values override defaults field-by-field', () => {
    const cfg = effectiveClimateConfig({ climate: { tempMax: 14, alertsEnabled: false } });
    expect(cfg).toMatchObject({ tempMin: 8, tempMax: 14, rhMin: 45, alertsEnabled: false });
  });
});

describe('evaluateDeviceAlerts — sustain before alerting', () => {
  test('first out-of-range reading arms the timer but does NOT notify', () => {
    const ch = channel({ lastValue: 18 });
    const notifs = evaluateDeviceAlerts(device([ch]), cellar(), T0);
    expect(notifs).toEqual([]);
    expect(ch.alertState).toBe('ok');
    expect(ch.breachedSince).toEqual(T0);
  });

  test('a breach sustained past SUSTAIN_MS notifies exactly once', () => {
    const ch = channel({ lastValue: 18, breachedSince: T0 });
    const now = at(SUSTAIN_MS);
    const notifs = evaluateDeviceAlerts(device([ch]), cellar(), now);
    expect(notifs).toHaveLength(1);
    expect(notifs[0].type).toBe('climate_alert');
    expect(notifs[0].message).toContain('18');
    expect(notifs[0].message).toContain('8–16');
    expect(ch.alertState).toBe('breached');
    expect(ch.lastAlertAt).toEqual(now);

    // Still breached on the next reading → no second notification
    const again = evaluateDeviceAlerts(device([ch]), cellar(), at(SUSTAIN_MS + 5 * 60 * 1000));
    expect(again).toEqual([]);
  });

  test('an in-range reading before the sustain window resets the timer (flap tolerance)', () => {
    const ch = channel({ lastValue: 12, breachedSince: T0 });
    const notifs = evaluateDeviceAlerts(device([ch]), cellar(), at(SUSTAIN_MS - 1000));
    expect(notifs).toEqual([]);
    expect(ch.breachedSince).toBeNull();
    expect(ch.alertState).toBe('ok');
  });

  test('humidity channels use the RH thresholds', () => {
    const ch = channel({ key: 'ambient', type: 'humidity', lastValue: 90, breachedSince: T0 });
    const notifs = evaluateDeviceAlerts(device([ch]), cellar(), at(SUSTAIN_MS));
    expect(notifs).toHaveLength(1);
    expect(notifs[0].message).toContain('45–80');
    expect(notifs[0].message).toContain('%');
  });
});

describe('evaluateDeviceAlerts — recovery', () => {
  test('recovery after a notified breach sends climate_recovered once and resets state', () => {
    const ch = channel({
      lastValue: 12,
      alertState: 'breached',
      breachedSince: T0,
      lastAlertAt: at(SUSTAIN_MS), // the breach episode DID notify
    });
    const notifs = evaluateDeviceAlerts(device([ch]), cellar(), at(SUSTAIN_MS + 10 * 60 * 1000));
    expect(notifs).toHaveLength(1);
    expect(notifs[0].type).toBe('climate_recovered');
    expect(ch.alertState).toBe('ok');
    expect(ch.breachedSince).toBeNull();

    const again = evaluateDeviceAlerts(device([ch]), cellar(), at(SUSTAIN_MS + 15 * 60 * 1000));
    expect(again).toEqual([]);
  });

  test('a cooldown-suppressed breach episode recovers SILENTLY', () => {
    // Breach sustained, but the last alert was recent → alert suppressed.
    const recentAlert = at(-COOLDOWN_MS / 2);
    const ch = channel({ lastValue: 18, breachedSince: at(-SUSTAIN_MS), lastAlertAt: recentAlert });
    const breach = evaluateDeviceAlerts(device([ch]), cellar(), T0);
    expect(breach).toEqual([]); // suppressed by cooldown
    expect(ch.alertState).toBe('breached');

    // Recovery: lastAlertAt predates this episode's breachedSince → silent.
    ch.lastValue = 12;
    const recovery = evaluateDeviceAlerts(device([ch]), cellar(), at(5 * 60 * 1000));
    expect(recovery).toEqual([]);
    expect(ch.alertState).toBe('ok');
  });

  test('after the cooldown expires, a new sustained breach notifies again', () => {
    const ch = channel({
      lastValue: 18,
      breachedSince: at(-SUSTAIN_MS),
      lastAlertAt: at(-COOLDOWN_MS), // exactly a cooldown ago
    });
    const notifs = evaluateDeviceAlerts(device([ch]), cellar(), T0);
    expect(notifs).toHaveLength(1);
    expect(notifs[0].type).toBe('climate_alert');
  });
});

describe('evaluateDeviceAlerts — gates', () => {
  test('alertsEnabled: false clears transient state and never notifies', () => {
    const ch = channel({ lastValue: 30, alertState: 'breached', breachedSince: T0, lastAlertAt: T0 });
    const notifs = evaluateDeviceAlerts(device([ch]), cellar({ alertsEnabled: false }), at(SUSTAIN_MS));
    expect(notifs).toEqual([]);
    expect(ch.alertState).toBe('ok');
    expect(ch.breachedSince).toBeNull();
  });

  test('a device with no assigned cellar never notifies', () => {
    const ch = channel({ lastValue: 30, breachedSince: T0 });
    const notifs = evaluateDeviceAlerts(device([ch]), null, at(SUSTAIN_MS));
    expect(notifs).toEqual([]);
  });

  test('channels that have never reported are skipped', () => {
    const ch = channel({ lastValue: null });
    const notifs = evaluateDeviceAlerts(device([ch]), cellar(), T0);
    expect(notifs).toEqual([]);
    expect(ch.breachedSince).toBeNull();
  });

  test('channel labels are preferred over keys in messages', () => {
    const ch = channel({ label: 'Top shelf', lastValue: 18, breachedSince: at(-SUSTAIN_MS) });
    const notifs = evaluateDeviceAlerts(device([ch]), cellar(), T0);
    expect(notifs[0].message).toContain('Top shelf');
  });
});
