/**
 * Make a member of a self-hosted install an admin (or take the role away).
 *
 * A fresh install has no admin, and nothing in the app can make one: the role
 * is granted by an admin. Run this once from the backend container after you
 * have registered your own account (on TrueNAS: Apps → Cellarion → Shell on
 * the backend container; with Docker: `docker exec -it cellarion-backend …`).
 *
 *   node src/scripts/make-admin.js <username or email>            # grant admin
 *   node src/scripts/make-admin.js <username or email> --remove   # remove it
 *
 * The person signs out and in again afterwards: roles travel in the sign-in
 * token. The change is recorded in the audit log (user.role.admin_granted /
 * user.role.admin_removed).
 *
 * Deliberately a command, not an environment variable that makes an email
 * address admin: without mail configured nobody's address is verified, so
 * whoever registered that address first would become admin.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');

const USAGE = 'Usage: node src/scripts/make-admin.js <username or email> [--remove]';

const exactly = (s) => new RegExp(`^${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');

/**
 * @param {string} identifier  username or email, matched exactly (any case)
 * @param {{remove?: boolean}} [opts]
 * @returns {Promise<{ok:boolean, message:string, roles?:string[]}>}
 */
async function makeAdmin(identifier, { remove = false } = {}) {
  const id = String(identifier || '').trim();
  if (!id) return { ok: false, message: USAGE };

  const matches = await User.find({ $or: [{ username: exactly(id) }, { email: exactly(id) }] })
    .select('username roles')
    .limit(2)
    .lean();
  if (matches.length === 0) return { ok: false, message: `No account with the username or email "${id}". Register it first.` };
  if (matches.length > 1) return { ok: false, message: `"${id}" matches more than one account. Use the exact username.` };

  const user = matches[0];
  const current = Array.isArray(user.roles) && user.roles.length ? user.roles : ['user'];
  const has = current.includes('admin');
  if (has !== remove) {
    return { ok: true, message: `${user.username} ${remove ? 'is not an admin' : 'is already an admin'}. Nothing changed.`, roles: current };
  }

  const roles = remove
    ? current.filter((r) => r !== 'admin')
    : [...current, 'admin'];
  if (!roles.includes('user')) roles.unshift('user');

  await User.updateOne({ _id: user._id }, { $set: { roles } });
  await AuditLog.create({
    actor: { userId: null, role: 'system' },
    action: remove ? 'user.role.admin_removed' : 'user.role.admin_granted',
    resource: { type: 'user', id: user._id },
    detail: { username: user.username, via: 'script' },
  });
  return {
    ok: true,
    message: `${user.username} ${remove ? 'is no longer an admin' : 'is now an admin'}. Roles: ${roles.join(', ')}. Sign out and in again to see the change.`,
    roles,
  };
}

module.exports = { makeAdmin };

if (require.main === module) {
  const args = process.argv.slice(2);
  const remove = args.includes('--remove');
  const identifier = args.find((a) => !a.startsWith('--'));
  (async () => {
    await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/winecellar');
    const result = await makeAdmin(identifier, { remove });
    console.log(result.message);
    await mongoose.disconnect();
    process.exit(result.ok ? 0 : 1);
  })().catch((err) => { console.error(err); process.exit(1); });
}
