// Self-service account operations — the ONE implementation behind both the REST
// routes (routes/users.js, routes/support.js, routes/wineRequests.js) and the
// MCP self-service tools (mcp/tools/account.js). Same validation and the same
// writes on both surfaces so the web app and an AI assistant can never drift.
//
// Every function returns a plain result object with an optional `error` shaped
// { status, message } (HTTP-style status), which each caller maps to its own
// response envelope. None of these functions write an audit log — the caller
// owns audit attribution (it has the req), exactly as the extracted bottleOps /
// rackOps services do.
const net = require('net');
const mongoose = require('mongoose');
const User = require('../models/User');
const Cellar = require('../models/Cellar');
const SupportTicket = require('../models/SupportTicket');
const { isPrivateAddress } = require('../utils/safeImageFetch');
const WineRequest = require('../models/WineRequest');
const { stripHtml } = require('../utils/sanitize');
const { SUPPORTED_CURRENCIES } = require('../config/currencies');

// Allow-lists — the single source of truth the REST routes previously kept
// inline. Kept here so the MCP tools validate byte-for-byte identically.
const ALLOWED_CURRENCIES = SUPPORTED_CURRENCIES;
// Validated by SHAPE, not by membership: the set of UI languages lives in the
// frontend (one directory per locale, shipped by Weblate) and the backend image
// never sees those files. An allow-list here would silently 400 every new
// community translation until someone remembered to edit this line. A stored
// code the frontend doesn't have is harmless — i18next falls back to English.
const LANGUAGE_TAG = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const ALLOWED_RATING_SCALES = ['5', '20', '100'];
const ALLOWED_RACK_NAV = ['auto', 'room', 'rack'];
const ALLOWED_RESTOCK_SCOPE = ['all', 'cellar'];
const ALLOWED_VISIBILITY = ['public', 'private'];
const { SUPPORT_CATEGORIES } = require('../config/constants');

const err = (status, message) => ({ status, message });

// ── Preferences ──────────────────────────────────────────────────────────────

/**
 * Build the $set update for a preferences PATCH from a raw body, validating
 * every field. Async because defaultCellarId must be confirmed accessible to
 * the user. Returns { update } or { error }.
 */
async function buildPreferencesUpdate(userId, body = {}) {
  const { currency, language, ratingScale, rackNavigation, restockScope, defaultCellarId, notifications } = body;
  const update = {};

  // Notifications: per-category × per-channel booleans, explicitly allow-listed
  // so a caller can't inject arbitrary keys into preferences.notifications.
  if (notifications !== undefined && typeof notifications === 'object' && notifications !== null) {
    const setLeaf = (path, value) => { update[`preferences.notifications.${path}`] = !!value; };
    const dw = notifications.drinkWindow;
    if (dw && typeof dw === 'object') {
      if (dw.enabled !== undefined) setLeaf('drinkWindow.enabled', dw.enabled);
      if (dw.email   !== undefined) setLeaf('drinkWindow.email', dw.email);
      if (dw.push    !== undefined) setLeaf('drinkWindow.push', dw.push);
    }
    const cr = notifications.communityReply;
    if (cr && typeof cr === 'object') {
      if (cr.email !== undefined) setLeaf('communityReply.email', cr.email);
      if (cr.push  !== undefined) setLeaf('communityReply.push', cr.push);
    }
    const cm = notifications.communityMention;
    if (cm && typeof cm === 'object') {
      if (cm.email !== undefined) setLeaf('communityMention.email', cm.email);
      if (cm.push  !== undefined) setLeaf('communityMention.push', cm.push);
    }
    const cf = notifications.communityFollow;
    if (cf && typeof cf === 'object') {
      if (cf.push !== undefined) setLeaf('communityFollow.push', cf.push);
    }
  }

  if (currency !== undefined) {
    if (typeof currency !== 'string' || !ALLOWED_CURRENCIES.includes(currency.toUpperCase())) {
      return { error: err(400, `Invalid currency. Allowed: ${ALLOWED_CURRENCIES.join(', ')}`) };
    }
    update['preferences.currency'] = currency.toUpperCase();
  }

  if (language !== undefined) {
    if (typeof language !== 'string' || !LANGUAGE_TAG.test(language)) {
      return { error: err(400, 'Invalid language. Expected a language tag such as en, sv or fr.') };
    }
    update['preferences.language'] = language;
  }

  if (ratingScale !== undefined) {
    if (!ALLOWED_RATING_SCALES.includes(String(ratingScale))) {
      return { error: err(400, `Invalid rating scale. Allowed: ${ALLOWED_RATING_SCALES.join(', ')}`) };
    }
    update['preferences.ratingScale'] = String(ratingScale);
  }

  if (rackNavigation !== undefined) {
    if (!ALLOWED_RACK_NAV.includes(rackNavigation)) {
      return { error: err(400, `Invalid rack navigation. Allowed: ${ALLOWED_RACK_NAV.join(', ')}`) };
    }
    update['preferences.rackNavigation'] = rackNavigation;
  }

  if (restockScope !== undefined) {
    if (!ALLOWED_RESTOCK_SCOPE.includes(restockScope)) {
      return { error: err(400, 'Invalid restock scope. Allowed: all, cellar') };
    }
    update['preferences.restockScope'] = restockScope;
  }

  if (defaultCellarId !== undefined) {
    if (defaultCellarId === null) {
      update['preferences.defaultCellarId'] = null;
    } else {
      if (!mongoose.Types.ObjectId.isValid(defaultCellarId)) {
        return { error: err(400, 'Invalid cellar ID') };
      }
      const cellar = await Cellar.findOne({
        _id: defaultCellarId,
        deletedAt: null,
        $or: [{ user: userId }, { 'members.user': userId }],
      });
      if (!cellar) return { error: err(400, 'Cellar not found or not accessible') };
      update['preferences.defaultCellarId'] = defaultCellarId;
    }
  }

  if (Object.keys(update).length === 0) {
    return { error: err(400, 'No valid preferences provided') };
  }
  return { update };
}

/** Validate + persist a preferences update. Returns { user, changed } or { error }. */
async function updatePreferences(userId, body) {
  const { update, error } = await buildPreferencesUpdate(userId, body);
  if (error) return { error };
  const user = await User.findByIdAndUpdate(userId, { $set: update }, { new: true });
  if (!user) return { error: err(404, 'User not found') };
  return { user, changed: Object.keys(update) };
}

// ── Profile ──────────────────────────────────────────────────────────────────

/** Build the profile $set update, validating each field. Returns { update } or { error }. */
function buildProfileUpdate(body = {}) {
  const { displayName, bio, profileVisibility } = body;
  const update = {};

  if (displayName !== undefined) {
    const cleaned = stripHtml(displayName);
    if (cleaned && cleaned.length > 50) {
      return { error: err(400, 'Display name too long (max 50 characters)') };
    }
    update.displayName = cleaned || null;
  }

  if (bio !== undefined) {
    const cleaned = stripHtml(bio);
    if (cleaned && cleaned.length > 500) {
      return { error: err(400, 'Bio too long (max 500 characters)') };
    }
    update.bio = cleaned || null;
  }

  if (profileVisibility !== undefined) {
    if (!ALLOWED_VISIBILITY.includes(profileVisibility)) {
      return { error: err(400, 'Invalid visibility. Allowed: public, private') };
    }
    update.profileVisibility = profileVisibility;
  }

  if (Object.keys(update).length === 0) {
    return { error: err(400, 'No valid fields provided') };
  }
  return { update };
}

/** Validate + persist a profile update. Returns { user, changed } or { error }. */
async function updateProfile(userId, body) {
  const { update, error } = buildProfileUpdate(body);
  if (error) return { error };
  const user = await User.findByIdAndUpdate(userId, { $set: update }, { new: true });
  if (!user) return { error: err(404, 'User not found') };
  return { user, changed: Object.keys(update) };
}

// ── Support ticket ───────────────────────────────────────────────────────────

/** Validate + create a support ticket. Returns { ticket } or { error }. */
async function createSupportTicket(userId, { category, subject, message } = {}) {
  if (!SUPPORT_CATEGORIES.includes(category)) {
    return { error: err(400, 'Invalid category') };
  }
  if (!subject || !String(subject).trim()) return { error: err(400, 'Subject is required') };
  if (!message || !String(message).trim()) return { error: err(400, 'Message is required') };
  if (String(subject).trim().length > 200) {
    return { error: err(400, 'Subject must be 200 characters or fewer') };
  }
  if (String(message).trim().length > 5000) {
    return { error: err(400, 'Message must be 5000 characters or fewer') };
  }
  const ticket = await SupportTicket.create({
    user: userId,
    category,
    subject: stripHtml(subject),
    message: stripHtml(message),
  });
  return { ticket };
}

// Max follow-ups per ticket — it's a support conversation, not a chat channel.
const TICKET_REPLY_CAP = 30;

/**
 * Append the USER's follow-up to their own ticket's conversation. The web
 * reply box (POST /api/support/:id/reply) and the MCP reply_to_ticket tool
 * share this. Closed tickets refuse — the path there is a fresh ticket. A
 * user reply flips status back to 'open' so the ticket resurfaces in the
 * admin queue (sorted by status + recency).
 */
async function replyToTicket(userId, ticketId, message) {
  if (!mongoose.Types.ObjectId.isValid(String(ticketId))) {
    return { error: err(404, 'Ticket not found') };
  }
  if (!message || !String(message).trim()) return { error: err(400, 'Message is required') };
  if (String(message).trim().length > 5000) {
    return { error: err(400, 'Message must be 5000 characters or fewer') };
  }
  const ticket = await SupportTicket.findOne({ _id: ticketId, user: userId });
  if (!ticket) return { error: err(404, 'Ticket not found') };
  if (ticket.status === 'closed') {
    return { error: err(409, 'This ticket is closed — open a new ticket instead') };
  }
  if ((ticket.replies || []).length >= TICKET_REPLY_CAP) {
    return { error: err(400, `This ticket already has ${TICKET_REPLY_CAP} replies — open a new ticket to continue`) };
  }
  ticket.replies.push({ author: 'user', by: userId, message: stripHtml(message) });
  ticket.status = 'open';
  await ticket.save();
  return { ticket };
}

// ── Wine-addition request (the resolve-dead-end fallback) ─────────────────────

/**
 * Validate a source URL for a new-wine request. Rejects non-http(s) and any URL
 * pointing at a private/internal address — the same SSRF-aware check the REST
 * route has always applied (an admin later opens this link). Returns an error
 * string, or null when valid.
 */
function validateSourceUrl(url) {
  if (!url || typeof url !== 'string') return 'Source URL is required';
  if (url.length > 2048) return 'URL is too long (max 2048 characters)';
  let parsed;
  try { parsed = new URL(url); } catch { return 'Please provide a valid URL'; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'URL must use http or https protocol';
  // Strip the brackets URL keeps on an IPv6 .hostname so net.isIP can classify it.
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  // localhost is a name, not an IP literal — reject it (and its subdomains) by name.
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return 'URLs pointing to private/internal addresses are not allowed';
  }
  // For IP-literal hosts, reuse the structural private/reserved classifier the
  // image-fetch SSRF guard uses (security audit L-1). WHATWG `new URL` already
  // canonicalizes decimal/hex/octal IPv4 to dotted-quad; isPrivateAddress adds
  // the IPv6 / ULA / link-local / v4-mapped forms the old lexical denylist
  // missed. DNS names are intentionally left as-is: this value is stored and
  // rendered as a link, never fetched by the server, so no DNS resolution here.
  if (net.isIP(host) && isPrivateAddress(host)) {
    return 'URLs pointing to private/internal addresses are not allowed';
  }
  return null;
}

/**
 * Validate + create a `new_wine` WineRequest (the fallback when resolve_wine
 * dead-ends and the user can't confirm enough to mint a registry entry). Returns
 * { wineRequest } or { error }. The grape_suggestion request type is deliberately
 * NOT handled here — it stays inline in the REST route (niche, needs a linked
 * wine) and is not exposed over MCP.
 */
async function createWineRequest(userId, { wineName, sourceUrl, image } = {}) {
  if (!wineName) return { error: err(400, 'Wine name and source URL are required') };
  const urlErr = validateSourceUrl(sourceUrl);
  if (urlErr) return { error: err(400, urlErr) };

  const trimmedName = String(wineName).trim();
  const trimmedImage = image ? String(image).trim() : '';
  if (trimmedName.length > 300) {
    return { error: err(400, 'Wine name must be 300 characters or fewer') };
  }
  if (trimmedImage.length > 500000) {
    return { error: err(400, 'Image reference is too large') };
  }

  const wineRequest = new WineRequest({
    requestType: 'new_wine',
    wineName: trimmedName,
    sourceUrl: sourceUrl.trim(),
    image: trimmedImage || null,
    user: userId,
    status: 'pending',
  });
  await wineRequest.save();
  return { wineRequest };
}

module.exports = {
  buildPreferencesUpdate,
  updatePreferences,
  buildProfileUpdate,
  updateProfile,
  createSupportTicket,
  replyToTicket,
  TICKET_REPLY_CAP,
  createWineRequest,
  validateSourceUrl,
  // Exposed so the MCP tool descriptions/schemas can enumerate the same options.
  ALLOWED_CURRENCIES,
  LANGUAGE_TAG,
  ALLOWED_RATING_SCALES,
  ALLOWED_RACK_NAV,
  ALLOWED_RESTOCK_SCOPE,
  ALLOWED_VISIBILITY,
  SUPPORT_CATEGORIES,
};
