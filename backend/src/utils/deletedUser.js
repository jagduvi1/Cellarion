const crypto = require('crypto');
const User = require('../models/User');

// Sentinel "[deleted]" user used to anonymise forum content when a real user
// closes their account. The actual identifying data is wiped from the User
// row (the row itself is removed); their threads + replies get re-pointed
// at this sentinel so the conversation stays intact for other users.
//
// The sentinel can never be authenticated as: the bcrypt hash is intentionally
// invalid, profileVisibility is private (excludes from search), and the
// double-underscore prefix sits outside the conventional username allowlist.
const SENTINEL_USERNAME = '__deleted__';
const SENTINEL_EMAIL    = 'deleted@cellarion.invalid';

// Module-level cache so we don't hit the DB every time userDeletionJob runs.
let cachedId = null;

async function getOrCreateDeletedUser() {
  if (cachedId) return cachedId;

  const existing = await User.findOne({ username: SENTINEL_USERNAME }).select('_id');
  if (existing) {
    cachedId = existing._id;
    return cachedId;
  }

  // Required password field. Audit 2026-09 O05-6: the old literal "invalid
  // hash" string was itself hashed by the pre-save hook and so became a VALID
  // password anyone could read in the repository. A random secret nobody ever
  // sees is unknowable in practice, whatever the hook does to it.
  const created = await User.create({
    username: SENTINEL_USERNAME,
    email: SENTINEL_EMAIL,
    password: crypto.randomBytes(48).toString('hex'),
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
  SENTINEL_USERNAME,
  SENTINEL_EMAIL
};
