const mongoose = require('mongoose');

// A climate sensor client — the ESP32 reference design, a Home Assistant
// automation, or any HTTP poster — owned by one user and feeding readings
// into ClimateReading via POST /api/climate/ingest.
//
// Identity: the device's climate-scoped ApiToken (1:1). Ingest resolves the
// device FROM the authenticated token, so the payload carries no device id
// and cannot post as another device. Revoking the token cuts the device off.
//
// Channels are (key, type) pairs — one physical sensor commonly reports both
// a temperature and a humidity channel under the same key (e.g. "ambient").
// Unknown channels auto-register at ingest (capped) so adding a probe to the
// 1-Wire bus needs no UI step. Each channel caches its last value so cellar
// cards render without touching the readings collection, and carries its own
// alert hysteresis state (see services/climateAlerts.js).

const READING_TYPES = ['temperature', 'humidity'];
const MAX_CHANNELS_PER_DEVICE = 16;
const MAX_DEVICES_PER_USER = Math.max(1, parseInt(process.env.CLIMATE_MAX_DEVICES_PER_USER, 10) || 5);
const CHANNEL_KEY_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

const channelSchema = new mongoose.Schema({
  key: { type: String, required: true, trim: true, maxlength: 64 },
  type: { type: String, enum: READING_TYPES, required: true },
  label: { type: String, trim: true, maxlength: 100, default: '' },
  // Applied at ingest (stored value = raw + offset), so changing it only
  // affects future readings — history is never rewritten.
  calibrationOffset: { type: Number, default: 0, min: -10, max: 10 },
  lastValue: { type: Number, default: null },
  lastValueAt: { type: Date, default: null },
  // Alert hysteresis: breachedSince marks the first out-of-range reading of a
  // pending breach; alertState flips to 'breached' only once it has been
  // sustained (climateAlerts.SUSTAIN_MS) — and back to 'ok' on recovery.
  alertState: { type: String, enum: ['ok', 'breached'], default: 'ok' },
  breachedSince: { type: Date, default: null },
  lastAlertAt: { type: Date, default: null },
}, { _id: false });

const climateDeviceSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  // Which cellar the readings belong to. Nullable: a device can be created
  // (and post readings) before being assigned; unassigned readings are stored
  // but appear in no cellar view until assignment.
  cellar: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Cellar',
    default: null,
    index: true,
  },
  name: {
    type: String,
    required: [true, 'Device name is required'],
    trim: true,
    maxlength: [100, 'Device name too long'],
  },
  // The climate-scoped ApiToken this device authenticates with (1:1).
  token: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ApiToken',
    required: true,
    unique: true,
  },
  channels: { type: [channelSchema], default: [] },
  firmware: { type: String, trim: true, maxlength: 100, default: '' },
  lastSeenAt: { type: Date, default: null },
  lastRssi: { type: Number, default: null },
  // Set when the offline cron has notified for the current silence; cleared
  // (with a recovery notification) on the next successful ingest.
  offlineNotifiedAt: { type: Date, default: null },
  // Daily ingest quota bookkeeping (UTC date string) — bounds worst-case
  // storage abuse regardless of request cadence; see routes/climate.js.
  dailyReadingCount: { type: Number, default: 0 },
  dailyReadingDate: { type: String, default: null },
  createdAt: { type: Date, default: Date.now },
});

/** Find a device's channel entry by its (key, type) identity. */
climateDeviceSchema.methods.findChannel = function (key, type) {
  return this.channels.find(c => c.key === key && c.type === type);
};

module.exports = mongoose.model('ClimateDevice', climateDeviceSchema);
module.exports.READING_TYPES = READING_TYPES;
module.exports.MAX_CHANNELS_PER_DEVICE = MAX_CHANNELS_PER_DEVICE;
module.exports.MAX_DEVICES_PER_USER = MAX_DEVICES_PER_USER;
module.exports.CHANNEL_KEY_RE = CHANNEL_KEY_RE;
