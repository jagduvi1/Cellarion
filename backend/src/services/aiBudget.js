/**
 * Shared per-user daily AI budget + site-wide daily kill-switch.
 * (SECURITY_AUDIT_2026-07-08 M-2 / L-14.)
 *
 * One debit per actual Anthropic call across: import identify (per unique
 * wine that reaches the AI step), scan-label, identify-text, ai-info, and
 * user-triggered wine enrichment (enrichWineById with a budgetUserId).
 * Chat keeps its own separate quota (ChatUsage / aiConfig.chatDailyLimit).
 *
 * Debit/refund semantics mirror routes/chat.js exactly:
 *   - debit BEFORE the call, atomically ($inc is the gate — N concurrent
 *     requests at the limit can't all pass a check-then-increment),
 *   - refund on overshoot,
 *   - refund on Anthropic transport failure (thrown error, rate-limit, or an
 *     `exception:`/`no_api_key` debugReason from services/labelScan) — a call
 *     that completed but answered "unknown wine" stays debited.
 *
 * Knobs (admin-tunable via PATCH /api/admin/settings/rate-limits, cached in
 * config/rateLimits.js):
 *   aiDailyBudget.max     – per-user Anthropic calls per UTC day (0 = unlimited)
 *   aiGlobalDailyCap.max  – site-wide Anthropic calls per UTC day (0 = disabled)
 *
 * The global counter is a singleton AiUsage row per day with userId: null.
 */

const AiUsage = require('../models/AiUsage');
const rateLimitsConfig = require('../config/rateLimits');

// Same retention window as ChatUsage — keeps the usage history inspectable
// without retaining per-user metadata indefinitely (TTL index on expiresAt).
const RETENTION_DAYS = 90;

// Returns today's UTC date string 'YYYY-MM-DD'
function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

function expiresAt() {
  return new Date(Date.now() + RETENTION_DAYS * 24 * 60 * 60 * 1000);
}

// Seconds until the next UTC midnight — the budget window resets then.
// Used for the Retry-After header on 429 responses.
function secondsUntilMidnightUTC(now = new Date()) {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

/**
 * Atomic upsert-increment on the (userId, date) usage row.
 * A concurrent first-of-the-day upsert can lose the unique-index race with
 * E11000 — one retry then hits the existing document (same as chat.js).
 */
async function incUsage(userId, date, n) {
  try {
    return await AiUsage.findOneAndUpdate(
      { userId, date },
      { $inc: { count: n }, $setOnInsert: { expiresAt: expiresAt() } },
      { upsert: true, new: true }
    );
  } catch (err) {
    if (err.code !== 11000) throw err;
    return AiUsage.findOneAndUpdate({ userId, date }, { $inc: { count: n } }, { new: true });
  }
}

/**
 * Debit one Anthropic call against the user's daily budget AND the global
 * daily cap. The increment itself is the gate; overshoot is refunded.
 *
 * Returns:
 *   { ok: true,  refund }                                   — call may proceed
 *   { ok: false, reason: 'user_budget' | 'global_cap',
 *     retryAfterSeconds }                                    — over budget
 *
 * `refund()` is idempotent and reverses exactly what was debited — call it
 * when the Anthropic call fails at the transport level so a failed call
 * doesn't consume budget.
 */
async function tryDebitAi(userId) {
  const cfg = rateLimitsConfig.get();
  const budget    = cfg.aiDailyBudget?.max    ?? rateLimitsConfig.defaults.aiDailyBudget.max;
  const globalCap = cfg.aiGlobalDailyCap?.max ?? rateLimitsConfig.defaults.aiGlobalDailyCap.max;
  const date = todayUTC();
  const debited = { user: false, global: false };

  const refund = async () => {
    const u = debited.user;
    const g = debited.global;
    debited.user = false;
    debited.global = false;
    try {
      if (u) await incUsage(userId, date, -1);
      if (g) await incUsage(null, date, -1);
    } catch (err) {
      console.warn('[aiBudget] refund failed:', err.message);
    }
  };

  if (budget > 0) {
    const usage = await incUsage(userId, date, 1);
    debited.user = true;
    if (usage.count > budget) {
      await refund();
      return { ok: false, reason: 'user_budget', retryAfterSeconds: secondsUntilMidnightUTC() };
    }
  }

  if (globalCap > 0) {
    const global = await incUsage(null, date, 1);
    debited.global = true;
    if (global.count > globalCap) {
      await refund(); // reverses the global AND any user debit above
      return { ok: false, reason: 'global_cap', retryAfterSeconds: secondsUntilMidnightUTC() };
    }
  }

  return { ok: true, refund };
}

/**
 * True when a null-data result from services/labelScan represents a failure
 * that never produced a billable Anthropic completion — the debit should be
 * refunded. `ai_unknown:*` (the model answered but couldn't identify the
 * wine) is a real completed call and stays debited.
 */
function isRefundableFailure(debugReason) {
  if (!debugReason) return false;
  return debugReason === 'no_api_key'
    || debugReason === 'rate_limit_exceeded'
    || debugReason.startsWith('exception');
}

module.exports = { tryDebitAi, isRefundableFailure, todayUTC, secondsUntilMidnightUTC };
