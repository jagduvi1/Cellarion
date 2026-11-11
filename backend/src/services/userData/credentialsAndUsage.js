// User-data registry entries: keys, tokens and what the account used. Bridge
// keys and their usage, API tokens, export links, idempotent-write records,
// OAuth codes, the MCP action ledger, climate devices, imports and receipts,
// AI and chat usage, value snapshots, price tracking and cellar invites.
// One part of the REGISTRY of services/userDataRegistry.js, which documents the
// entry shape and runs the entries in order.

const AiBudgetRequest = require('../../models/AiBudgetRequest');
const ApiToken = require('../../models/ApiToken');
const BridgeKey = require('../../models/BridgeKey');
const BridgeUsageDay = require('../../models/BridgeUsageDay');
const ExportLink = require('../../models/ExportLink');
const IdempotencyRecord = require('../../models/IdempotencyRecord');
const OAuthAuthCode = require('../../models/OAuthAuthCode');
const McpActionLog = require('../../models/McpActionLog');
const AiUsage = require('../../models/AiUsage');
const ClimateDevice = require('../../models/ClimateDevice');
const ClimateReading = require('../../models/ClimateReading');
const CellarValueSnapshot = require('../../models/CellarValueSnapshot');
const ChatUsage = require('../../models/ChatUsage');
const ImportSession = require('../../models/ImportSession');
const ImportArchive = require('../../models/ImportArchive');
const ReceiptScan = require('../../models/ReceiptScan');
const PendingShare = require('../../models/PendingShare');
const PriceTrackingSkip = require('../../models/PriceTrackingSkip');
const PriceTrackingRequest = require('../../models/PriceTrackingRequest');
const PushSubscription = require('../../models/PushSubscription');
const { eraseRequesterFromDeclineSnapshots } = require('../undoSnapshotErasure');
const { EXPORT_MAX, markTrunc } = require('./shared');

module.exports = [
  // ── Registry Bridge keys + usage ───────────────────────────────────────
  {
    // A bridge key is credential bookkeeping like an API token: hard-deleted
    // on erasure, exported as metadata only — the keyHash never leaves the
    // database. The display prefix is not a secret (it authenticates nothing).
    model: BridgeKey, category: 'personal-data', userFields: ['user'],
    purge: (ctx) => BridgeKey.deleteMany({ user: ctx.userId }),
    exportFragment: async (ctx) => ({
      bridgeKeys: markTrunc(ctx, 'bridgeKeys', await BridgeKey.find({ user: ctx.userId })
        .select('name prefix instanceHost termsVersion termsAcceptedAt lastUsedAt createdAt revokedAt').limit(EXPORT_MAX).lean())
        .map(k => ({ name: k.name, prefix: k.prefix, instanceHost: k.instanceHost, termsVersion: k.termsVersion, termsAcceptedAt: k.termsAcceptedAt, lastUsedAt: k.lastUsedAt, createdAt: k.createdAt, revokedAt: k.revokedAt })),
    }),
  },
  {
    // Per-key daily quota counters (90-day TTL): operational telemetry keyed
    // to the owner — purged with the account, exported as the daily counts.
    model: BridgeUsageDay, category: 'personal-data', userFields: ['user'],
    purge: (ctx) => BridgeUsageDay.deleteMany({ user: ctx.userId }),
    exportFragment: async (ctx) => ({
      bridgeUsage: markTrunc(ctx, 'bridgeUsage', await BridgeUsageDay.find({ user: ctx.userId }).select('day searches fetches changeChecks contributions').limit(EXPORT_MAX).lean())
        .map(r => ({ day: r.day, searches: r.searches, fetches: r.fetches, changeChecks: r.changeChecks, contributions: r.contributions })),
    }),
  },

  // ── API tokens ──────────────────────────────────────────────────────────
  {
    model: ApiToken, category: 'personal-data', userFields: ['user'],
    // Hard-delete on erasure — a token row is pure credential bookkeeping.
    purge: (ctx) => ApiToken.deleteMany({ user: ctx.userId }),
    // Export metadata only. The tokenHash / refreshTokenHash NEVER leave the
    // database — they are not the user's data, they are the credential itself.
    // `origin` distinguishes user-minted PATs from OAuth AI connections.
    // `deprecatedUse`: which deprecated routes the token called and when its
    // owner was told (services/apiDeprecationNotices), null when none.
    exportFragment: async (ctx) => ({
      apiTokens: markTrunc(ctx, 'apiTokens', await ApiToken.find({ user: ctx.userId })
        .select('name scopes origin lastUsedAt createdAt revokedAt deprecatedUse').limit(EXPORT_MAX).lean())
        .map(t => ({
          name: t.name, scopes: t.scopes, origin: t.origin || 'personal', lastUsedAt: t.lastUsedAt, createdAt: t.createdAt, revokedAt: t.revokedAt,
          deprecatedUse: t.deprecatedUse?.sunset ? {
            sunset: t.deprecatedUse.sunset,
            firstAt: t.deprecatedUse.firstAt || null,
            lastAt: t.deprecatedUse.lastAt || null,
            routes: t.deprecatedUse.routes || [],
            notifiedAt: t.deprecatedUse.notifiedAt || null,
            reminders: (t.deprecatedUse.reminders || []).map(r => ({ daysBefore: r.daysBefore, at: r.at })),
          } : null,
        })),
    }),
  },

  // ── Export download links ──────────────────────────────────────────────
  {
    model: ExportLink, category: 'personal-data', userFields: ['user'],
    // Hard-delete on erasure. An ExportLink is a throwaway one-hour download
    // credential, not user data — the exportable data it points AT is exported
    // through its own registry entries (cellars, account, …). Nothing to export
    // here (and the tokenHash, like ApiToken's, never leaves the DB).
    purge: (ctx) => ExportLink.deleteMany({ user: ctx.userId }),
    exportFragment: null,
  },

  // ── Idempotent-write records (offline queue, #1355) ──────────────────────
  {
    model: IdempotencyRecord, category: 'personal-data', userFields: ['user'],
    // Hard-delete on erasure. The stored outcome of a write sent with an
    // Idempotency-Key, kept 8 days (TTL) so a resent write is not applied twice.
    // Nothing to export: a transient technical record of a request whose
    // effect is already in the exported data (bottles, racks).
    purge: (ctx) => IdempotencyRecord.deleteMany({ user: ctx.userId }),
    exportFragment: null,
  },

  // ── OAuth authorization codes ─────────────────────────────────────────────
  {
    model: OAuthAuthCode, category: 'personal-data', userFields: ['user'],
    // Hard-delete on erasure. These are single-use, 5-minute credentials that
    // TTL themselves away; nothing to export (an ephemeral, spent-or-expired
    // authorization code is not meaningful personal data). The tokens they mint
    // are covered by the ApiToken entry above.
    purge: (ctx) => OAuthAuthCode.deleteMany({ user: ctx.userId }),
    exportFragment: null,
  },

  // ── MCP action ledger ───────────────────────────────────────────────────
  {
    model: McpActionLog, category: 'personal-data', userFields: ['user'],
    // Hard-delete on erasure — operational undo/idempotency bookkeeping.
    purge: (ctx) => McpActionLog.deleteMany({ user: ctx.userId }),
    // Export what the connected AI changed (right of access) INCLUDING prev —
    // after a restore, the user's consumed note/rating snapshot may exist only
    // here for up to the TTL. Never the idempotency keys or stored result
    // payloads (operational plumbing). Excludes preview + pending claim stubs
    // (MCP-audit M1/F4) — data-minimisation: those changed nothing and are the
    // same rows hidden from the timeline.
    exportFragment: async (ctx) => ({
      mcpActions: markTrunc(ctx, 'mcpActions', await McpActionLog.find({ user: ctx.userId, action: { $nin: McpActionLog.NON_ACTIVITY_ACTIONS } })
        .select('tool action bottle cellar detail prev reversed createdAt').limit(EXPORT_MAX).lean())
        .map(a => ({ tool: a.tool, action: a.action, bottle: a.bottle, cellar: a.cellar, detail: a.detail, prev: a.prev || null, reversed: a.reversed, createdAt: a.createdAt })),
    }),
  },

  // ── Climate monitoring ──────────────────────────────────────────────────
  {
    model: ClimateDevice, category: 'personal-data', userFields: ['user'],
    // ClimateReading rows are keyed by device (meta.device, no user ref) — they
    // are purged and exported HERE, through the device→user link, which is why
    // ClimateReading itself sits in EXCLUDED. Ids are collected before the
    // device deleteMany so the readings can still be found. The devices' API
    // tokens are hard-deleted by the ApiToken entry above.
    purge: async (ctx) => {
      const deviceIds = await ClimateDevice.find({ user: ctx.userId }).distinct('_id');
      if (deviceIds.length > 0) {
        await ClimateReading.deleteMany({ 'meta.device': { $in: deviceIds } });
      }
      await ClimateDevice.deleteMany({ user: ctx.userId });
    },
    exportFragment: async (ctx) => {
      const devices = await ClimateDevice.find({ user: ctx.userId }).limit(EXPORT_MAX).lean();
      const deviceIds = devices.map(d => d._id);
      const readings = deviceIds.length > 0
        ? await ClimateReading.find({ 'meta.device': { $in: deviceIds } })
          .sort({ ts: -1 }).limit(EXPORT_MAX).lean()
        : [];
      return {
        climateDevices: markTrunc(ctx, 'climateDevices', devices).map(d => ({
          name: d.name,
          cellar: d.cellar,
          firmware: d.firmware,
          lastSeenAt: d.lastSeenAt,
          lastRssi: d.lastRssi,
          createdAt: d.createdAt,
          channels: (d.channels || []).map(c => ({ key: c.key, type: c.type, label: c.label, calibrationOffset: c.calibrationOffset })),
        })),
        climateReadings: markTrunc(ctx, 'climateReadings', readings)
          .map(r => ({ ts: r.ts, device: r.meta?.device, channel: r.meta?.channel, type: r.meta?.type, value: r.value })),
      };
    },
  },

  // ── Import & usage ──────────────────────────────────────────────────────
  {
    model: ImportSession, category: 'personal-data', userFields: ['user'],
    purge: (ctx) => ImportSession.deleteMany({ user: ctx.userId }),
    exportFragment: async (ctx) => ({
      importSessions: markTrunc(ctx, 'importSessions', await ImportSession.find({ user: ctx.userId }).select('cellar status results positionAnchor rackConfigs defaultCurrency createdAt').limit(EXPORT_MAX).lean())
        .map(s => ({ cellar: s.cellar, status: s.status, rowCount: s.results?.length || 0, positionAnchor: s.positionAnchor, rackConfigs: s.rackConfigs, defaultCurrency: s.defaultCurrency, createdAt: s.createdAt })),
    }),
  },
  {
    // The 30-day diagnostic copy of a finished import (models/ImportArchive).
    // Identity columns only, but they are still the user's rows, so it is
    // exported in full and erased with the account like everything else.
    model: ImportArchive, category: 'personal-data', userFields: ['user'],
    purge: (ctx) => ImportArchive.deleteMany({ user: ctx.userId }),
    exportFragment: async (ctx) => ({
      importArchives: markTrunc(ctx, 'importArchives', await ImportArchive.find({ user: ctx.userId })
        .select('cellar fileName detectedFormat detectedEncoding importWarnings rows rowCount rowsTruncated summary retainUntil createdAt')
        .limit(EXPORT_MAX).lean()),
    }),
  },
  {
    // Receipts kept during the receipt-scan beta (models/ReceiptScan, at most
    // 5 days). Exported as what was read and when (the image bytes stay out of
    // the JSON); erased with the account — files first, via receiptArchive.
    model: ReceiptScan, category: 'personal-data', userFields: ['user'],
    purge: (ctx) => require('../receiptArchive').purgeUserReceiptScans(ctx.userId),
    exportFragment: async (ctx) => ({
      receiptScans: markTrunc(ctx, 'receiptScans', await ReceiptScan.find({ user: ctx.userId })
        .select('files outcome model result rawReply retainUntil createdAt')
        .limit(EXPORT_MAX).lean()),
    }),
  },
  {
    model: AiBudgetRequest, category: 'personal-data', userFields: ['user', 'decidedBy'],
    purge: (ctx) => [
      AiBudgetRequest.deleteMany({ user: ctx.userId }),
      // Clear this user's admin ref off OTHER users' decided requests.
      AiBudgetRequest.updateMany({ decidedBy: ctx.userId }, { $unset: { decidedBy: '' } }),
    ],
    exportFragment: async (ctx) => ({
      aiBudgetRequests: markTrunc(ctx, 'aiBudgetRequests',
        await AiBudgetRequest.find({ user: ctx.userId })
          .select('reason requestedContext status grantedMax grantedUntil createdAt decidedAt')
          .limit(EXPORT_MAX).lean())
        .map(r => ({
          reason: r.reason,
          pendingRows: r.requestedContext?.pendingRows ?? null,
          status: r.status,
          grantedMax: r.grantedMax,
          grantedUntil: r.grantedUntil,
          createdAt: r.createdAt,
          decidedAt: r.decidedAt,
        })),
    }),
  },
  {
    // Same handling as ChatUsage: per-user daily AI-call counters (90-day
    // TTL). The site-wide kill-switch row has userId: null and is not
    // personal data — untouched by the per-user purge, as intended.
    model: AiUsage, category: 'personal-data', userFields: ['userId'],
    purge: (ctx) => AiUsage.deleteMany({ userId: ctx.userId }),
    exportFragment: async (ctx) => ({
      aiUsage: markTrunc(ctx, 'aiUsage', await AiUsage.find({ userId: ctx.userId }).select('date count').limit(EXPORT_MAX).lean())
        .map(u => ({ date: u.date, count: u.count })),
    }),
  },
  {
    model: ChatUsage, category: 'personal-data', userFields: ['userId'],
    purge: (ctx) => ChatUsage.deleteMany({ userId: ctx.userId }),
    // BUG FIX: schema fields are count/inputTokens/outputTokens — the old export
    // selected promptTokens/completionTokens which don't exist (always undefined).
    exportFragment: async (ctx) => ({
      chatUsage: markTrunc(ctx, 'chatUsage', await ChatUsage.find({ userId: ctx.userId }).select('date count inputTokens outputTokens').limit(EXPORT_MAX).lean())
        .map(c => ({ date: c.date, count: c.count, inputTokens: c.inputTokens, outputTokens: c.outputTokens })),
    }),
  },
  {
    model: PushSubscription, category: 'personal-data', userFields: ['user'],
    purge: (ctx) => PushSubscription.deleteMany({ user: ctx.userId }),
    // Not exported: the subscription is device push-crypto (endpoint + p256dh/
    // auth secrets), not useful or safe portability data. Tracked as a follow-up
    // if a minimal (endpoint-only) export is ever wanted.
    exportFragment: null,
    note: 'push crypto secrets — minimal export is a follow-up decision',
  },
  {
    model: CellarValueSnapshot, category: 'personal-data', userFields: ['user'],
    purge: (ctx) => CellarValueSnapshot.deleteMany({ user: ctx.userId }),
    // GAP FIX: was purged but never exported.
    exportFragment: async (ctx) => ({
      cellarValueSnapshots: markTrunc(ctx, 'cellarValueSnapshots', await CellarValueSnapshot.find({ user: ctx.userId }).limit(EXPORT_MAX).lean()),
    }),
  },

  // ── Price tracking ──────────────────────────────────────────────────────
  {
    model: PriceTrackingSkip, category: 'personal-data', userFields: ['skippedBy'],
    purge: (ctx) => PriceTrackingSkip.deleteMany({ skippedBy: ctx.userId }),
    exportFragment: async (ctx) => ({
      priceTracking: { skips: markTrunc(ctx, 'priceTrackingSkips', await PriceTrackingSkip.find({ skippedBy: ctx.userId }).select('wineDefinition vintage reason skippedAt').limit(EXPORT_MAX).lean())
        .map(s => ({ wineDefinition: s.wineDefinition, vintage: s.vintage, reason: s.reason, skippedAt: s.skippedAt })) },
    }),
  },
  {
    model: PriceTrackingRequest, category: 'shared-content', userFields: ['requesters.user'],
    purge: (ctx) => eraseRequesterFromDeclineSnapshots(ctx.userId)
      .then(() => PriceTrackingRequest.updateMany({ 'requesters.user': ctx.userId }, { $pull: { requesters: { user: ctx.userId } } })),
    // After the pull, a doc with no requesters left is an orphan.
    postPurge: () => PriceTrackingRequest.deleteMany({ requesters: { $size: 0 } }),
    exportFragment: async (ctx) => {
      const reqs = markTrunc(ctx, 'priceTrackingRequests', await PriceTrackingRequest.find({ 'requesters.user': ctx.userId }).select('wineDefinition vintage requesters createdAt').limit(EXPORT_MAX).lean());
      return {
        priceTracking: { requests: reqs.map(pt => {
          const mine = (pt.requesters || []).find(r => (r.user?.toString?.() || r.user) === ctx.userId);
          return { wineDefinition: pt.wineDefinition, vintage: pt.vintage, note: mine?.note, requestedAt: mine?.requestedAt };
        }) },
      };
    },
  },

  // ── Invites ─────────────────────────────────────────────────────────────
  {
    model: PendingShare, category: 'personal-data', userFields: ['invitedBy', 'email'],
    purge: (ctx) => PendingShare.deleteMany({ $or: [{ invitedBy: ctx.userId }, { email: ctx.userEmail }] }),
    exportFragment: async (ctx) => {
      const [sent, received] = await Promise.all([
        PendingShare.find({ invitedBy: ctx.userId }).limit(EXPORT_MAX).populate('cellar', 'name').lean(),
        // Guard against a missing email: find({ email: undefined }) matches the
        // WHOLE collection and would leak other users' invites.
        ctx.userEmail
          ? PendingShare.find({ email: ctx.userEmail }).limit(EXPORT_MAX).populate('cellar', 'name').lean()
          : [],
      ]);
      markTrunc(ctx, 'pendingSharesSent', sent);
      markTrunc(ctx, 'pendingSharesReceived', received);
      return {
        pendingCellarInvites: sent.map(ps => ({ invitedEmail: ps.email, cellarName: ps.cellar?.name, role: ps.role, createdAt: ps.createdAt })),
        pendingCellarInvitesReceived: received.map(ps => ({ cellarName: ps.cellar?.name, role: ps.role, createdAt: ps.createdAt })),
      };
    },
  },
];
