/**
 * GDPR portability for User.lastActiveAt: the account export is an explicit
 * field pick (services/userDataRegistry), so a field left out of it is simply
 * absent from a subject access request. The day the account was last used is
 * what the inactive-account rule reads, so the person is shown it too.
 */
jest.mock('./search', () => ({ removeBottles: jest.fn(), indexDiscussion: jest.fn() }));

const User = require('../models/User');
const { REGISTRY } = require('./userDataRegistry');

const accountEntry = REGISTRY.find((e) => e.model === User);

test('the account export carries the last active day', async () => {
  const lastActiveAt = new Date('2026-10-31T00:00:00Z');
  const frag = await accountEntry.exportFragment({ user: { username: 'anna', lastActiveAt } });
  expect(frag.account.lastActiveAt).toEqual(lastActiveAt);
});

test('an account not seen since the field existed exports null, not undefined', async () => {
  const frag = await accountEntry.exportFragment({ user: { username: 'anna' } });
  expect(frag.account).toHaveProperty('lastActiveAt', null);
  expect(frag.account).toHaveProperty('inactivityNotice', null);
});

test('while an unused account is on its way to deletion, the notices and the date are in the export', async () => {
  const inactivityNotice = {
    firstSentAt: new Date('2028-10-01T09:13:00Z'), finalSentAt: null, deleteAfter: new Date('2028-11-01T00:00:00Z'),
    emailed: true, unusedSince: new Date('2026-11-01T00:00:00Z'),
  };
  const frag = await accountEntry.exportFragment({ user: { username: 'anna', inactivityNotice } });
  expect(frag.account.inactivityNotice).toEqual({
    firstSentAt: inactivityNotice.firstSentAt, finalSentAt: null, deleteAfter: inactivityNotice.deleteAfter,
  });
});
