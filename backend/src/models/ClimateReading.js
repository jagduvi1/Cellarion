const mongoose = require('mongoose');

// Raw climate telemetry, one document per (device, channel, type, timestamp).
// Backed by a MongoDB TIME-SERIES collection (Mongo 7): columnar compression
// keeps a device-year (~420k readings at 5-min cadence) down to a few MB, and
// retention is enforced by the collection's TTL.
//
// Notes that matter when touching this model:
// - meta.device is a plain ObjectId (NOT ref: 'User') — GDPR purge/export run
//   through the ClimateDevice registry entry, which owns the device→user link.
// - Time-series collections have no unique indexes; duplicate (device,
//   channel, ts) rows are possible after a device retry and are tolerated —
//   chart queries aggregate per time bucket, so dupes cannot skew the UI.
// - expireAfterSeconds is applied when the collection is CREATED. Changing
//   CLIMATE_RETENTION_DAYS on an existing deployment needs a manual collMod:
//   db.runCommand({ collMod: 'climatereadings', expireAfterSeconds: <new> })
// - Deletes must filter on meta fields only (metaField-scoped deletes are the
//   ones time-series collections support across server versions).

const RETENTION_DAYS = Math.max(1, parseInt(process.env.CLIMATE_RETENTION_DAYS, 10) || 730);

const climateReadingSchema = new mongoose.Schema({
  ts: { type: Date, required: true },
  meta: {
    device: { type: mongoose.Schema.Types.ObjectId, required: true },
    channel: { type: String, required: true },
    type: { type: String, enum: ['temperature', 'humidity'], required: true },
  },
  value: { type: Number, required: true },
}, {
  timeseries: {
    timeField: 'ts',
    metaField: 'meta',
    granularity: 'minutes',
  },
  expireAfterSeconds: RETENTION_DAYS * 24 * 60 * 60,
  versionKey: false,
});

// The auto-created time-series index is on the whole metaField ({meta:1, ts:1})
// and cannot serve dotted `meta.device` predicates, so the per-device history
// aggregation and the device-deletion deleteMany would otherwise scan buckets
// across ALL devices. A secondary index on the metaField subfield fixes both
// (supported on Mongo 7 time-series collections).
climateReadingSchema.index({ 'meta.device': 1, ts: 1 });

module.exports = mongoose.model('ClimateReading', climateReadingSchema);
module.exports.RETENTION_DAYS = RETENTION_DAYS;
