const express = require('express');
const router = express.Router();
const ApiToken = require('../models/ApiToken');
const User = require('../models/User');
const { requireAuth, requireNonDemo } = require('../middleware/auth');
const { logAudit } = require('../services/audit');
const eventBus = require('../services/eventBus');
const { passwordConfirmLimiter } = require('../middleware/passwordConfirmLimiter');

const { TOKEN_SCOPES, MAX_ACTIVE_TOKENS_PER_USER } = ApiToken;

// Token creation verifies the account password, so it is a password-guessing
// surface exactly like login/change-password. It shares ONE limiter store with
// the other password-confirm surfaces (climate device creation) so the auth
// budget can't be multiplied across endpoints — see the middleware.
const authLimiter = passwordConfirmLimiter;

// Device tokens (scope 'climate') are minted only by POST /api/climate/devices,
// which binds each to a ClimateDevice. A climate scope minted here would have
// no device and 404 on every ingest, so it is not user-mintable via this route.
const USER_MINTABLE_SCOPES = TOKEN_SCOPES.filter(s => s !== 'climate');

// NOTE: of these routes only DELETE /self appears in the API-token scope
// allowlist (middleware/apiTokenAuth.js) — a token may end ITSELF and nothing
// more; creating, listing and revoking by id are logged-in-session (JWT) only.

// POST /api/tokens — create a personal API token (plaintext shown ONCE).
// requireNonDemo: a cel_ token authenticates via apiTokenAuth (bypassing the JWT),
// so it carries no isDemo claim — a demo user minting one would defeat the demo
// AI/guard gates. Token creation is off-limits to demo accounts entirely.
router.post('/', requireAuth, requireNonDemo, authLimiter, async (req, res) => {
  const { name, scopes, password } = req.body;

  if (!name || typeof name !== 'string' || !name.trim() || name.trim().length > 100) {
    return res.status(400).json({ error: 'Token name is required (max 100 characters)' });
  }
  if (!Array.isArray(scopes) || scopes.length === 0 || scopes.some(s => !USER_MINTABLE_SCOPES.includes(s))) {
    return res.status(400).json({ error: `Scopes must be a non-empty subset of: ${USER_MINTABLE_SCOPES.join(', ')}` });
  }
  if (!password || typeof password !== 'string') {
    return res.status(400).json({ error: 'Password confirmation is required' });
  }

  try {
    // Fresh password confirmation — a hijacked browser session must not be
    // able to mint a durable credential silently (same pattern as
    // change-password).
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    // SSO-only accounts have no password at all — comparePassword would return
    // a truthful-but-misleading "incorrect". Tell them the actual fix (the UI
    // keys on the code to show the set-password flow instead of the field).
    if (!user.password) {
      logAudit(req, 'token.create_failed', { type: 'user', id: user._id }, { reason: 'no_password' });
      return res.status(403).json({
        error: 'This account signs in with Google and has no password yet. Set one first (Settings → Set a password), then create the token.',
        code: 'no_password',
      });
    }
    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      logAudit(req, 'token.create_failed', { type: 'user', id: user._id }, { reason: 'incorrect_password' });
      // 403, NOT 401: the session is fine, the password confirmation failed.
      // The frontend's apiFetch treats any 401 as "access token expired" and
      // silently refreshes + re-submits — which would double every bcrypt
      // compare and, if the refresh raced another tab, log the user out for
      // a typo.
      return res.status(403).json({ error: 'Password is incorrect' });
    }

    const activeCount = await ApiToken.countDocuments({ user: req.user.id, revokedAt: null });
    if (activeCount >= MAX_ACTIVE_TOKENS_PER_USER) {
      return res.status(400).json({ error: `Maximum of ${MAX_ACTIVE_TOKENS_PER_USER} active tokens reached — revoke one first` });
    }

    const rawToken = ApiToken.generateToken();
    const token = await ApiToken.create({
      user: req.user.id,
      name: name.trim(),
      tokenHash: ApiToken.hashToken(rawToken),
      scopes: [...new Set(scopes)],
    });

    // Audit the token id and metadata — NEVER the token or its hash.
    logAudit(req, 'token.created', { type: 'apiToken', id: token._id }, { name: token.name, scopes: token.scopes });

    res.status(201).json({
      token: rawToken, // shown once; only the SHA-256 is stored
      id: token._id,
      name: token.name,
      scopes: token.scopes,
      createdAt: token.createdAt,
    });
  } catch (error) {
    console.error('Create API token error:', error);
    res.status(500).json({ error: 'Failed to create token' });
  }
});

// GET /api/tokens — list the caller's active tokens (metadata only)
router.get('/', requireAuth, async (req, res) => {
  try {
    const tokens = await ApiToken.find({ user: req.user.id, revokedAt: null })
      .sort({ createdAt: -1 })
      .select('name scopes lastUsedAt createdAt')
      .lean();
    res.json(tokens.map(t => ({
      id: t._id,
      name: t.name,
      scopes: t.scopes,
      lastUsedAt: t.lastUsedAt,
      createdAt: t.createdAt,
    })));
  } catch (error) {
    console.error('List API tokens error:', error);
    res.status(500).json({ error: 'Failed to list tokens' });
  }
});

// DELETE /api/tokens/:id — revoke (takes effect on the token's next request)
// DELETE /api/tokens/self — a personal API token revokes ITSELF. An
// integration that is being removed (the Home Assistant component on
// "delete integration") holds only its own bearer token — no session login
// and no token id — so this is the one way it can clean up after itself.
// Any scope may call it (middleware/apiTokenAuth.js allow-lists exactly this
// route for every token); a JWT session has no "self" token and is told to
// use DELETE /api/tokens/:id. Declared BEFORE /:id so "self" never casts.
router.delete('/self', requireAuth, async (req, res) => {
  try {
    if (!req.apiToken) {
      return res.status(400).json({ error: 'Only a personal API token can revoke itself — from a signed-in session use DELETE /api/tokens/:id' });
    }
    const token = await ApiToken.findOne({ _id: req.apiToken.id, user: req.user.id, revokedAt: null });
    if (!token) {
      return res.status(404).json({ error: 'Token not found' });
    }
    token.revokedAt = new Date();
    await token.save();

    logAudit(req, 'token.revoked', { type: 'apiToken', id: token._id }, { name: token.name, self: true });
    eventBus.dropToken(token._id);

    res.json({ message: 'Token revoked', id: token._id, name: token.name });
  } catch (error) {
    console.error('Self-revoke API token error:', error);
    res.status(500).json({ error: 'Failed to revoke token' });
  }
});

router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const token = await ApiToken.findOne({ _id: req.params.id, user: req.user.id, revokedAt: null });
    if (!token) {
      return res.status(404).json({ error: 'Token not found' });
    }
    token.revokedAt = new Date();
    await token.save();

    logAudit(req, 'token.revoked', { type: 'apiToken', id: token._id }, { name: token.name });

    // Revocation must also close any open SSE event streams this token
    // authenticated (docs/ha-push-events.md §3).
    eventBus.dropToken(token._id);

    res.json({ message: 'Token revoked' });
  } catch (error) {
    if (error.name === 'CastError') {
      return res.status(404).json({ error: 'Token not found' });
    }
    console.error('Revoke API token error:', error);
    res.status(500).json({ error: 'Failed to revoke token' });
  }
});

module.exports = router;
