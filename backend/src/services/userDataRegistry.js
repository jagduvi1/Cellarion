/**
 * User-data registry — the single source of truth for GDPR erasure and export.
 *
 * Every Mongoose model that stores user-linked data has exactly ONE entry in
 * REGISTRY describing how it is (a) purged when an account is deleted and (b)
 * exported for data portability. Both `purgeUserData` and the `/me/export`
 * route are driven off this table, so a model can never be handled on one side
 * and silently forgotten on the other. A regression test
 * (userDataRegistry.test.js) asserts that every model with a `ref: 'User'`
 * field appears in REGISTRY or in EXCLUDED — so adding a new user-linked model
 * fails the build until it is registered.
 *
 * The entries live in services/userData/, one module per domain. REGISTRY puts
 * them together in a fixed order: the erasure runs and the export merges in
 * that order, and userDataRegistry.shape.test.js pins it.
 *   accountAndCellar     the account, cellars, racks, bottles, lists, personal data
 *   community            forum, reviews, follows, recommendations, journal, notifications
 *   requests             wine requests and reports, corrections, owner questions, support
 *   credentialsAndUsage  keys and tokens, ledgers, imports, usage counters, invites
 *   sharedRegistry       contributions to shared data, where the contributor reference goes
 * The audit log's entry stays in this file, beside its scrub. A new model gets
 * its entry in the module of its domain.
 *
 * Entry shape:
 *   model        Mongoose model (its .modelName drives the completeness test)
 *   category     personal-data | shared-content | creator-ref | via-cellar
 *   userFields   field paths that link to User (documentation + test reference)
 *   purge(ctx)   returns a Mongoose op promise or array of them (run in the
 *                deletion Promise.all), or null when intentionally not purged
 *   prePurge(ctx)   optional op run BEFORE the batch (sees the data as it was;
 *                may leave what postPurge needs on ctx)
 *   postPurge(ctx)  optional op run AFTER the batch (sees the batch's results)
 *   note         why purge/export is null, when applicable
 *   exportFragment(ctx)  async fn returning a plain object merged (deep) into
 *                the export payload, or null when intentionally not exported
 *
 * ctx = { userId, userEmail, cellarIds, deletedUserId, user, EXPORT_MAX,
 *         AUDIT_MAX, truncated }
 */
const Cellar = require('../models/Cellar');
const AuditLog = require('../models/AuditLog');
const { getOrCreateDeletedUser } = require('../utils/deletedUser');
const { EXPORT_MAX, AUDIT_MAX, markTrunc } = require('./userData/shared');

/**
 * Models with a user reference that are intentionally NOT purged/exported here,
 * with the reason. Keeps the completeness test honest: each is a conscious
 * decision, not an oversight. Items marked "follow-up" are tracked gaps.
 */
const EXCLUDED = {
  // No user reference at all.
  ExchangeRateSnapshot: 'no user reference (daily FX rates)',
  StripeWebhookEvent: 'no user reference (idempotency ledger, TTL)',
  WineEmbedding: 'no user reference (references WineDefinition only)',
  WineNotDuplicate: 'no user reference (admin-confirmed distinct wine pairs; actor in AuditLog)',
  ClimateReading: 'no user reference (telemetry keyed by meta.device; purged + exported via the ClimateDevice entry)',
  OAuthClient: 'no user reference (a DCR-registered connector, not personal data — it is registered pre-login and shared across whoever connects it; the per-user tokens it mints live on ApiToken)',
  McpUsageStat: 'no user reference (aggregate per-day MCP usage counters, 180-day TTL)',
  BackupStatus: 'no user reference (singleton backup health/status doc, not personal data)',
  CommunityWinePrice: 'no user reference (k-anonymised aggregate community prices; never an individual\'s purchase)',
};

// Audit rows ABOUT an account (resource = the user). Sign-up, e-mail
// verification and sign-in (and their failures) happen before anyone is
// signed in: the row has no actor, the account sits in resource.id, and the
// detail carries { username, email } — the actor scrub never matched them, so
// a deleted account's name, address and IP stayed in those rows. Admin and
// other members' actions on the account lose the account's id and name too,
// but keep THEIR IP and browser: those belong to whoever acted. A pipeline
// update, so that choice is made per row.
const actorless = { $eq: [{ $ifNull: ['$actor.userId', null] }, null] };
const scrubAuditRowsAbout = (userId) => AuditLog.updateMany(
  { 'resource.type': 'user', 'resource.id': userId },
  [
    { $set: {
      'resource.id': null,
      'actor.ipAddress': { $cond: [actorless, null, '$actor.ipAddress'] },
      userAgent: { $cond: [actorless, '$$REMOVE', '$userAgent'] },
    } },
    { $unset: ['detail.email', 'detail.username'] },
  ]
);

const REGISTRY = [
  ...require('./userData/accountAndCellar'),
  ...require('./userData/community'),
  ...require('./userData/requests'),
  ...require('./userData/credentialsAndUsage'),
  ...require('./userData/sharedRegistry'),

  // ── Audit log: keep for compliance, anonymise the actor ─────────────────
  {
    model: AuditLog, category: 'personal-data', userFields: ['actor.userId'],
    // Also scrub identifier PII the free-form detail can carry — registration/
    // login events embed { username, email }, and cellar-sharing events embed
    // the invitee's address as { sharedWith } / { invitedEmail } (L-15). $unset
    // only touches docs that actually have those keys, so it's safe across the
    // heterogeneous detail shapes.
    purge: (ctx) => [
      // (a) The departing user as the ACTOR of their own events.
      AuditLog.updateMany(
        { 'actor.userId': ctx.userId },
        {
          $set: { 'actor.userId': null, 'actor.ipAddress': null },
          $unset: { 'detail.email': '', 'detail.username': '', 'detail.sharedWith': '', 'detail.invitedEmail': '', userAgent: '' },
        }
      ),
      // (b) The departing user as the SUBJECT of ANOTHER actor's event — a
      // cellar-share event stores the invitee's email in the INVITER's row
      // (detail.sharedWith / detail.invitedEmail). The actor-scoped scrub above
      // never touches those, so match on the departing user's email instead.
      ...(ctx.userEmail ? [AuditLog.updateMany(
        { $or: [{ 'detail.sharedWith': ctx.userEmail }, { 'detail.invitedEmail': ctx.userEmail }] },
        { $unset: { 'detail.sharedWith': '', 'detail.invitedEmail': '' } }
      )] : []),
      // (c) The departing user as the account an event is ABOUT.
      scrubAuditRowsAbout(ctx.userId),
    ],
    // Again after the batch: a sign-in logged while the batch ran (logAudit is
    // fire-and-forget) would otherwise keep its name and IP. Once the account
    // is gone no new row can be about it.
    postPurge: (ctx) => scrubAuditRowsAbout(ctx.userId),
    // The user's own actions, and the rows about the account written before
    // anyone was signed in (sign-up, sign-ins, failed sign-ins) — theirs too.
    exportFragment: async (ctx) => ({
      activityLog: markTrunc(ctx, 'activityLog', await AuditLog.find({ $or: [
        { 'actor.userId': ctx.userId },
        { 'resource.type': 'user', 'resource.id': ctx.userId, 'actor.userId': null },
      ] }).sort({ timestamp: -1 }).limit(AUDIT_MAX).lean(), AUDIT_MAX)
        .map(a => ({ action: a.action, timestamp: a.timestamp, detail: a.detail })),
    }),
  },
];

// ── Executors ───────────────────────────────────────────────────────────────

/** Deep-merge plain-object export fragments (so e.g. priceTracking.requests and
 *  priceTracking.skips from two entries combine instead of overwriting). */
const PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
function deepMerge(target, source) {
  for (const [k, v] of Object.entries(source)) {
    // Guard against prototype pollution. Fragment keys are hardcoded in this
    // file (not user input), so this is defence-in-depth — but it keeps the
    // helper safe for any future caller and satisfies static analysis.
    if (PROTO_KEYS.has(k)) continue;
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) {
      deepMerge(target[k], v);
    } else {
      target[k] = v;
    }
  }
  return target;
}

/**
 * Permanently erase all data linked to a user. Runs every registry entry's
 * prePurge in turn, then every purge op in one Promise.all, then the post-batch
 * cleanups.
 */
async function purgeUserData(userId, userEmail) {
  const cellarIds = await Cellar.distinct('_id', { user: userId });
  const deletedUserId = await getOrCreateDeletedUser();
  const ctx = { userId, userEmail, cellarIds, deletedUserId };

  for (const entry of REGISTRY) {
    if (entry.prePurge) await entry.prePurge(ctx);
  }

  const ops = [];
  for (const entry of REGISTRY) {
    if (!entry.purge) continue;
    const result = entry.purge(ctx);
    if (Array.isArray(result)) ops.push(...result);
    else ops.push(result);
  }
  await Promise.all(ops);

  for (const entry of REGISTRY) {
    if (entry.postPurge) await entry.postPurge(ctx);
  }
}

/**
 * Build the GDPR data-portability export payload for a user. Runs every
 * registry entry's export fragment and deep-merges them, then stamps the
 * truncation map.
 */
async function buildUserExport(userId, user) {
  const cellarIds = await Cellar.distinct('_id', { user: userId });
  const ctx = { userId, userEmail: user.email, user, cellarIds, EXPORT_MAX, AUDIT_MAX, truncated: {} };

  const exportData = { exportedAt: new Date().toISOString() };
  const fragments = await Promise.all(
    REGISTRY.filter(e => e.exportFragment).map(e => e.exportFragment(ctx))
  );
  for (const frag of fragments) deepMerge(exportData, frag);

  if (Object.keys(ctx.truncated).length > 0) {
    console.warn('[userDataExport] truncation hit for user', userId, ctx.truncated);
    exportData._truncated = ctx.truncated;
  }
  return exportData;
}

/** Model names with a purge and/or export handler — used by the completeness test. */
function registeredModelNames() {
  return REGISTRY.map(e => e.model.modelName);
}

module.exports = {
  REGISTRY,
  EXCLUDED,
  purgeUserData,
  buildUserExport,
  registeredModelNames,
  EXPORT_MAX,
};
