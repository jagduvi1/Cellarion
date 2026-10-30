/**
 * getOrCreateDeletedUser — the "[deleted]" sentinel must be creatable.
 *
 * WHY THIS TEST EXISTS:
 * The sentinel is created the first time an account is erased (or a demo
 * account swept) on a database that does not hold it yet — every fresh
 * self-hosted install. User.create runs the schema validators, including the
 * password complexity rule, so a secret that fails that rule makes the first
 * erasure throw inside the purge.
 */
const User = require('../models/User');
const { getOrCreateDeletedUser, SENTINEL_USERNAME } = require('./deletedUser');

afterEach(() => jest.restoreAllMocks());

test('the sentinel it creates passes the User schema, the password rule included', async () => {
  jest.spyOn(User, 'findOne').mockReturnValue({ select: () => Promise.resolve(null) });
  let created = null;
  jest.spyOn(User, 'create').mockImplementation(async (doc) => {
    created = doc;
    const err = new User(doc).validateSync();
    if (err) throw err;
    return { _id: 'sentinel-id' };
  });

  await expect(getOrCreateDeletedUser()).resolves.toBe('sentinel-id');
  expect(created.username).toBe(SENTINEL_USERNAME);
  expect(created.profileVisibility).toBe('private');
});
