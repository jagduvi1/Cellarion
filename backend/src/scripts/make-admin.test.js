/**
 * scripts/make-admin — how a self-hosted install gets its admin.
 *
 * WHY THIS TEST EXISTS:
 * A fresh install had no way to make anyone admin: the only script was
 * hard-coded to one account (2026-10-20). This one takes a username or email,
 * matches it exactly, refuses an ambiguous match, keeps the other roles, is a
 * no-op when nothing needs changing, and writes an audit row when it changes.
 */
jest.mock('../models/User', () => ({ find: jest.fn(), updateOne: jest.fn() }));
jest.mock('../models/AuditLog', () => ({ create: jest.fn() }));

const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const { makeAdmin } = require('./make-admin');

const found = (rows) => User.find.mockReturnValue({ select: () => ({ limit: () => ({ lean: () => Promise.resolve(rows) }) }) });
const UID = '64b000000000000000000001';

beforeEach(() => {
  jest.clearAllMocks();
  User.updateOne.mockResolvedValue({});
  AuditLog.create.mockResolvedValue({});
});

test('grants admin by username or email, keeps the other roles, and audits it', async () => {
  found([{ _id: UID, username: 'anna', roles: ['user', 'somm'] }]);

  const res = await makeAdmin('Anna@Example.com');

  expect(res.ok).toBe(true);
  expect(res.roles).toEqual(['user', 'somm', 'admin']);
  const [query] = User.find.mock.calls[0];
  expect(query.$or[0].username.test('anna@example.com')).toBe(true);
  expect(query.$or[1].email.test('anna@example.com')).toBe(true);
  expect(User.updateOne).toHaveBeenCalledWith({ _id: UID }, { $set: { roles: ['user', 'somm', 'admin'] } });
  expect(AuditLog.create).toHaveBeenCalledWith(expect.objectContaining({
    action: 'user.role.admin_granted', resource: { type: 'user', id: UID },
  }));
});

test('matches exactly: a regex character in the name is literal', async () => {
  found([]);
  await makeAdmin('an.a');
  const [query] = User.find.mock.calls[0];
  expect(query.$or[0].username.test('anxa')).toBe(false);
  expect(query.$or[0].username.test('an.a')).toBe(true);
});

test('--remove takes admin away and keeps user', async () => {
  found([{ _id: UID, username: 'anna', roles: ['admin'] }]);

  const res = await makeAdmin('anna', { remove: true });

  expect(res.roles).toEqual(['user']);
  expect(AuditLog.create).toHaveBeenCalledWith(expect.objectContaining({ action: 'user.role.admin_removed' }));
});

test('already admin (or already not): nothing is written', async () => {
  found([{ _id: UID, username: 'anna', roles: ['user', 'admin'] }]);
  expect((await makeAdmin('anna')).message).toMatch(/already an admin/);
  found([{ _id: UID, username: 'anna', roles: ['user'] }]);
  expect((await makeAdmin('anna', { remove: true })).message).toMatch(/is not an admin/);
  expect(User.updateOne).not.toHaveBeenCalled();
  expect(AuditLog.create).not.toHaveBeenCalled();
});

test('no match, an ambiguous match and a missing argument are refused', async () => {
  found([]);
  expect(await makeAdmin('nobody')).toMatchObject({ ok: false });
  found([{ _id: UID, username: 'a' }, { _id: '64b000000000000000000002', username: 'b' }]);
  expect(await makeAdmin('a')).toMatchObject({ ok: false, message: expect.stringMatching(/more than one/) });
  expect(await makeAdmin('')).toMatchObject({ ok: false, message: expect.stringMatching(/Usage/) });
  expect(User.updateOne).not.toHaveBeenCalled();
});
