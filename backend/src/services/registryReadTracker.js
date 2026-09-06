/**
 * Distinct-wines-per-reader-per-day counter (registry lockdown 2026-09-06,
 * layer L4). See models/RegistryReadDay.js for what it measures and why.
 *
 * Two operations:
 *   recordRead(reader, wineId)  — count one read; returns the reader's
 *                                 distinct total for today (never throws —
 *                                 a counter must not break a wine page).
 *   gateAnonymousRead(req, wineId) — record AND refuse an anonymous reader
 *                                 who has passed the daily distinct cap.
 *
 * Members are recorded but never refused here: the daily report
 * (registryReadReportJob) tells an admin about unusual member volume, and
 * adding bottles must never get harder. Verified search crawlers never reach
 * the gated routes (nginx routes them to the crawler renderer, which only
 * records), so Googlebot walking the sitemap is counted, not blocked.
 */
const mongoose = require('mongoose');
const RegistryReadDay = require('../models/RegistryReadDay');
const rateLimitsConfig = require('../config/rateLimits');
const { rateLimitKey } = require('../utils/clientIp');
const { logAudit } = require('./audit');

const dayKey = (d = new Date()) => d.toISOString().slice(0, 10);

/** Who is reading: a signed-in user, else the /64-masked address. */
function readerFor(req) {
  const userId = req?.user?.id || req?.user?._id;
  if (userId) return { key: `user:${userId}`, kind: 'user' };
  return { key: `ip:${rateLimitKey(req)}`, kind: 'ip' };
}

/** A reader from an MCP context: the user, else the snapshot's address. */
function readerForMcp(ctx) {
  const userId = ctx?.user?.id || ctx?.user?._id;
  if (userId) return { key: `user:${userId}`, kind: 'user' };
  const ip = ctx?.req?.ip || 'unknown';
  return { key: `ip:${ip}`, kind: 'ip' };
}

function limits() {
  const cfg = rateLimitsConfig.get().registryRead || {};
  return {
    anonymousDailyDistinct: cfg.anonymousDailyDistinct ?? 300,
    memberAlertDistinct: cfg.memberAlertDistinct ?? 1000,
  };
}

/**
 * @returns {Promise<{distinct:number, count:number, blockedAt:Date|null}|null>}
 *   null when the counter could not be written (fail open).
 */
async function recordRead(reader, wineId) {
  if (!reader || !wineId) return null;
  // No database, no counter (fail open, and fast): a disconnected model would
  // otherwise buffer the write until Mongoose's timeout and stall the read.
  if (mongoose.connection.readyState !== 1) return null;
  const day = dayKey();
  const expiresAt = new Date(Date.now() + RegistryReadDay.RETENTION_DAYS * 86400e3);
  try {
    const row = await RegistryReadDay.findOneAndUpdate(
      { readerKey: reader.key, day },
      {
        $addToSet: { wines: wineId },
        $inc: { count: 1 },
        $setOnInsert: { kind: reader.kind, expiresAt },
      },
      { upsert: true, new: true, projection: { wines: 1, count: 1, blockedAt: 1 } }
    ).lean();
    return { distinct: Array.isArray(row?.wines) ? row.wines.length : 0, count: row?.count || 0, blockedAt: row?.blockedAt || null };
  } catch (err) {
    console.error('[registryRead] counter write failed:', err.message);
    return null;
  }
}

/**
 * Record the read and decide whether an ANONYMOUS reader may have it.
 * @returns {Promise<{allowed:boolean, distinct:number}>}
 */
async function gateAnonymousRead(req, wineId) {
  const reader = readerFor(req);
  const res = await recordRead(reader, wineId);
  if (!res) return { allowed: true, distinct: 0 };
  if (reader.kind !== 'ip') return { allowed: true, distinct: res.distinct };
  const cap = limits().anonymousDailyDistinct;
  if (res.distinct <= cap) return { allowed: true, distinct: res.distinct };
  if (!res.blockedAt) {
    // First refusal of the day for this address: one audit row, not one per hit.
    try {
      await RegistryReadDay.updateOne({ readerKey: reader.key, day: dayKey(), blockedAt: null }, { $set: { blockedAt: new Date() } });
      logAudit(req, 'system.registry_read_cap', {}, { readerKey: reader.key, distinct: res.distinct, cap });
    } catch { /* audited best-effort */ }
  }
  return { allowed: false, distinct: res.distinct };
}

/**
 * The MCP twin of gateAnonymousRead: the anonymous /api/mcp/public surface is
 * capped per address, a signed-in connection is counted only.
 */
async function gateMcpRead(ctx, wineId) {
  const reader = readerForMcp(ctx);
  const res = await recordRead(reader, wineId);
  if (!res) return { allowed: true, distinct: 0 };
  if (reader.kind !== 'ip') return { allowed: true, distinct: res.distinct };
  const cap = limits().anonymousDailyDistinct;
  if (res.distinct <= cap) return { allowed: true, distinct: res.distinct };
  if (!res.blockedAt) {
    try {
      await RegistryReadDay.updateOne({ readerKey: reader.key, day: dayKey(), blockedAt: null }, { $set: { blockedAt: new Date() } });
      console.warn(`[registryRead] anonymous MCP reader ${reader.key} passed the daily distinct cap (${res.distinct} > ${cap})`);
    } catch { /* best-effort */ }
  }
  return { allowed: false, distinct: res.distinct };
}

/** The refusal body, shared by the routes that gate. */
const CAP_MESSAGE = 'Daily reading limit for anonymous access reached. Sign in to keep reading, or come back tomorrow.';

module.exports = { recordRead, gateAnonymousRead, gateMcpRead, readerFor, readerForMcp, limits, dayKey, CAP_MESSAGE };
