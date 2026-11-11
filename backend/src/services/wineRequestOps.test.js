/**
 * Finishing a wine request (services/wineRequestOps).
 *
 * Pins the race guard: the status write only lands while the stored request
 * is STILL pending (the save carries `$where: { status: 'pending' }`). The
 * hourly bridge sync holds a loaded request for minutes; an admin deciding it
 * meanwhile must not be overwritten — the second one gets null back, moves no
 * bottles and sends no second notification.
 */
jest.mock('../models/WineRequest', () => ({ findOneAndUpdate: jest.fn(), exists: jest.fn(), updateOne: jest.fn() }));
jest.mock('../models/Bottle', () => ({ distinct: jest.fn().mockResolvedValue([]), updateMany: jest.fn().mockResolvedValue({ modifiedCount: 0 }) }));
jest.mock('../models/BottleImage', () => ({ updateMany: jest.fn().mockResolvedValue({}) }));
jest.mock('./dataVersion', () => ({ bumpDataVersion: jest.fn() }));
jest.mock('./notifications', () => ({ createNotification: jest.fn() }));
jest.mock('../utils/vintageProfile', () => ({ ensurePendingVintageProfile: jest.fn() }));

const WineRequest = require('../models/WineRequest');
const Bottle = require('../models/Bottle');
const { createNotification } = require('./notifications');
const { claimRequest, releaseRequestClaim, completeRequestResolve, completeRequestReject } = require('./wineRequestOps');

const notFound = () => Object.assign(new Error('No document found'), { name: 'DocumentNotFoundError' });
const requestDoc = (save) => {
  const doc = { _id: 'r1', user: 'u1', wineName: 'X', requestType: 'new_wine', status: 'pending', claimedAt: null, markModified: jest.fn() };
  doc.save = jest.fn(async () => {
    doc.whereAtSave = doc.$where; // what Mongoose would add to the save's filter
    return save();
  });
  return doc;
};
const wine = { _id: 'w1', name: 'Y', producer: 'Z' };

beforeEach(() => {
  jest.clearAllMocks();
  // A caller that has not taken the request gets it here, as the bridge sync does.
  WineRequest.findOneAndUpdate.mockImplementation(async () => ({ _id: 'r1' }));
  WineRequest.exists.mockResolvedValue(null);
  WineRequest.updateOne.mockResolvedValue({});
});

describe('completeRequestResolve', () => {
  test('saves only while still pending, then moves the bottles and notifies', async () => {
    const doc = requestDoc(async () => {});
    const out = await completeRequestResolve(doc, wine, { resolvedBy: 'admin1', adminNotes: 'ok' });
    expect(out).toEqual({ backfilledCount: 0 });
    expect(doc.whereAtSave).toEqual({ status: 'pending' });
    expect(doc.$where).toBeUndefined(); // cleared, so a later save is unfiltered
    expect(Bottle.updateMany).toHaveBeenCalled();
    expect(createNotification).toHaveBeenCalledWith('u1', 'wine_request_resolved', expect.any(String), expect.any(String), '/wine-requests');
  });

  test('decided meanwhile: null, no bottles moved, no notification', async () => {
    const doc = requestDoc(async () => { throw notFound(); });
    expect(await completeRequestResolve(doc, wine, {})).toBeNull();
    expect(Bottle.updateMany).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
    expect(doc.$where).toBeUndefined();
  });

  test('filed through the Registry Bridge by an install that follows it: resolved without a notification here (the install tells its user)', async () => {
    const doc = Object.assign(requestDoc(async () => {}), { via: 'bridge', installFollowsAt: new Date() });
    expect(await completeRequestResolve(doc, wine, { resolvedBy: 'admin1' })).toEqual({ backfilledCount: 0 });
    expect(doc.status).toBe('resolved');
    expect(createNotification).not.toHaveBeenCalled();
  });

  test('a bridge request no install follows (older than v1.252.0) still notifies the key owner here — the only signal', async () => {
    const doc = Object.assign(requestDoc(async () => {}), { via: 'bridge', installFollowsAt: null });
    await completeRequestResolve(doc, wine, { resolvedBy: 'admin1' });
    expect(createNotification).toHaveBeenCalledWith('u1', 'wine_request_resolved', expect.any(String), expect.any(String), '/wine-requests');
  });

  test('resolved to a wine the bridge does not serve: notified here, because the install can never copy it', async () => {
    for (const hidden of [{ pendingIdentity: true }, { nonWine: true }]) {
      createNotification.mockClear();
      const doc = Object.assign(requestDoc(async () => {}), { via: 'bridge', installFollowsAt: new Date() });
      await completeRequestResolve(doc, { ...wine, ...hidden }, { resolvedBy: 'admin1' });
      expect(createNotification).toHaveBeenCalledTimes(1);
    }
  });

  test('any other save error still throws', async () => {
    const doc = requestDoc(async () => { throw new Error('db down'); });
    await expect(completeRequestResolve(doc, wine, {})).rejects.toThrow('db down');
  });
});

describe('completeRequestReject', () => {
  test('decided meanwhile: null and no notification', async () => {
    const doc = requestDoc(async () => { throw notFound(); });
    expect(await completeRequestReject(doc, { adminNotes: 'no' })).toBeNull();
    expect(doc.whereAtSave).toEqual({ status: 'pending' });
    expect(createNotification).not.toHaveBeenCalled();
  });

  test('still pending: rejected with the trimmed reason and the requester told', async () => {
    const doc = requestDoc(async () => {});
    expect(await completeRequestReject(doc, { resolvedBy: 'admin1', adminNotes: '  a cider  ' })).toEqual({ bottlesDetached: 0 });
    expect(doc.status).toBe('rejected');
    expect(doc.adminNotes).toBe('a cider');
    expect(createNotification).toHaveBeenCalledWith('u1', 'wine_request_rejected', expect.any(String), expect.stringContaining('a cider'), '/wine-requests');
  });

  test('filed through the Registry Bridge by an install that follows it: rejected without a notification here', async () => {
    const doc = Object.assign(requestDoc(async () => {}), { via: 'bridge', installFollowsAt: new Date() });
    expect(await completeRequestReject(doc, { resolvedBy: 'admin1', adminNotes: 'a cider' })).toEqual({ bottlesDetached: 0 });
    expect(doc.status).toBe('rejected');
    expect(createNotification).not.toHaveBeenCalled();
  });

  test('a bridge request no install follows: the decline still notifies here', async () => {
    const doc = Object.assign(requestDoc(async () => {}), { via: 'bridge' });
    await completeRequestReject(doc, { resolvedBy: 'admin1', adminNotes: 'a cider' });
    expect(createNotification).toHaveBeenCalledWith('u1', 'wine_request_rejected', expect.any(String), expect.stringContaining('a cider'), '/wine-requests');
  });
});

// One decision at a time: a resolve creates the wine BEFORE the status write,
// so two that both saw "pending" each created one. A decision takes the
// request first; the second is refused before it does anything.
describe('claimRequest', () => {
  test('takes a pending request nobody holds, or one whose claim is older than five minutes', async () => {
    const stored = { _id: 'r1', status: 'pending' };
    WineRequest.findOneAndUpdate.mockResolvedValue(stored);
    const before = Date.now();
    expect(await claimRequest('r1')).toEqual({ request: stored });

    const [filter, update, options] = WineRequest.findOneAndUpdate.mock.calls[0];
    expect(filter).toMatchObject({ _id: 'r1', status: 'pending' });
    expect(filter.$or[0]).toEqual({ claimedAt: null });
    const staleBefore = filter.$or[1].claimedAt.$lt.getTime();
    expect(before - staleBefore).toBeGreaterThanOrEqual(5 * 60 * 1000 - 50);
    expect(before - staleBefore).toBeLessThanOrEqual(5 * 60 * 1000 + 5000);
    expect(update.$set.claimedAt).toBeInstanceOf(Date);
    expect(options).toEqual({ new: true });
  });

  test('another decision holds it: refused as busy', async () => {
    WineRequest.findOneAndUpdate.mockResolvedValue(null);
    WineRequest.exists.mockResolvedValue({ _id: 'r1' });
    expect(await claimRequest('r1')).toEqual({ refused: 'busy' });
    expect(WineRequest.exists).toHaveBeenCalledWith({ _id: 'r1', status: 'pending' });
  });

  test('no longer pending, or not there: refused as decided', async () => {
    WineRequest.findOneAndUpdate.mockResolvedValue(null);
    WineRequest.exists.mockResolvedValue(null);
    expect(await claimRequest('r1')).toEqual({ refused: 'decided' });
  });

  test('releaseRequestClaim clears the claim of a request that is still pending, and of no other', async () => {
    await releaseRequestClaim('r1');
    expect(WineRequest.updateOne).toHaveBeenCalledWith({ _id: 'r1', status: 'pending' }, { $set: { claimedAt: null } });
  });
});

describe('a decision holds the request', () => {
  test('a caller that has not taken the request gets it taken here (the bridge sync)', async () => {
    const doc = requestDoc(async () => {});
    expect(await completeRequestResolve(doc, wine, {})).toEqual({ backfilledCount: 0 });
    expect(WineRequest.findOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  test('a caller that holds it is not asked again', async () => {
    const doc = requestDoc(async () => {});
    await completeRequestResolve(doc, wine, { holdsClaim: true });
    await completeRequestReject(requestDoc(async () => {}), { adminNotes: 'no such wine', holdsClaim: true });
    expect(WineRequest.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test('resolve while another decision holds it: null, nothing saved, no bottles moved, no notification', async () => {
    WineRequest.findOneAndUpdate.mockResolvedValue(null);
    WineRequest.exists.mockResolvedValue({ _id: 'r1' });
    const doc = requestDoc(async () => {});
    expect(await completeRequestResolve(doc, wine, {})).toBeNull();
    expect(doc.save).not.toHaveBeenCalled();
    expect(doc.status).toBe('pending');
    expect(Bottle.updateMany).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
  });

  test('reject while another decision holds it: null, and no bottle is detached', async () => {
    WineRequest.findOneAndUpdate.mockResolvedValue(null);
    WineRequest.exists.mockResolvedValue({ _id: 'r1' });
    const doc = requestDoc(async () => {});
    expect(await completeRequestReject(doc, { adminNotes: 'no such wine' })).toBeNull();
    expect(Bottle.updateMany).not.toHaveBeenCalled();
    expect(doc.save).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
  });

  test('storing the decision clears the claim in the same write', async () => {
    const doc = Object.assign(requestDoc(async () => {}), { claimedAt: new Date() });
    await completeRequestResolve(doc, wine, { holdsClaim: true });
    expect(doc.claimedAt).toBeNull();
    expect(doc.markModified).toHaveBeenCalledWith('claimedAt');
  });
});
