const User = require('../models/User');

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
    const name = match[1].toLowerCase();
    usernames.add(name);
    // The regex greedily swallows trailing sentence punctuation that is also a
    // valid username char ("thanks @alice." captures "alice."). Also try the
    // variant with trailing [._-] stripped so the intended user still resolves;
    // whichever form actually exists in the DB matches below.
    const stripped = name.replace(/[._-]+$/, '');
    if (stripped !== name && stripped.length >= 3) usernames.add(stripped);
    if (usernames.size >= MAX_MENTIONS_PER_POST) break;
  }
  if (usernames.size === 0) return [];

  // The User schema stores usernames lowercased (lowercase: true) and unique;
  // extractMentions lowercases too, so a plain string $in matches exactly and
  // uses the unique index (a case-insensitive regex $in would defeat it).
  const users = await User.find({ username: { $in: [...usernames] } }).select('_id').lean();

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
