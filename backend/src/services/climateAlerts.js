const { CLIMATE_DEFAULTS } = require('../models/Cellar');

// Threshold evaluation for climate readings (docs/climate-monitoring.md).
//
// Hysteresis, so a value hovering on a threshold cannot spam:
// - a breach must be CONTINUOUSLY out of range for SUSTAIN_MS before it
//   notifies (breachedSince marks the first out-of-range reading; any
//   in-range reading resets it),
// - after a breach notification, further breach notifications for the same
//   channel are suppressed for COOLDOWN_MS,
// - a recovery notification is sent only when the breach episode actually
//   notified (lastAlertAt >= breachedSince) — a cooldown-suppressed episode
//   recovers silently, otherwise flapping would spam recoveries.
//
// This module only MUTATES the device's channel state and RETURNS the
// notifications to send — the caller persists the device and dispatches them.
// Keeping it side-effect-free makes the state machine unit-testable.

const SUSTAIN_MS = 15 * 60 * 1000;
const COOLDOWN_MS = 6 * 60 * 60 * 1000;

/** Cellar thresholds with defaults filled in for unset fields/older cellars. */
function effectiveClimateConfig(cellar) {
  const stored = cellar?.climate
    ? (typeof cellar.climate.toObject === 'function' ? cellar.climate.toObject() : cellar.climate)
    : {};
  const cfg = { ...CLIMATE_DEFAULTS };
  for (const key of Object.keys(CLIMATE_DEFAULTS)) {
    if (stored[key] !== undefined && stored[key] !== null) cfg[key] = stored[key];
  }
  return cfg;
}

function boundsFor(type, cfg) {
  return type === 'temperature'
    ? { min: cfg.tempMin, max: cfg.tempMax, unit: '°C' }
    : { min: cfg.rhMin, max: cfg.rhMax, unit: '%' };
}

const fmt = (v) => Number.parseFloat(Number(v).toFixed(1));

/**
 * Evaluate all channels of a device against its cellar's thresholds.
 * Mutates channel alertState/breachedSince/lastAlertAt in place.
 *
 * @param {object} device — ClimateDevice doc (channels get mutated)
 * @param {object|null} cellar — the assigned Cellar (or null when unassigned)
 * @param {Date} [now]
 * @returns {Array<{type, title, message}>} notifications for the device owner
 */
function evaluateDeviceAlerts(device, cellar, now = new Date()) {
  const cfg = effectiveClimateConfig(cellar);
  const notifications = [];

  // No cellar assigned, or alerts off: clear transient state so re-enabling
  // starts a fresh episode instead of instantly firing on stale timers.
  if (!cellar || !cfg.alertsEnabled) {
    for (const ch of device.channels) {
      ch.breachedSince = null;
      if (ch.alertState === 'breached') ch.alertState = 'ok';
    }
    return notifications;
  }

  // A channel whose last reading is older than the offline window is treated as
  // stale: judging a dead probe's final value forever would alert on a reading
  // that can never change or recover (a single spike from a probe that then
  // disconnects while a sibling channel keeps the device's lastSeenAt fresh).
  const staleBeforeMs = now.getTime() - cfg.offlineAfterMin * 60 * 1000;

  for (const ch of device.channels) {
    if (ch.lastValue === null || ch.lastValue === undefined) continue;
    if (ch.lastValueAt && new Date(ch.lastValueAt).getTime() < staleBeforeMs) {
      // Stop evaluating a stale channel and clear a pending (not-yet-notified)
      // breach so it doesn't fire the moment the timer crosses SUSTAIN_MS on a
      // value that will never be refreshed.
      if (ch.alertState !== 'breached') ch.breachedSince = null;
      continue;
    }
    const { min, max, unit } = boundsFor(ch.type, cfg);
    const out = ch.lastValue < min || ch.lastValue > max;
    const name = ch.label || ch.key;

    if (out) {
      if (!ch.breachedSince) ch.breachedSince = now;
      const sustained = now.getTime() - new Date(ch.breachedSince).getTime() >= SUSTAIN_MS;
      if (sustained && ch.alertState !== 'breached') {
        ch.alertState = 'breached';
        if (!ch.lastAlertAt || now.getTime() - new Date(ch.lastAlertAt).getTime() >= COOLDOWN_MS) {
          ch.lastAlertAt = now;
          notifications.push({
            type: 'climate_alert',
            title: `Climate alert: ${cellar.name}`,
            message: `"${name}" ${ch.type} is ${fmt(ch.lastValue)} ${unit} — outside the allowed ${fmt(min)}–${fmt(max)} ${unit}.`,
          });
        }
      }
    } else {
      if (ch.alertState === 'breached') {
        ch.alertState = 'ok';
        const episodeNotified = ch.lastAlertAt && ch.breachedSince
          && new Date(ch.lastAlertAt).getTime() >= new Date(ch.breachedSince).getTime();
        if (episodeNotified) {
          notifications.push({
            type: 'climate_recovered',
            title: `Climate recovered: ${cellar.name}`,
            message: `"${name}" ${ch.type} is back within range (${fmt(ch.lastValue)} ${unit}).`,
          });
        }
      }
      ch.breachedSince = null;
    }
  }

  return notifications;
}

module.exports = {
  effectiveClimateConfig,
  evaluateDeviceAlerts,
  boundsFor,
  SUSTAIN_MS,
  COOLDOWN_MS,
};
