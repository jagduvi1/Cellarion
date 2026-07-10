const ClimateDevice = require('../models/ClimateDevice');
const { createNotification } = require('./notifications');
const { effectiveClimateConfig } = require('./climateAlerts');

// Sensor-offline detection, run from the scheduler every 15 minutes.
//
// A device is "offline" when it has posted before (lastSeenAt set) but has
// been silent longer than its cellar's offlineAfterMin. One notification per
// silence: offlineNotifiedAt marks it, and the ingest route clears the flag
// (with a recovery notification) when the device comes back. Devices that
// have NEVER posted are skipped — a freshly created device that was not set
// up yet is not an outage.
async function runClimateOfflineCheck(now = new Date()) {
  const devices = await ClimateDevice.find({
    lastSeenAt: { $ne: null },
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
