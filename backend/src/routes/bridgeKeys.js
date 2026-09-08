const express = require('express');
const router = express.Router();
const BridgeKey = require('../models/BridgeKey');
const User = require('../models/User');
const { requireAuth, requireNonDemo } = require('../middleware/auth');
const { logAudit } = require('../services/audit');
const { passwordConfirmLimiter } = require('../middleware/passwordConfirmLimiter');
const { CURRENT_REGISTRY_TERMS_VERSION } = require('../config/legal');
const { usageFor, openImportWindow } = require('../services/bridgeQuota');

// Registry Bridge keys — management is a logged-in-session (JWT) capability
// only, exactly like personal tokens: a bridge key can never mint, list or
// revoke keys (the bridge router has no such routes). Settings → "Connect a
// self-hosted Cellarion".

const { MAX_ACTIVE_PER_USER, NAME_MAX } = BridgeKey;

const isValidId = (id) => /^[a-f0-9]{24}$/i.test(String(id));

function termsState(user) {
  const accepted = user?.registryTerms?.accepted === true && user?.registryTerms?.version === CURRENT_REGISTRY_TERMS_VERSION;
  return {
    version: CURRENT_REGISTRY_TERMS_VERSION,
    accepted,
    acceptedAt: accepted ? user.registryTerms.acceptedAt : null,
    url: '/terms',
  };
}

async function presentKey(key) {
  const usage = await usageFor(key);
  return {
    id: key._id,
    name: key.name,
    prefix: key.prefix,
    instanceHost: key.instanceHost || null,
    termsVersion: key.termsVersion,
    createdAt: key.createdAt,
    lastUsedAt: key.lastUsedAt,
    usage,
  };
}

// GET /api/bridge/keys — the owner's active keys with today's usage, plus the
// terms state the UI needs to decide whether to show the acceptance step.
router.get('/', requireAuth, async (req, res) => {
  try {
    const [keys, user] = await Promise.all([
      BridgeKey.find({ user: req.user.id, revokedAt: null }).sort({ createdAt: 1 }),
      User.findById(req.user.id).select('registryTerms').lean(),
    ]);
    res.json({
      keys: await Promise.all(keys.map(presentKey)),
      maxActive: MAX_ACTIVE_PER_USER,
      terms: termsState(user),
    });
  } catch (error) {
    console.error('List bridge keys error:', error);
    res.status(500).json({ error: 'Failed to list bridge keys' });
  }
});

// POST /api/bridge/keys — issue a key (plaintext shown ONCE). Requires a fresh
// password confirmation and an accepted current Registry Data Terms version:
// the terms are the second lock on the registry, and the acceptance is what
// makes the key's quotas and revocation addressable to a person.
router.post('/', requireAuth, requireNonDemo, passwordConfirmLimiter, async (req, res) => {
  const { name, password, acceptTerms } = req.body || {};
  if (!name || typeof name !== 'string' || !name.trim() || name.trim().length > NAME_MAX) {
    return res.status(400).json({ error: `Give the install a name (max ${NAME_MAX} characters)` });
  }
  if (!password || typeof password !== 'string') {
    return res.status(400).json({ error: 'Password confirmation is required' });
  }
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!user.password) {
      logAudit(req, 'bridge.key.create_failed', { type: 'user', id: user._id }, { reason: 'no_password' });
      return res.status(403).json({
        error: 'This account signs in with Google and has no password yet. Set one first (Settings → Set a password), then create the key.',
        code: 'no_password',
      });
    }
    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      logAudit(req, 'bridge.key.create_failed', { type: 'user', id: user._id }, { reason: 'incorrect_password' });
      // 403, NOT 401 — the session is fine; apiFetch treats 401 as expiry.
      return res.status(403).json({ error: 'Password is incorrect' });
    }

    const terms = termsState(user);
    if (!terms.accepted) {
      if (acceptTerms !== true) {
        return res.status(400).json({ error: 'Accept the Registry Data Terms to issue a bridge key', code: 'terms_required', terms });
      }
      const now = new Date();
      user.set('registryTerms.accepted', true);
      user.set('registryTerms.acceptedAt', now);
      user.set('registryTerms.version', CURRENT_REGISTRY_TERMS_VERSION);
      await user.save();
      logAudit(req, 'user.registry_terms.accepted', { type: 'user', id: user._id }, { version: CURRENT_REGISTRY_TERMS_VERSION });
    }

    const activeCount = await BridgeKey.countDocuments({ user: req.user.id, revokedAt: null });
    if (activeCount >= MAX_ACTIVE_PER_USER) {
      return res.status(400).json({ error: `Maximum of ${MAX_ACTIVE_PER_USER} active bridge keys reached — revoke one first`, code: 'key_cap' });
    }

    const rawKey = BridgeKey.generateKey();
    const key = await BridgeKey.create({
      user: req.user.id,
      name: name.trim(),
      keyHash: BridgeKey.hashKey(rawKey),
      prefix: BridgeKey.displayPrefix(rawKey),
      termsVersion: CURRENT_REGISTRY_TERMS_VERSION,
      termsAcceptedAt: user.registryTerms?.acceptedAt || new Date(),
    });

    // Audit the key id and label — NEVER the key or its hash.
    logAudit(req, 'bridge.key.created', { type: 'bridgeKey', id: key._id }, { name: key.name, termsVersion: key.termsVersion });

    res.status(201).json({
      key: rawKey, // shown once; only the SHA-256 is stored
      id: key._id,
      name: key.name,
      prefix: key.prefix,
      createdAt: key.createdAt,
      termsVersion: key.termsVersion,
      env: {
        REGISTRY_BRIDGE_URL: `${(process.env.FRONTEND_URL || 'https://cellarion.app').replace(/\/+$/, '')}`,
        REGISTRY_BRIDGE_KEY: rawKey,
      },
    });
  } catch (error) {
    console.error('Create bridge key error:', error);
    res.status(500).json({ error: 'Failed to create bridge key' });
  }
});

// DELETE /api/bridge/keys/:id — revoke (owner-scoped; takes effect on the
// key's next request).
router.delete('/:id', requireAuth, async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid key id' });
  try {
    const key = await BridgeKey.findOne({ _id: req.params.id, user: req.user.id, revokedAt: null });
    if (!key) return res.status(404).json({ error: 'Bridge key not found' });
    key.revokedAt = new Date();
    await key.save();
    logAudit(req, 'bridge.key.revoked', { type: 'bridgeKey', id: key._id }, { name: key.name });
    res.json({ message: 'Bridge key revoked', id: key._id });
  } catch (error) {
    console.error('Revoke bridge key error:', error);
    res.status(500).json({ error: 'Failed to revoke bridge key' });
  }
});

// POST /api/bridge/keys/:id/import-window — raise the key's quotas ×5 for
// 24 hours, once per 30 days. For importing a whole cellar.
router.post('/:id/import-window', requireAuth, requireNonDemo, async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: 'Invalid key id' });
  try {
    const key = await BridgeKey.findOne({ _id: req.params.id, user: req.user.id, revokedAt: null });
    if (!key) return res.status(404).json({ error: 'Bridge key not found' });
    const r = await openImportWindow(key);
    if (!r.ok) {
      return res.status(409).json({ error: 'An import window was opened for this key less than 30 days ago', code: 'import_window_cooldown', nextAvailableAt: r.nextAvailableAt });
    }
    logAudit(req, 'bridge.key.import_window', { type: 'bridgeKey', id: key._id }, { name: key.name, until: r.until });
    res.json({ message: 'Import window open for 24 hours', until: r.until });
  } catch (error) {
    console.error('Open bridge import window error:', error);
    res.status(500).json({ error: 'Failed to open the import window' });
  }
});

module.exports = router;
