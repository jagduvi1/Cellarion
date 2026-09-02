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
const User = require('../models/User');
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
 * The user's currently-active budget override, or null.
 *
 * Granted by an admin approving an AiBudgetRequest (written onto the User
 * document as `aiBudgetOverride: { max, expiresAt }`). An expired or
 * malformed override is treated as absent — no cleanup job needed. A DB
 * error also degrades to "no override" so the budget check never breaks an
 * AI call path.
 */
async function getActiveOverride(userId) {
  if (!userId) return null;
  try {
    const user = await User.findById(userId).select('aiBudgetOverride').lean();
    const o = user?.aiBudgetOverride;
    if (o && Number(o.max) > 0 && o.expiresAt && new Date(o.expiresAt) > new Date()) {
      return { max: Number(o.max), expiresAt: o.expiresAt };
    }
  } catch (err) {
    console.warn('[aiBudget] override lookup failed:', err.message);
  }
  return null;
}

/**
 * Effective per-user daily max: the admin-granted override while it is
 * active, otherwise the global aiDailyBudget config. A base of 0 means
 * unlimited — an override can only ever RAISE the limit, so it is ignored
 * when the site already runs unlimited.
 *
 * Returns { max, override } — override is { max, expiresAt } | null.
 */
async function getEffectiveDailyMax(userId) {
  const cfg = rateLimitsConfig.get();
  const base = cfg.aiDailyBudget?.max ?? rateLimitsConfig.defaults.aiDailyBudget.max;
  if (base === 0) return { max: 0, override: null };
  const override = await getActiveOverride(userId);
  // An override may only ever RAISE the limit (per the design comment above):
  // take max(base, override.max) so a stale/low grant can never LOWER a user
  // below the current base budget — e.g. when the admin-grant floor (100) sits
  // below the default base (500), or the base was raised after a small grant.
  // This is the single source of truth; the admin route's clamp is only a sane
  // input bound.
  return { max: override ? Math.max(base, override.max) : base, override };
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
async function tryDebitAi(userId, { isDemo = false } = {}) {
  // Ephemeral public-demo accounts get ZERO Anthropic spend: no per-user budget
  // and no draw on the shared global cap. The justification is SPEND, not
  // registry writes — throwaway accounts (no email, 3 per IP per hour, 2h TTL)
  // must never buy paid inference: ~40 demo sessions at the aiBurst rate would
  // drain the whole global daily cap. Do not weaken this on the grounds that a
  // given AI route no longer writes to the registry (identify-text became
  // read-only in 2026-08); the spend argument is independent of that, and this
  // check is also what keeps demo accounts out of identify-text entirely.
  // Registry writes are guarded separately, by requireNonDemo on POST
  // /api/wines/find-or-create. The UI surfaces AI features as "sign up to use";
  // a direct API call gets this clean denial (`code:'demo_disabled'`).
  if (isDemo) {
    return { ok: false, reason: 'demo_disabled', retryAfterSeconds: secondsUntilMidnightUTC() };
  }
  const cfg = rateLimitsConfig.get();
  // Effective per-user budget: an active admin-granted override wins over the
  // global default (getEffectiveDailyMax). The global cap is never overridden.
  const { max: budget } = await getEffectiveDailyMax(userId);
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
    || debugReason === 'prompt_too_long' // refused before any request was made
    || debugReason.startsWith('exception');
}

/**
 * Thrown-error counterpart of isRefundableFailure for services/labelScan's
 * scanLabelFull (which THROWS with an HTTP `status` rather than returning a
 * debugReason). A completed billable Claude vision call that could not read the
 * label throws 422 ("Could not read label" / "Could not identify wine from
 * label" — the analogue of a non-refundable `ai_unknown:*`). Everything else —
 * no API key (503), an unsupported/oversized image (400), or a transport/
 * network error from the SDK — never produced a billable completion and is
 * refundable. Mirrors the identify-text/ai-info policy: completed-but-unhelpful
 * stays debited; pre-completion/transport failures refund.
 */
function isRefundableScanError(err) {
  return err?.status !== 422;
}

/**
 * Debit ONLY the site-wide daily cap (not the per-user AI budget). Cellar chat
 * has its own per-user quota (ChatUsage / chatDailyLimit), so it must not also
 * consume the shared per-user AI budget — but it DOES need to count toward the
 * SuperAdmin kill-switch (aiGlobalDailyCap) so that the site-wide brake actually
 * bounds chat spend during an abuse event. Returns the same {ok, refund} shape
 * as tryDebitAi so callers refund on a failed/aborted call.
 */
async function tryDebitGlobalAi() {
  const cfg = rateLimitsConfig.get();
  const globalCap = cfg.aiGlobalDailyCap?.max ?? rateLimitsConfig.defaults.aiGlobalDailyCap.max;
  if (globalCap <= 0) return { ok: true, refund: async () => {} }; // cap disabled

  const date = todayUTC();
  const global = await incUsage(null, date, 1);
  if (global.count > globalCap) {
    await incUsage(null, date, -1);
    return { ok: false, reason: 'global_cap', retryAfterSeconds: secondsUntilMidnightUTC() };
  }

  let refunded = false;
  const refund = async () => {
    if (refunded) return;
    refunded = true;
    try { await incUsage(null, date, -1); } catch (err) { console.warn('[aiBudget] global refund failed:', err.message); }
  };
  return { ok: true, refund };
}

module.exports = { tryDebitAi, tryDebitGlobalAi, isRefundableFailure, isRefundableScanError, getEffectiveDailyMax, todayUTC, secondsUntilMidnightUTC };
