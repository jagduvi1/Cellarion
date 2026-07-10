const ClimateDevice = require('../models/ClimateDevice');
const { createNotification } = require('./notifications');
const { effectiveClimateConfig } = require('./climateAlerts');

// Smallest offlineAfterMin any cellar can configure (Cellar schema min). A
// device silent for less than this can't be offline under ANY config, so the
// query can exclude the whole healthy fleet up front instead of loading it and
// filtering in JS.
const MIN_OFFLINE_AFTER_MIN = 15;

// Sensor-offline detection, run from the scheduler every 15 minutes.
//
// A device is "offline" when it has posted before (lastSeenAt set) but has
// been silent longer than its cellar's offlineAfterMin. One notification per
// silence: offlineNotifiedAt marks it, and the ingest route clears the flag
// (with a recovery notification) when the device comes back. Devices that
// have NEVER posted are skipped — a freshly created device that was not set
// up yet is not an outage.
async function runClimateOfflineCheck(now = new Date()) {
  // lastSeenAt: { $lte } both requires a prior post (a null is not <= a date)
  // and bounds the set to devices silent past the smallest possible window,
  // so a fleet of healthy devices posting every few minutes isn't hydrated.
  const silentBefore = new Date(now.getTime() - MIN_OFFLINE_AFTER_MIN * 60 * 1000);
  const devices = await ClimateDevice.find({
    lastSeenAt: { $lte: silentBefore },
    offlineNotifiedAt: null,
  }).populate('cellar', 'name climate deletedAt');

  let notified = 0;
  for (const device of devices) {
    const cellar = device.cellar && !device.cellar.deletedAt ? device.cellar : null;
    const cfg = effectiveClimateConfig(cellar);
    if (!cfg.alertsEnabled) continue;

    const silentMs = now.getTime() - device.lastSeenAt.getTime();
    if (silentMs < cfg.offlineAfterMin * 60 * 1000) continue;

    device.offlineNotifiedAt = now;
    await device.save();
    await createNotification(
      device.user,
      'climate_offline',
      `Sensor offline: ${device.name}`,
      `No readings for ${Math.round(silentMs / 60000)} minutes${cellar ? ` from the sensor in "${cellar.name}"` : ''}. Check power and Wi-Fi.`,
      cellar ? `/cellars/${cellar._id}` : '/settings'
    );
    notified++;
  }

  return { checked: devices.length, notified };
}

module.exports = { runClimateOfflineCheck };
