/**
 * The supporter thank-you must reach each account exactly once, ever.
 *
 * The plan webhook is a poor "they just subscribed" signal — it also fires on
 * renewals, on payment-method changes, on a supporter -> patron switch, and
 * again whenever Stripe redelivers an event. So every test here is really the
 * same question from a different angle: can this send twice?
 */

jest.mock('../models/User', () => ({ findOneAndUpdate: jest.fn() }));
jest.mock('./mailgun', () => ({
  sendSupporterThankYou: jest.fn().mockResolvedValue(undefined),
  EMAIL_VERIFICATION_ENABLED: true,
}));
jest.mock('./audit', () => ({ logAudit: jest.fn() }));

const User = require('../models/User');
const { sendSupporterThankYou } = require('./mailgun');
const { maybeSendSupporterThankYou } = require('./supporterThankYou');

/** findOneAndUpdate(...).select(...) — resolves to `doc`, or null if unmatched. */
const claimReturns = (doc) => {
  User.findOneAndUpdate.mockReturnValue({ select: () => Promise.resolve(doc) });
};

const PAID_USER = { _id: 'u1', email: 'a@example.com', username: 'ann', plan: 'supporter' };

beforeEach(() => jest.clearAllMocks());

test('a first-time supporter is thanked, addressed by their actual tier', async () => {
  claimReturns(PAID_USER);

  await expect(maybeSendSupporterThankYou('u1')).resolves.toBe(true);
  expect(sendSupporterThankYou).toHaveBeenCalledWith('a@example.com', 'ann', 'supporter');
});

test('the claim only matches an account that has NEVER been thanked', async () => {
  claimReturns(PAID_USER);
  await maybeSendSupporterThankYou('u1');

  const [filter, update] = User.findOneAndUpdate.mock.calls[0];
  // The null check is what makes this once-ever; without it every renewal sends.
  expect(filter.supporterThankYouSentAt).toBeNull();
  expect(filter.plan).toEqual({ $in: ['supporter', 'patron'] });
  expect(update.$set.supporterThankYouSentAt).toBeInstanceOf(Date);
});

test('an account already thanked gets nothing', async () => {
  claimReturns(null); // filter did not match — stamp already set

  await expect(maybeSendSupporterThankYou('u1')).resolves.toBe(false);
  expect(sendSupporterThankYou).not.toHaveBeenCalled();
});

test('upgrading supporter -> patron does NOT thank them again', async () => {
  claimReturns(PAID_USER);
  await maybeSendSupporterThankYou('u1');
  expect(sendSupporterThankYou).toHaveBeenCalledTimes(1);

  // The upgrade fires the webhook again; the stamp is now set, so the claim
  // matches nothing.
  claimReturns(null);
  await maybeSendSupporterThankYou('u1');

  expect(sendSupporterThankYou).toHaveBeenCalledTimes(1);
});

test('a redelivered webhook racing itself sends once', async () => {
  // Whichever claim lands first wins; the loser sees no match.
  let first = true;
  User.findOneAndUpdate.mockImplementation(() => ({
    select: () => Promise.resolve(first ? ((first = false), PAID_USER) : null),
  }));

  const results = await Promise.all([
    maybeSendSupporterThankYou('u1'),
    maybeSendSupporterThankYou('u1'),
    maybeSendSupporterThankYou('u1'),
  ]);

  expect(results.filter(Boolean)).toHaveLength(1);
  expect(sendSupporterThankYou).toHaveBeenCalledTimes(1);
});

test('an account with no email is never mailed', async () => {
  claimReturns({ ...PAID_USER, email: null });

  await expect(maybeSendSupporterThankYou('u1')).resolves.toBe(false);
  expect(sendSupporterThankYou).not.toHaveBeenCalled();
});

test('a mail failure never propagates — billing must not break', async () => {
  claimReturns(PAID_USER);
  sendSupporterThankYou.mockRejectedValueOnce(new Error('mailgun 500'));

  await expect(maybeSendSupporterThankYou('u1')).resolves.toBe(false);
});

describe('when mail is not configured (the self-hosted default)', () => {
  test('the stamp is not claimed, so the one chance is not burned', async () => {
    jest.resetModules();
    jest.doMock('./mailgun', () => ({
      sendSupporterThankYou: jest.fn(),
      EMAIL_VERIFICATION_ENABLED: false,
    }));
    jest.doMock('../models/User', () => ({ findOneAndUpdate: jest.fn() }));
    jest.doMock('./audit', () => ({ logAudit: jest.fn() }));

    const UserOff = require('../models/User');
    const { maybeSendSupporterThankYou: fn } = require('./supporterThankYou');

    await expect(fn('u1')).resolves.toBe(false);
    expect(UserOff.findOneAndUpdate).not.toHaveBeenCalled();
  });
});
