const express = require('express');
const mongoose = require('mongoose');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const ClimateDevice = require('../models/ClimateDevice');
const ClimateReading = require('../models/ClimateReading');
const ApiToken = require('../models/ApiToken');
const Cellar = require('../models/Cellar');
const User = require('../models/User');
const { requireAuth } = require('../middleware/auth');
const { getCellarRole } = require('../utils/cellarAccess');
const { logAudit } = require('../services/audit');
const { createNotification } = require('../services/notifications');
const { effectiveClimateConfig, evaluateDeviceAlerts } = require('../services/climateAlerts');
const eventBus = require('../services/eventBus');
const rateLimitsConfig = require('../config/rateLimits');
const { rateLimitKey } = require('../utils/clientIp');

const { READING_TYPES, MAX_CHANNELS_PER_DEVICE, MAX_DEVICES_PER_USER, CHANNEL_KEY_RE } = ClimateDevice;
const { MAX_ACTIVE_TOKENS_PER_USER } = ApiToken;
const { CLIMATE_DEFAULTS } = Cellar;

// Ingest contract constants (docs/climate-monitoring.md - PUBLIC API:
// evolve additively only; renames/removals need a deprecation cycle).
const INGEST_MAX_READINGS = 100;
const VALUE_BOUNDS = {
  temperature: { min: -30, max: 60 },
  humidity: { min: 0, max: 100 },
};
const BACKFILL_MAX_MS = 48 * 60 * 60 * 1000; // oldest accepted reading ts
const FUTURE_SKEW_MS = 5 * 60 * 1000;        // newest accepted reading ts
// Advisory cadence echoed in the ingest response; clients MAY honor it.
const SUGGESTED_INTERVAL_S = Math.min(3600, Math.max(60,
  parseInt(process.env.CLIMATE_SUGGESTED_INTERVAL_S, 10) || 300));
// Daily per-device readings quota. The request limiter caps request COUNT but
// requests batch up to 100 readings - without this, a hostile token could
// still push ~576k rows/day. Normal use never sees it: 5-min cadence x
// 6 channels is ~1.7k/day; even 1-min x 14 channels stays under 20k.
const MAX_READINGS_PER_DAY = Math.max(100,
  parseInt(process.env.CLIMATE_MAX_READINGS_PER_DAY, 10) || 20000);

const isValidId = (id) => mongoose.isValidObjectId(id);

// Per-token limiter so one misbehaving device throttles itself, not the
// household's shared write budget. 60/15 min supports the fastest sane
// cadence (60 s = 15 posts/15 min) with 4x headroom.
const ingestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  keyGenerator: (req) => (req.apiToken ? `tok:${req.apiToken.id}` : rateLimitKey(req)),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    logAudit(req, 'system.rate_limit_exceeded', {}, { limiter: 'climate_ingest', limit: 60 });
    res.status(429).json({ error: 'Too many ingest requests, slow down' });
  },
});

// Device creation confirms the account password (it mints a durable
// credential) - same guessing-surface budget as login (see routes/tokens.js).
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: () => rateLimitsConfig.get().auth.max,
  keyGenerator: (req) => rateLimitKey(req),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    logAudit(req, 'system.rate_limit_exceeded', {}, { limiter: 'auth', limit: rateLimitsConfig.get().auth.max });
    res.status(429).json({ error: 'Too many attempts, please try again later' });
  },
});

// ---------------------------------------------------------------------------
// POST /api/climate/ingest - the open ingest contract. Auth: climate-scoped
// device token ONLY (the scope allowlist admits tokens here; JWT sessions are
// rejected below because ingest resolves the device from the token identity).
// ---------------------------------------------------------------------------
router.post('/ingest', requireAuth, ingestLimiter, async (req, res) => {
  if (!req.apiToken) {
    return res.status(403).json({ error: 'Ingest requires a climate device token (create one under Settings -> Climate devices)' });
  }

  try {
    const device = await ClimateDevice.findOne({ token: req.apiToken.id });
    if (!device) {
      return res.status(404).json({ error: 'No climate device is bound to this token' });
    }

    const { readings, firmware, rssi } = req.body || {};
    if (!Array.isArray(readings) || readings.length === 0 || readings.length > INGEST_MAX_READINGS) {
      return res.status(400).json({ error: `readings must be an array of 1-${INGEST_MAX_READINGS} entries` });
    }

    const now = new Date();
    const docs = [];
    const docIndices = []; // reading index of each docs[] entry, for quota errors
    const errors = [];
    const pushError = (index, reason) => { if (errors.length < 10) errors.push({ index, reason }); };
    // Newest accepted reading per (key, type), for the last-value cache.
    const newest = new Map();

    // Daily quota - reset on UTC date change, enforced before any insert.
    const today = now.toISOString().slice(0, 10);
    if (device.dailyReadingDate !== today) {
      device.dailyReadingDate = today;
      device.dailyReadingCount = 0;
    }
    const quotaRemaining = MAX_READINGS_PER_DAY - device.dailyReadingCount;
    if (quotaRemaining <= 0) {
      // Still liveness - a quota-blocked device is not an offline device.
      device.lastSeenAt = now;
      await device.save();
      return res.status(429).json({ error: 'Daily reading quota reached for this device - resumes at midnight UTC', intervalS: SUGGESTED_INTERVAL_S });
    }

    for (let i = 0; i < readings.length; i++) {
      const r = readings[i];
      const reject = (reason) => pushError(i, reason);

      if (!r || typeof r !== 'object') { reject('not_an_object'); continue; }
      if (typeof r.channel !== 'string' || !CHANNEL_KEY_RE.test(r.channel)) { reject('invalid_channel'); continue; }
      if (!READING_TYPES.includes(r.type)) { reject('invalid_type'); continue; }
      if (typeof r.value !== 'number' || !Number.isFinite(r.value)) { reject('invalid_value'); continue; }

      let ts = now;
      if (r.ts !== undefined && r.ts !== null) {
        ts = new Date(r.ts);
        if (Number.isNaN(ts.getTime())) { reject('invalid_ts'); continue; }
        const delta = now.getTime() - ts.getTime();
        if (delta > BACKFILL_MAX_MS) { reject('ts_too_old'); continue; }
        if (delta < -FUTURE_SKEW_MS) { reject('ts_in_future'); continue; }
      }

      let channel = device.findChannel(r.channel, r.type);
      if (!channel) {
        if (device.channels.length >= MAX_CHANNELS_PER_DEVICE) { reject('channel_limit'); continue; }
        device.channels.push({ key: r.channel, type: r.type });
        channel = device.channels[device.channels.length - 1];
      }

      const value = r.value + (channel.calibrationOffset || 0);
      const bounds = VALUE_BOUNDS[r.type];
      if (value < bounds.min || value > bounds.max) { reject('out_of_bounds'); continue; }

      docs.push({ ts, meta: { device: device._id, channel: r.channel, type: r.type }, value });
      docIndices.push(i);

      const mapKey = `${r.channel} ${r.type}`;
      const prev = newest.get(mapKey);
      if (!prev || ts > prev.ts) newest.set(mapKey, { ts, value });
    }

    // Trim to the remaining quota; the overflow counts as rejected.
    if (docs.length > quotaRemaining) {
      for (let k = quotaRemaining; k < docs.length; k++) pushError(docIndices[k], 'daily_quota');
      docs.length = quotaRemaining;
    }
    device.dailyReadingCount += docs.length;

    if (docs.length > 0) {
      await ClimateReading.insertMany(docs, { ordered: false });
    }

    // Device bookkeeping - one save covers liveness, caches, and alert state.
    device.lastSeenAt = now;
    if (typeof rssi === 'number' && Number.isFinite(rssi)) device.lastRssi = rssi;
    if (typeof firmware === 'string' && firmware.trim()) device.firmware = firmware.trim().slice(0, 100);
    for (const [mapKey, entry] of newest) {
      const sep = mapKey.indexOf(' ');
      const channel = device.findChannel(mapKey.slice(0, sep), mapKey.slice(sep + 1));
      if (channel && (!channel.lastValueAt || entry.ts > channel.lastValueAt)) {
        channel.lastValue = entry.value;
        channel.lastValueAt = entry.ts;
      }
    }

    // Back-online recovery for a silence the offline cron already notified.
    const wasOffline = !!device.offlineNotifiedAt;
    if (wasOffline) device.offlineNotifiedAt = null;

    // Threshold alerts against the assigned cellar (if any).
    let notifications = [];
    let cellar = null;
    if (device.cellar) {
      cellar = await Cellar.findOne({ _id: device.cellar, deletedAt: null }).select('name climate user');
    }
    notifications = evaluateDeviceAlerts(device, cellar, now);

    await device.save();

    const link = cellar ? `/cellars/${cellar._id}` : '/settings';
    if (wasOffline) {
      createNotification(device.user, 'climate_recovered', `Sensor back online: ${device.name}`,
        'The sensor is posting readings again.', link).catch(() => {});
    }
    for (const n of notifications) {
      createNotification(device.user, n.type, n.title, n.message, link).catch(() => {});
    }

    // Nudge any open SSE streams (no data - clients refresh via REST).
    eventBus.emit(device.user, 'climate', { device: device._id.toString() });

    res.status(202).json({
      accepted: docs.length,
      rejected: readings.length - docs.length,
      ...(errors.length > 0 ? { errors } : {}),
      intervalS: SUGGESTED_INTERVAL_S,
    });
  } catch (error) {
    console.error('Climate ingest error:', error);
    res.status(500).json({ error: 'Failed to store readings' });
  }
});

// ---------------------------------------------------------------------------
// Device management - JWT sessions only. None of these routes are in the token
// scope allowlist, so a device token can never list, mint, or delete devices.
// ---------------------------------------------------------------------------

const deviceResponse = (device, tokenLastUsedAt = undefined) => ({
  id: device._id,
  name: device.name,
  cellar: device.cellar
    ? (device.cellar.name !== undefined
      ? { id: device.cellar._id, name: device.cellar.name }
      : { id: device.cellar })
    : null,
  channels: (device.channels || []).map(c => ({
    key: c.key,
    type: c.type,
    label: c.label || '',
    calibrationOffset: c.calibrationOffset || 0,
    lastValue: c.lastValue ?? null,
    lastValueAt: c.lastValueAt ?? null,
    alertState: c.alertState || 'ok',
  })),
  firmware: device.firmware || '',
  lastSeenAt: device.lastSeenAt,
  lastRssi: device.lastRssi ?? null,
  offlineNotifiedAt: device.offlineNotifiedAt ?? null,
  createdAt: device.createdAt,
  ...(tokenLastUsedAt !== undefined ? { tokenLastUsedAt } : {}),
});

// GET /api/climate/devices - the caller's devices
router.get('/devices', requireAuth, async (req, res) => {
  try {
    const devices = await ClimateDevice.find({ user: req.user.id })
      .sort({ createdAt: -1 })
      .populate('cellar', 'name')
      .populate('token', 'lastUsedAt');
    res.json({
      devices: devices.map(d => deviceResponse(d, d.token?.lastUsedAt ?? null)),
      maxDevices: MAX_DEVICES_PER_USER,
    });
  } catch (error) {
    console.error('List climate devices error:', error);
    res.status(500).json({ error: 'Failed to list devices' });
  }
});

// Validate an optional cellar assignment: must exist, not be deleted, and the
// caller must be its owner or an editor member.
async function resolveAssignableCellar(cellarId, userId) {
  if (!isValidId(cellarId)) return { error: 'Invalid cellar id' };
  const cellar = await Cellar.findOne({ _id: cellarId, deletedAt: null });
  const role = cellar && getCellarRole(cellar, userId);
  if (!role || (role !== 'owner' && role !== 'editor')) return { error: 'Cellar not found' };
  return { cellar };
}

// POST /api/climate/devices - create a device + mint its climate token
// (plaintext shown ONCE). Password-confirmed like POST /api/tokens.
router.post('/devices', requireAuth, authLimiter, async (req, res) => {
  const { name, cellarId, password } = req.body || {};

  if (!name || typeof name !== 'string' || !name.trim() || name.trim().length > 100) {
    return res.status(400).json({ error: 'Device name is required (max 100 characters)' });
  }
  if (!password || typeof password !== 'string') {
    return res.status(400).json({ error: 'Password confirmation is required' });
  }

  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      logAudit(req, 'climate.device.create_failed', { type: 'user', id: user._id }, { reason: 'incorrect_password' });
      // 403, NOT 401 - see routes/tokens.js for why (apiFetch silently
      // refreshes and re-submits on 401).
      return res.status(403).json({ error: 'Password is incorrect' });
    }

    const deviceCount = await ClimateDevice.countDocuments({ user: req.user.id });
    if (deviceCount >= MAX_DEVICES_PER_USER) {
      return res.status(400).json({ error: `Maximum of ${MAX_DEVICES_PER_USER} climate devices reached - delete one first` });
    }
    const tokenCount = await ApiToken.countDocuments({ user: req.user.id, revokedAt: null });
    if (tokenCount >= MAX_ACTIVE_TOKENS_PER_USER) {
      return res.status(400).json({ error: `Maximum of ${MAX_ACTIVE_TOKENS_PER_USER} active API tokens reached - revoke one first (each device uses one token)` });
    }

    let cellar = null;
    if (cellarId) {
      const resolved = await resolveAssignableCellar(cellarId, req.user.id);
      if (resolved.error) return res.status(400).json({ error: resolved.error });
      cellar = resolved.cellar;
    }

    const deviceName = name.trim();
    const rawToken = ApiToken.generateToken();
    const token = await ApiToken.create({
      user: req.user.id,
      name: `Climate device: ${deviceName}`.slice(0, 100),
      tokenHash: ApiToken.hashToken(rawToken),
      scopes: ['climate'],
    });

    let device;
    try {
      device = await ClimateDevice.create({
        user: req.user.id,
        cellar: cellar ? cellar._id : null,
        name: deviceName,
        token: token._id,
      });
    } catch (err) {
      // Never leave an orphaned live credential behind a failed device insert.
      await ApiToken.deleteOne({ _id: token._id }).catch(() => {});
      throw err;
    }

    logAudit(req, 'climate.device.created', { type: 'climateDevice', id: device._id },
      { name: device.name, cellar: cellar ? cellar._id : null, tokenId: token._id });

    res.status(201).json({
      device: deviceResponse(device),
      token: rawToken, // shown once; only the SHA-256 is stored
    });
  } catch (error) {
    console.error('Create climate device error:', error);
    res.status(500).json({ error: 'Failed to create device' });
  }
});

// PUT /api/climate/devices/:id - rename, (un)assign cellar, edit channel
// labels/calibration. Channels are created by ingest, not here.
router.put('/devices/:id', requireAuth, async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(404).json({ error: 'Device not found' });
    const device = await ClimateDevice.findOne({ _id: req.params.id, user: req.user.id });
    if (!device) {
      return res.status(404).json({ error: 'Device not found' });
    }

    const { name, cellarId, channels } = req.body || {};

    if (name !== undefined) {
      if (typeof name !== 'string' || !name.trim() || name.trim().length > 100) {
        return res.status(400).json({ error: 'Device name is required (max 100 characters)' });
      }
      device.name = name.trim();
    }

    if (cellarId !== undefined) {
      if (cellarId === null || cellarId === '') {
        device.cellar = null;
      } else {
        const resolved = await resolveAssignableCellar(cellarId, req.user.id);
        if (resolved.error) return res.status(400).json({ error: resolved.error });
        device.cellar = resolved.cellar._id;
      }
    }

    if (channels !== undefined) {
      if (!Array.isArray(channels)) return res.status(400).json({ error: 'channels must be an array' });
      for (const c of channels) {
        if (!c || typeof c !== 'object') return res.status(400).json({ error: 'Invalid channel entry' });
        const channel = device.findChannel(c.key, c.type);
        if (!channel) return res.status(400).json({ error: `Unknown channel: ${c.key} (${c.type})` });
        if (c.label !== undefined) {
          if (typeof c.label !== 'string' || c.label.length > 100) return res.status(400).json({ error: 'Channel label too long' });
          channel.label = c.label.trim();
        }
        if (c.calibrationOffset !== undefined) {
          const off = Number(c.calibrationOffset);
          if (!Number.isFinite(off) || off < -10 || off > 10) return res.status(400).json({ error: 'Calibration offset must be between -10 and 10' });
          channel.calibrationOffset = off;
        }
      }
    }

    await device.save();
    logAudit(req, 'climate.device.updated', { type: 'climateDevice', id: device._id }, { name: device.name, cellar: device.cellar });

    res.json({ device: deviceResponse(device) });
  } catch (error) {
    if (error.name === 'CastError') return res.status(404).json({ error: 'Device not found' });
    console.error('Update climate device error:', error);
    res.status(500).json({ error: 'Failed to update device' });
  }
});

// DELETE /api/climate/devices/:id - revoke the token, drop its readings,
// remove the device. Readings die with the device (documented behavior).
router.delete('/devices/:id', requireAuth, async (req, res) => {
  try {
    if (!isValidId(req.params.id)) return res.status(404).json({ error: 'Device not found' });
    const device = await ClimateDevice.findOne({ _id: req.params.id, user: req.user.id });
    if (!device) {
      return res.status(404).json({ error: 'Device not found' });
    }

    await ApiToken.updateOne({ _id: device.token }, { $set: { revokedAt: new Date() } });
    eventBus.dropToken(device.token);
    await ClimateReading.deleteMany({ 'meta.device': device._id });
    await device.deleteOne();

    logAudit(req, 'climate.device.deleted', { type: 'climateDevice', id: device._id }, { name: device.name });

    res.json({ message: 'Device deleted' });
  } catch (error) {
    console.error('Delete climate device error:', error);
    res.status(500).json({ error: 'Failed to delete device' });
  }
});

// ---------------------------------------------------------------------------
// Cellar-facing reads (any cellar role) + threshold config (owner only)
// ---------------------------------------------------------------------------

// Load a cellar the caller can at least view, or null.
async function loadViewableCellar(cellarId, userId) {
  if (!isValidId(cellarId)) return null;
  const cellar = await Cellar.findOne({ _id: cellarId, deletedAt: null });
  if (!cellar || !getCellarRole(cellar, userId)) return null;
  return cellar;
}

// GET /api/climate/cellars/:cellarId/current - live snapshot from the
// last-value cache (no readings query).
router.get('/cellars/:cellarId/current', requireAuth, async (req, res) => {
  try {
    const cellar = await loadViewableCellar(req.params.cellarId, req.user.id);
    if (!cellar) return res.status(404).json({ error: 'Cellar not found' });

    const cfg = effectiveClimateConfig(cellar);
    const devices = await ClimateDevice.find({ cellar: cellar._id }).lean();
    const now = Date.now();

    res.json({
      config: cfg,
      isOwner: cellar.user.toString() === req.user.id.toString(),
      devices: devices.map(d => ({
        ...deviceResponse(d),
        online: !!d.lastSeenAt && (now - new Date(d.lastSeenAt).getTime()) < cfg.offlineAfterMin * 60 * 1000,
      })),
    });
  } catch (error) {
    console.error('Climate current error:', error);
    res.status(500).json({ error: 'Failed to load climate data' });
  }
});

// GET /api/climate/cellars/:cellarId/readings?range=24h|7d|30d|1y
// Server-side bucketing keeps every range at a few hundred points.
const RANGES = {
  '24h': { ms: 24 * 3600 * 1000, bucketMinutes: 5 },
  '7d': { ms: 7 * 24 * 3600 * 1000, bucketMinutes: 60 },
  '30d': { ms: 30 * 24 * 3600 * 1000, bucketMinutes: 360 },
  '1y': { ms: 365 * 24 * 3600 * 1000, bucketMinutes: 1440 },
};

router.get('/cellars/:cellarId/readings', requireAuth, async (req, res) => {
  try {
    const cellar = await loadViewableCellar(req.params.cellarId, req.user.id);
    if (!cellar) return res.status(404).json({ error: 'Cellar not found' });

    const range = RANGES[req.query.range] ? req.query.range : '24h';
    const { ms, bucketMinutes } = RANGES[range];
    const since = new Date(Date.now() - ms);

    const devices = await ClimateDevice.find({ cellar: cellar._id }).select('name').lean();
    if (devices.length === 0) {
      return res.json({ range, bucketMinutes, since, series: [] });
    }
    const nameById = new Map(devices.map(d => [d._id.toString(), d.name]));

    const rows = await ClimateReading.aggregate([
      { $match: { 'meta.device': { $in: devices.map(d => d._id) }, ts: { $gte: since } } },
      {
        $group: {
          _id: {
            device: '$meta.device',
            channel: '$meta.channel',
            type: '$meta.type',
            t: { $dateTrunc: { date: '$ts', unit: 'minute', binSize: bucketMinutes } },
          },
          min: { $min: '$value' },
          max: { $max: '$value' },
          avg: { $avg: '$value' },
        },
      },
      { $sort: { '_id.t': 1 } },
    ]);

    const seriesByKey = new Map();
    for (const row of rows) {
      const deviceId = row._id.device.toString();
      const key = `${deviceId} ${row._id.channel} ${row._id.type}`;
      let series = seriesByKey.get(key);
      if (!series) {
        series = {
          deviceId,
          deviceName: nameById.get(deviceId) || '',
          channel: row._id.channel,
          type: row._id.type,
          points: [],
        };
        seriesByKey.set(key, series);
      }
      series.points.push({
        t: row._id.t,
        min: Number(row.min.toFixed(2)),
        max: Number(row.max.toFixed(2)),
        avg: Number(row.avg.toFixed(2)),
      });
    }

    res.json({ range, bucketMinutes, since, series: [...seriesByKey.values()] });
  } catch (error) {
    console.error('Climate readings error:', error);
    res.status(500).json({ error: 'Failed to load readings' });
  }
});

// PUT /api/climate/cellars/:cellarId/config - thresholds + alert toggle.
// Owner only, matching the cellar PUT's owner-scoped-findOne house style.
router.put('/cellars/:cellarId/config', requireAuth, async (req, res) => {
  try {
    if (!isValidId(req.params.cellarId)) return res.status(404).json({ error: 'Cellar not found' });
    const cellar = await Cellar.findOne({ _id: req.params.cellarId, user: req.user.id, deletedAt: null });
    if (!cellar) return res.status(404).json({ error: 'Cellar not found' });

    const body = req.body || {};
    const cfg = effectiveClimateConfig(cellar);

    const numeric = [
      ['tempMin', -30, 60], ['tempMax', -30, 60],
      ['rhMin', 0, 100], ['rhMax', 0, 100],
      ['offlineAfterMin', 15, 1440],
    ];
    for (const [key, min, max] of numeric) {
      if (body[key] === undefined) continue;
      const v = Number(body[key]);
      if (!Number.isFinite(v) || v < min || v > max) {
        return res.status(400).json({ error: `${key} must be a number between ${min} and ${max}` });
      }
      cfg[key] = v;
    }
    if (body.alertsEnabled !== undefined) {
      if (typeof body.alertsEnabled !== 'boolean') return res.status(400).json({ error: 'alertsEnabled must be a boolean' });
      cfg.alertsEnabled = body.alertsEnabled;
    }
    if (cfg.tempMin >= cfg.tempMax) return res.status(400).json({ error: 'tempMin must be below tempMax' });
    if (cfg.rhMin >= cfg.rhMax) return res.status(400).json({ error: 'rhMin must be below rhMax' });

    cellar.climate = cfg;
    await cellar.save();

    logAudit(req, 'climate.config.updated', { type: 'cellar', id: cellar._id, cellarId: cellar._id }, cfg);

    res.json({ config: cfg });
  } catch (error) {
    console.error('Update climate config error:', error);
    res.status(500).json({ error: 'Failed to update climate settings' });
  }
});

module.exports = router;
module.exports.INGEST_MAX_READINGS = INGEST_MAX_READINGS;
module.exports.VALUE_BOUNDS = VALUE_BOUNDS;
module.exports.MAX_READINGS_PER_DAY = MAX_READINGS_PER_DAY;
module.exports.CLIMATE_DEFAULTS = CLIMATE_DEFAULTS;
