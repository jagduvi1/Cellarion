// Data-portability export tools (plan §3.3 export_cellar, §3.18 get_account_export,
// Appendix A "Cellar export + GDPR account export" → Phase 1).
//
// These tools do NOT return the export inline — an export is a file, not model
// context (the cellar payload caps at 50k documents, the account export spans
// ~35 collections; either can be hundreds of MB). Inlining it would blow the
// caller's context window and, for the account export, hand the user's full PII
// to the third-party AI. So each tool returns a compact summary + a short-lived
// download URL (services/exportLinks.js): the user opens it, the bytes go from
// us to their disk, and the model never sees them. Plan principle #7.
//
// Scope split is deliberate and stricter than the plan's casual annotations:
//   export_cellar      → read   (cellar data — already reachable via read tools)
//   get_account_export → write  (account-wide PII: email, audit log, support
//                                tickets, discussions — a superset the `read`
//                                tier deliberately CANNOT reach; whoami returns
//                                only {id} and /me stays 403 for tokens. The
//                                ApiToken model's own contract says "a leaked
//                                read-only token cannot touch exports". So a
//                                cautious read-only connection can never
//                                exfiltrate the account PII bundle; only a token
//                                the user granted full write trust surfaces it.)
const { z } = require('zod');
const { registerTool } = require('../registry');
const { ok, fail, resolveCellarAccess } = require('../toolUtil');
const { logAudit } = require('../../services/audit');

// services/exportLinks pulls the meilisearch ESM chain (via userDataRegistry),
// which jest's CJS runtime cannot parse — so, per mcp/tools/index.js, it is
// lazy-required inside the handlers, never at module top.
const exportLinks = () => require('../../services/exportLinks');

// Public origin for the download URL. The link path (/api/mcp/export/…) is
// served by the backend but fronted at the public origin (Traefik routes /api),
// so FRONTEND_URL is the right base — same convention as routes/og.js etc.
function publicBase() {
  return (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/+$/, '');
}

const linkTtlMinutes = () => Math.round(exportLinks().LINK_TTL_MS / 60000);

registerTool({
  name: 'export_cellar',
  title: 'Export cellar data (download link)',
  description:
    'Produce a downloadable export of the user\'s own cellar data — bottles, racks, placements, ratings and notes — ' +
    'as an import-ready file, and return a short-lived download link (the file itself is never inlined). ' +
    'Call for "export/download my cellar", "give me my data", "back up my collection", or anti-lock-in / data-portability requests. ' +
    'Exports ALL owned cellars by default, or one when cellar_id is given. Set include_images to bundle the user\'s own ' +
    'uploaded photos as a ZIP (limited to once per week); otherwise a JSON file. Only cellars the user OWNS are exportable.',
  scope: 'read',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {
    cellar_id: z.string().regex(/^[a-f0-9]{24}$/i, 'must be a 24-hex id').optional()
      .describe('Export just this owned cellar. Omit to export all owned cellars.'),
    include_images: z.boolean().default(false)
      .describe('Bundle the user\'s own uploaded images as a ZIP (max once per week). Default: JSON only.'),
  },
  handler: async (args, ctx) => {
    const scope = args.cellar_id ? String(args.cellar_id) : 'all';
    // Fail fast on a specific cellar the caller doesn't OWN (the export builder
    // is owner-only; members can't export someone else's cellar). 'all' needs no
    // check — it resolves to exactly the caller's owned cellars server-side.
    if (scope !== 'all') {
      const access = await resolveCellarAccess(ctx.user.id, scope, 'owner');
      if (!access) {
        return fail('not_found', 'No such cellar you own. Only cellars you own can be exported; use list_cellars for valid ids.');
      }
    }
    const kind = args.include_images ? 'cellar_zip' : 'cellar_json';
    const { url, expiresAt } = await exportLinks().mintExportLink({
      userId: ctx.user.id,
      kind,
      cellarScope: scope,
      tokenId: ctx.req?.apiToken?.id || null,
      baseUrl: publicBase(),
    });
    logAudit(ctx.req, 'user.cellar_data_export', { type: 'user', id: ctx.user.id }, { scope, via: 'mcp', kind });
    return ok(
      `Cellar export ready. Download link (valid ${linkTtlMinutes()} min): ${url}`,
      {
        download_url: url,
        format: args.include_images ? 'zip' : 'json',
        scope: scope === 'all' ? 'all_owned_cellars' : scope,
        expires_at: expiresAt,
        note: 'Give the user this link to click; the file downloads straight to their device and is not readable here.',
      }
    );
  },
});

registerTool({
  name: 'get_account_export',
  title: 'Export full account data — GDPR (download link)',
  description:
    'Produce the user\'s complete GDPR data-portability export — every piece of personal data across the account ' +
    '(profile, cellars, bottles, journal, reviews, notifications, audit history and more) — and return a short-lived ' +
    'download link. The file itself is never inlined: it can be very large and contains personal data (including the ' +
    'account email), so it goes straight to the user\'s device, not into this conversation. ' +
    'Call for "export all my data", "GDPR export", "download everything you have about me", or right-to-portability requests. ' +
    'Limited to once per day. For just the wine collection, prefer export_cellar.',
  scope: 'write',
  annotations: { readOnlyHint: true, openWorldHint: false },
  inputSchema: {},
  handler: async (args, ctx) => {
    const { url, expiresAt } = await exportLinks().mintExportLink({
      userId: ctx.user.id,
      kind: 'account_json',
      tokenId: ctx.req?.apiToken?.id || null,
      baseUrl: publicBase(),
    });
    logAudit(ctx.req, 'user.account_export', { type: 'user', id: ctx.user.id }, { via: 'mcp' });
    return ok(
      `Full account export ready. Download link (valid ${linkTtlMinutes()} min): ${url}`,
      {
        download_url: url,
        format: 'json',
        expires_at: expiresAt,
        note: 'Contains personal data including the account email. Give the user this link; the file downloads to their device and is not readable here. Limited to once per day.',
      }
    );
  },
});
