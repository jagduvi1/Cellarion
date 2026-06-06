const User = require('../models/User');
const { escapeRegex } = require('./sanitize');

// Match @<username> tokens in body text. Allowed username chars mirror the
// ones the registration flow accepts: letters, digits, dot, hyphen, underscore.
// Length 3–32 to match the User model. Negative-look-behind on `\w` so we don't
// match the @ in email addresses (e.g. user@example.com).
const MENTION_RE = /(?<![\w.])@([a-zA-Z0-9._-]{3,32})/g;

// Hard cap on how many mentions a single post can fan out to. Spam guard —
// without this, a post could ping every user in the system. 10 is generous
// for the wine-talk use case (mentioning a few friends in a thread).
const MAX_MENTIONS_PER_POST = 10;

/**
 * Extract @username tokens from a post body and resolve them to User IDs.
 * Case-insensitive on usernames. Returns an array of unique ObjectIds for users
 * that exist; usernames that don't match any user are silently dropped.
 *
 * @param {string} body — the discussion or reply body text
 * @param {string|null} excludeUserId — optionally exclude this user (e.g. the
 *   author themselves, so they don't get notified for self-mentions)
 * @returns {Promise<string[]>} list of user IDs to notify
 */
async function extractMentions(body, excludeUserId = null) {
  if (!body || typeof body !== 'string') return [];

  const usernames = new Set();
  for (const match of body.matchAll(MENTION_RE)) {
    usernames.add(match[1].toLowerCase());
    if (usernames.size >= MAX_MENTIONS_PER_POST) break;
  }
  if (usernames.size === 0) return [];

  // Mongoose username field is unique but stored as-typed. Match
  // case-insensitively via a single $in regex.
  const regexes = [...usernames].map(u => new RegExp(`^${escapeRegex(u)}$`, 'i'));
  const users = await User.find({ username: { $in: regexes } }).select('_id').lean();

  const ids = users
    .map(u => u._id.toString())
    .filter(id => !excludeUserId || id !== String(excludeUserId));

  return Array.from(new Set(ids));
}

module.exports = {
  extractMentions,
  MENTION_RE,
  MAX_MENTIONS_PER_POST
};
