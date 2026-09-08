const mongoose = require('mongoose');
const BridgeKey = require('../models/BridgeKey');
const BridgeUsageDay = require('../models/BridgeUsageDay');
const rateLimitsConfig = require('../config/rateLimits');

/**
 * Daily quotas per Registry Bridge key (REGISTRY_LOCKDOWN_PLAN §6).
 *
 * The numbers are generous for a household and tight for a copier: 300 wine
 * fetches a day is a big cellar's whole import, and a full copy of the
 * registry would take a month of maximum use and show up in the readers
 * report every single day. Once a month the owner can open an import window
 * that multiplies every cap by five for 24 hours.
 *
 * Counting fails OPEN when the database is unreachable (the same choice as
 * services/registryReadTracker.js): a self-hoster adding a bottle should not
 * be refused because a counter could not be written.
 */
const QUOTAS = Object.freeze({
  searches: 600,
  fetches: 300,
  changeChecks: 1,
  contributions: 50,
});
const KINDS = Object.keys(QUOTAS);
const IMPORT_MULTIPLIER = 5;
const IMPORT_WINDOW_MS = 24 * 60 * 60 * 1000;
const IMPORT_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;

const dayKey = (d = new Date()) => d.toISOString().slice(0, 10);

/** Next UTC midnight — when the daily counters roll over. */
function resetAt(now = Date.now()) {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1));
}

function importWindowActive(keyDoc, now = Date.now()) {
  return !!(keyDoc?.importWindowUntil && new Date(keyDoc.importWindowUntil).getTime() > now);
}

/**
 * The caps in force right now: the admin-tuned `bridge` group of the runtime
 * config (Super-admin → Settings), falling back to QUOTAS above for anything
 * unset or nonsensical. Read per call so a change needs no restart.
 */
function capsNow() {
  const cfg = rateLimitsConfig.get().bridge || {};
  const caps = {};
  for (const kind of KINDS) {
    const v = cfg[kind];
    caps[kind] = Number.isInteger(v) && v > 0 ? v : QUOTAS[kind];
  }
  return caps;
}

function capFor(kind, keyDoc, now = Date.now()) {
  const base = capsNow()[kind];
  return importWindowActive(keyDoc, now) ? base * IMPORT_MULTIPLIER : base;
}

/**
 * Spend one unit of `kind` for the key. Returns { allowed, used, cap, resetAt }.
 * The counter is incremented first and compared after, so two concurrent
 * requests at the edge of a cap both count; a cap can be overshot by the
 * number of concurrent requests, never silently underspent.
 */
async function takeQuota(keyDoc, kind) {
  if (!KINDS.includes(kind)) throw new Error(`Unknown bridge quota kind: ${kind}`);
  const now = Date.now();
  const cap = capFor(kind, keyDoc, now);
  if (mongoose.connection.readyState !== 1) {
    return { allowed: true, used: 0, cap, resetAt: resetAt(now), counted: false };
  }
  try {
    const row = await BridgeUsageDay.findOneAndUpdate(
      { key: keyDoc._id, day: dayKey(new Date(now)) },
      {
        $inc: { [kind]: 1 },
        $setOnInsert: { user: keyDoc.user, expiresAt: new Date(now + BridgeUsageDay.RETENTION_DAYS * 86400e3) },
      },
      { upsert: true, new: true, projection: { [kind]: 1 } }
    ).lean();
    const used = row?.[kind] || 0;
    return { allowed: used <= cap, used, cap, resetAt: resetAt(now), counted: true };
  } catch (err) {
    console.error('[bridge] quota write failed:', err.message);
    return { allowed: true, used: 0, cap, resetAt: resetAt(now), counted: false };
  }
}

/** Today's spend against the caps, for the key page and GET /v1/me. */
async function usageFor(keyDoc, now = Date.now()) {
  const day = dayKey(new Date(now));
  let row = null;
  if (mongoose.connection.readyState === 1) {
    row = await BridgeUsageDay.findOne({ key: keyDoc._id, day }).lean().catch(() => null);
  }
  const used = {}; const caps = {};
  for (const kind of KINDS) {
    used[kind] = row?.[kind] || 0;
    caps[kind] = capFor(kind, keyDoc, now);
  }
  const openedAt = keyDoc.importWindowOpenedAt ? new Date(keyDoc.importWindowOpenedAt).getTime() : null;
  return {
    day,
    used,
    caps,
    resetAt: resetAt(now),
    importWindow: {
      active: importWindowActive(keyDoc, now),
      until: keyDoc.importWindowUntil || null,
      nextAvailableAt: openedAt && now - openedAt < IMPORT_COOLDOWN_MS ? new Date(openedAt + IMPORT_COOLDOWN_MS) : null,
    },
  };
}

/**
 * Open the ×5 window for 24 hours. Once per 30 days per key: the point is a
 * cellar import, not a standing raise. Returns { ok, until } or
 * { ok: false, nextAvailableAt }.
 */
async function openImportWindow(keyDoc, now = Date.now()) {
  const openedAt = keyDoc.importWindowOpenedAt ? new Date(keyDoc.importWindowOpenedAt).getTime() : null;
  if (openedAt && now - openedAt < IMPORT_COOLDOWN_MS) {
    return { ok: false, nextAvailableAt: new Date(openedAt + IMPORT_COOLDOWN_MS) };
  }
  const until = new Date(now + IMPORT_WINDOW_MS);
  await BridgeKey.updateOne({ _id: keyDoc._id }, { $set: { importWindowUntil: until, importWindowOpenedAt: new Date(now) } });
  return { ok: true, until };
}

/** Express middleware: spend one unit of `kind`, 429 with a reset time when over. */
function quota(kind) {
  return async (req, res, next) => {
    try {
      const r = await takeQuota(req.bridge.keyDoc, kind);
      res.set('X-Bridge-Quota-Kind', kind);
      res.set('X-Bridge-Quota-Remaining', String(Math.max(0, r.cap - r.used)));
      if (!r.allowed) {
        return res.status(429).json({
          error: `Daily bridge quota for ${kind} reached (${r.cap} per day). Resets at ${r.resetAt.toISOString()}.`,
          code: 'quota',
          kind,
          cap: r.cap,
          resetAt: r.resetAt,
        });
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = {
  QUOTAS, KINDS, IMPORT_MULTIPLIER, IMPORT_WINDOW_MS, IMPORT_COOLDOWN_MS,
  takeQuota, usageFor, openImportWindow, quota, capFor, capsNow, importWindowActive, resetAt, dayKey,
};
