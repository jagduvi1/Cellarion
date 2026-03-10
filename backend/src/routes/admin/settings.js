const express = require('express');
const { requireAuth, requireRole } = require('../../middleware/auth');
const SiteConfig = require('../../models/SiteConfig');
const rateLimitsConfig = require('../../config/rateLimits');
const { logAudit } = require('../../services/audit');

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
router.patch('/rate-limits', async (req, res) => {
  try {
    const { api, write, auth } = req.body;

    const previous = { ...rateLimitsConfig.get() };

    // Validate provided fields
    const incoming = { api, write, auth };
    for (const [name, val] of Object.entries(incoming)) {
      if (val !== undefined) {
        if (!Number.isInteger(val.max) || val.max < 1 || val.max > 10000) {
          return res.status(400).json({
            error: `${name}.max must be an integer between 1 and 10000`
          });
        }
      }
    }

    const updated = {
      api:   { max: api?.max   ?? previous.api.max   },
      write: { max: write?.max ?? previous.write.max },
      auth:  { max: auth?.max  ?? previous.auth.max  }
    };

    await SiteConfig.findOneAndUpdate(
      { key: 'rateLimits' },
      { key: 'rateLimits', value: updated, updatedAt: new Date(), updatedBy: req.user.id },
      { upsert: true, new: true }
    );

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
    await SiteConfig.findOneAndUpdate(
      { key: 'contactEmail' },
      { key: 'contactEmail', value: trimmed, updatedAt: new Date(), updatedBy: req.user.id },
      { upsert: true, new: true }
    );
    logAudit(req, 'admin.settings.contact_email.update', {}, { contactEmail: trimmed });
    res.json({ contactEmail: trimmed });
  } catch (err) {
    console.error('Admin update contact-email error:', err);
    res.status(500).json({ error: 'Failed to update contact email setting' });
  }
});

module.exports = router;
