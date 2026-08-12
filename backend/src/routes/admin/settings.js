const express = require('express');
const { requireAuth, requireRole } = require('../../middleware/auth');
const SiteConfig = require('../../models/SiteConfig');
const rateLimitsConfig = require('../../config/rateLimits');
const { logAudit } = require('../../services/audit');
const { updateSiteConfig } = require('../../utils/siteConfig');

const router = express.Router();

// All routes require admin
router.use(requireAuth, requireRole('admin'));

// GET /api/admin/settings/rate-limits
router.get('/rate-limits', async (req, res) => {
  try {
    res.json({
      config:   rateLimitsConfig.get(),
      defaults: rateLimitsConfig.defaults
    });
  } catch (err) {
    console.error('Admin get rate-limits error:', err);
    res.status(500).json({ error: 'Failed to load rate limit settings' });
  }
});

// PATCH /api/admin/settings/rate-limits
//
// Partial update: any group/field that isn't sent is left at its current value,
// so the UI can split the editor into multiple panels each with its own Save.
//
// Bounded ranges per field are enforced server-side. Admin tuning is a trusted
// surface (requireRole('admin')), but the bounds also serve as guardrails
// against typos that would silently disable a safety mechanism (e.g. setting
// accountLockout.threshold to 9999 effectively turns lockout off).
router.patch('/rate-limits', async (req, res) => {
  try {
    const { api, write, auth, accountLockout, chatBurst, chatConcurrentStreams, aiDailyBudget, aiImportPerRequestCap, aiGlobalDailyCap, imageUploadBurst, demo, mcp } = req.body;

    const previous = { ...rateLimitsConfig.get() };

    const errors = [];

    const requireIntInRange = (path, val, min, max) => {
      if (val === undefined) return true;
      if (!Number.isInteger(val) || val < min || val > max) {
        errors.push(`${path} must be an integer between ${min} and ${max}`);
        return false;
      }
      return true;
    };

    // Per-IP request caps (api/write/auth share the same {max} shape)
    for (const [name, group] of Object.entries({ api, write, auth })) {
      if (group !== undefined) {
        requireIntInRange(`${name}.max`, group.max, 1, 10000);
      }
    }

    // Account lockout — threshold attempts within windowMs, locks for durationMs
    if (accountLockout !== undefined) {
      requireIntInRange('accountLockout.threshold',    accountLockout.threshold,    3,           1000);
      requireIntInRange('accountLockout.windowMs',     accountLockout.windowMs,     60_000,      24 * 60 * 60 * 1000);
      requireIntInRange('accountLockout.durationMs',   accountLockout.durationMs,   60_000,      30 * 24 * 60 * 60 * 1000);
      requireIntInRange('accountLockout.emailDedupMs', accountLockout.emailDedupMs, 0,           30 * 24 * 60 * 60 * 1000);
    }

    // Chat burst limiter — max requests per user per windowMs
    if (chatBurst !== undefined) {
      requireIntInRange('chatBurst.max',      chatBurst.max,      1,      1000);
      requireIntInRange('chatBurst.windowMs', chatBurst.windowMs, 10_000, 60 * 60 * 1000);
    }

    // Concurrent SSE streams cap per user
    if (chatConcurrentStreams !== undefined) {
      requireIntInRange('chatConcurrentStreams.max', chatConcurrentStreams.max, 1, 50);
    }

    // Shared per-user daily Anthropic-call budget (0 = unlimited)
    if (aiDailyBudget !== undefined) {
      requireIntInRange('aiDailyBudget.max', aiDailyBudget.max, 0, 1_000_000);
    }

    // AI identify fan-out cap per /import/validate request (frontend batches at 25)
    if (aiImportPerRequestCap !== undefined) {
      requireIntInRange('aiImportPerRequestCap.max', aiImportPerRequestCap.max, 1, 2000);
    }

    // Site-wide daily Anthropic-call kill-switch (0 = disabled)
    if (aiGlobalDailyCap !== undefined) {
      requireIntInRange('aiGlobalDailyCap.max', aiGlobalDailyCap.max, 0, 10_000_000);
    }

    // Per-user photo-upload burst. config/rateLimits.js documented this as
    // "runtime-tunable by SuperAdmin" since it shipped, but it was never in
    // this handler — the one claim without a lever. Floor 5 keeps a typo from
    // effectively disabling uploads; window floor matches the other bursts.
    if (imageUploadBurst !== undefined) {
      requireIntInRange('imageUploadBurst.max',      imageUploadBurst.max,      5,      10_000);
      requireIntInRange('imageUploadBurst.windowMs', imageUploadBurst.windowMs, 60_000, 24 * 60 * 60 * 1000);
    }

    // Ephemeral public-demo accounts. globalMax=0 is the demo kill-switch
    // (demo-login always 429s), so the lower bound is 0. ttlMs floor of 5 min
    // keeps the reaper meaningful; createWindowMs floor of 1 min matches the
    // other burst windows.
    if (demo !== undefined) {
      requireIntInRange('demo.createMax',      demo.createMax,      1,       1000);
      requireIntInRange('demo.createWindowMs', demo.createWindowMs, 60_000,  24 * 60 * 60 * 1000);
      requireIntInRange('demo.globalMax',      demo.globalMax,      0,       100_000);
      requireIntInRange('demo.ttlMs',          demo.ttlMs,          5 * 60_000, 24 * 60 * 60 * 1000);
    }

    // MCP kill switches (0 = off, 1 = on). enabled=0 shuts the whole AI
    // surface; publicEnabled=0 shuts only the anonymous endpoint.
    // userMax/ipMax are the protocol-endpoint limits (MCP-audit M8): per-USER
    // fair share and the pre-auth per-IP flood guard. Floors keep a typo from
    // effectively bricking the surface (userMax 10 ≈ one short exchange);
    // ipMax must stay well above userMax or one shared egress IP throttles
    // before any user reaches their own allowance.
    // registerMax bounds OAuth Dynamic Client Registration per IP per hour. The
    // floor is 10 (the old hardcoded value) rather than 0 — dropping it lower
    // would block new connections outright rather than merely slow abuse.
    // oauthMax bounds the rest of the OAuth AS per IP per 15 min. Its floor is
    // deliberately high (100): every connected client refreshes its access
    // token at least hourly and a hosted platform does that for its whole user
    // base from one egress IP, so a low value here disconnects real people
    // mid-conversation — the exact failure the exemption existed to prevent.
    if (mcp !== undefined) {
      requireIntInRange('mcp.enabled',       mcp.enabled,       0, 1);
      requireIntInRange('mcp.publicEnabled', mcp.publicEnabled, 0, 1);
      requireIntInRange('mcp.userMax',       mcp.userMax,       10, 100_000);
      requireIntInRange('mcp.ipMax',         mcp.ipMax,         100, 1_000_000);
      requireIntInRange('mcp.registerMax',   mcp.registerMax,   10, 100_000);
      requireIntInRange('mcp.oauthMax',      mcp.oauthMax,      100, 1_000_000);
    }

    if (errors.length > 0) {
      return res.status(400).json({ error: errors[0], errors });
    }

    const updated = {
      // Spread previous first so groups not exposed by this handler
      // (aiBurst, and any future groups) survive the wholesale
      // rateLimitsConfig.set() below instead of being dropped.
      ...previous,
      imageUploadBurst: {
        max:      imageUploadBurst?.max      ?? previous.imageUploadBurst?.max      ?? rateLimitsConfig.defaults.imageUploadBurst.max,
        windowMs: imageUploadBurst?.windowMs ?? previous.imageUploadBurst?.windowMs ?? rateLimitsConfig.defaults.imageUploadBurst.windowMs,
      },
      api:   { max: api?.max   ?? previous.api.max   },
      write: { max: write?.max ?? previous.write.max },
      auth:  { max: auth?.max  ?? previous.auth.max  },
      accountLockout: {
        threshold:    accountLockout?.threshold    ?? previous.accountLockout.threshold,
        windowMs:     accountLockout?.windowMs     ?? previous.accountLockout.windowMs,
        durationMs:   accountLockout?.durationMs   ?? previous.accountLockout.durationMs,
        emailDedupMs: accountLockout?.emailDedupMs ?? previous.accountLockout.emailDedupMs,
      },
      chatBurst: {
        max:      chatBurst?.max      ?? previous.chatBurst.max,
        windowMs: chatBurst?.windowMs ?? previous.chatBurst.windowMs,
      },
      chatConcurrentStreams: {
        max: chatConcurrentStreams?.max ?? previous.chatConcurrentStreams.max,
      },
      aiDailyBudget: {
        max: aiDailyBudget?.max ?? previous.aiDailyBudget?.max ?? rateLimitsConfig.defaults.aiDailyBudget.max,
      },
      aiImportPerRequestCap: {
        max: aiImportPerRequestCap?.max ?? previous.aiImportPerRequestCap?.max ?? rateLimitsConfig.defaults.aiImportPerRequestCap.max,
      },
      aiGlobalDailyCap: {
        max: aiGlobalDailyCap?.max ?? previous.aiGlobalDailyCap?.max ?? rateLimitsConfig.defaults.aiGlobalDailyCap.max,
      },
      demo: {
        createMax:      demo?.createMax      ?? previous.demo?.createMax      ?? rateLimitsConfig.defaults.demo.createMax,
        createWindowMs: demo?.createWindowMs ?? previous.demo?.createWindowMs ?? rateLimitsConfig.defaults.demo.createWindowMs,
        globalMax:      demo?.globalMax      ?? previous.demo?.globalMax      ?? rateLimitsConfig.defaults.demo.globalMax,
        ttlMs:          demo?.ttlMs          ?? previous.demo?.ttlMs          ?? rateLimitsConfig.defaults.demo.ttlMs,
      },
      mcp: {
        enabled:       mcp?.enabled       ?? previous.mcp?.enabled       ?? rateLimitsConfig.defaults.mcp.enabled,
        publicEnabled: mcp?.publicEnabled ?? previous.mcp?.publicEnabled ?? rateLimitsConfig.defaults.mcp.publicEnabled,
        userMax:       mcp?.userMax       ?? previous.mcp?.userMax       ?? rateLimitsConfig.defaults.mcp.userMax,
        ipMax:         mcp?.ipMax         ?? previous.mcp?.ipMax         ?? rateLimitsConfig.defaults.mcp.ipMax,
        registerMax:   mcp?.registerMax   ?? previous.mcp?.registerMax   ?? rateLimitsConfig.defaults.mcp.registerMax,
        oauthMax:      mcp?.oauthMax      ?? previous.mcp?.oauthMax      ?? rateLimitsConfig.defaults.mcp.oauthMax,
      },
    };

    await updateSiteConfig('rateLimits', updated, req.user.id);

    rateLimitsConfig.set(updated);

    logAudit(req, 'admin.settings.rate_limits.update', {}, { from: previous, to: updated });

    res.json({ config: updated });
  } catch (err) {
    console.error('Admin update rate-limits error:', err);
    res.status(500).json({ error: 'Failed to update rate limit settings' });
  }
});

// GET /api/admin/settings/contact-email
router.get('/contact-email', async (req, res) => {
  try {
    const doc = await SiteConfig.findOne({ key: 'contactEmail' }).lean();
    res.json({ contactEmail: doc?.value ?? null });
  } catch (err) {
    console.error('Admin get contact-email error:', err);
    res.status(500).json({ error: 'Failed to load contact email setting' });
  }
});

// PATCH /api/admin/settings/contact-email
router.patch('/contact-email', async (req, res) => {
  try {
    const { contactEmail } = req.body;
    if (typeof contactEmail !== 'string' || !contactEmail.trim()) {
      return res.status(400).json({ error: 'contactEmail must be a non-empty string' });
    }
    const trimmed = contactEmail.trim();
    // RFC 5321 max email length is 254; guard before regex to prevent ReDoS
    if (trimmed.length > 254) {
      return res.status(400).json({ error: 'contactEmail must be a valid email address' });
    }
    // Basic email format check
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      return res.status(400).json({ error: 'contactEmail must be a valid email address' });
    }
    await updateSiteConfig('contactEmail', trimmed, req.user.id);
    logAudit(req, 'admin.settings.contact_email.update', {}, { contactEmail: trimmed });
    res.json({ contactEmail: trimmed });
  } catch (err) {
    console.error('Admin update contact-email error:', err);
    res.status(500).json({ error: 'Failed to update contact email setting' });
  }
});

module.exports = router;
