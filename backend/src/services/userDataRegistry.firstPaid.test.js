/**
 * GDPR portability for User.firstPaidAt: the account export is an explicit
 * field pick (services/userDataRegistry), so a field left out of it is simply
 * absent from a subject access request. The date outlives the subscription, so
 * the person is shown that it is kept.
 */
jest.mock('./search', () => ({ indexDiscussion: jest.fn() }));

const User = require('../models/User');
const { REGISTRY } = require('./userDataRegistry');

const accountEntry = REGISTRY.find((e) => e.model === User);

test('the account export carries when the account first paid for support', async () => {
  const firstPaidAt = new Date('2025-02-01T09:00:00Z');
  const frag = await accountEntry.exportFragment({ user: { username: 'anna', firstPaidAt } });
  expect(frag.account.firstPaidAt).toEqual(firstPaidAt);
});

test('an account that never paid exports null, not undefined', async () => {
  const frag = await accountEntry.exportFragment({ user: { username: 'anna' } });
  expect(frag.account).toHaveProperty('firstPaidAt', null);
});
