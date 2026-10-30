const crypto = require('crypto');
const User = require('../models/User');

// Sentinel "[deleted]" user used to anonymise forum content when a real user
// closes their account. The actual identifying data is wiped from the User
// row (the row itself is removed); their threads + replies get re-pointed
// at this sentinel so the conversation stays intact for other users.
//
// The sentinel can never be authenticated as: the bcrypt hash is intentionally
// invalid and profileVisibility is private (excludes from search).
//
// The sentinel is found BY USERNAME, so a person holding its name would become
// it and inherit every erased member's content. Every double-underscore name is
// reserved for system accounts: registration refuses one and SSO never derives
// one (isReservedUsername). The rule lives here, not in the User model, because
// the sentinel itself is created through that model.
const SENTINEL_USERNAME = '__deleted__';
const SENTINEL_EMAIL    = 'deleted@cellarion.invalid';

// Compared the way the User schema stores a username: trimmed, lowercase.
function isReservedUsername(name) {
  const n = typeof name === 'string' ? name.trim().toLowerCase() : '';
  return n === SENTINEL_USERNAME || n.startsWith('__');
}

// Module-level cache so we don't hit the DB every time userDeletionJob runs.
let cachedId = null;

async function getOrCreateDeletedUser() {
  if (cachedId) return cachedId;

  const existing = await User.findOne({ username: SENTINEL_USERNAME }).select('_id');
  if (existing) {
    cachedId = existing._id;
    return cachedId;
  }

  // Required password field: a random secret nobody ever sees, so it is
  // unknowable whatever the pre-save hook does to it (a fixed string here
  // would be a valid password anyone could read in the repository). The
  // schema's complexity rule runs on create, so the fixed "Aa1!" prefix
  // supplies the upper, lower, digit and special classes — the same pattern
  // as the demo accounts — and the random hex the length.
  const created = await User.create({
    username: SENTINEL_USERNAME,
    email: SENTINEL_EMAIL,
    password: 'Aa1!' + crypto.randomBytes(48).toString('hex'),
    displayName: null,
    profileVisibility: 'private',
    emailVerified: false,
    roles: ['user']
  });
  cachedId = created._id;
  return cachedId;
}

module.exports = {
  getOrCreateDeletedUser,
  isReservedUsername,
  SENTINEL_USERNAME,
  SENTINEL_EMAIL
};
