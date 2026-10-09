/**
 * Finishing a wine request (services/wineRequestOps).
 *
 * Pins the race guard: the status write only lands while the stored request
 * is STILL pending (the save carries `$where: { status: 'pending' }`). The
 * hourly bridge sync holds a loaded request for minutes; an admin deciding it
 * meanwhile must not be overwritten — the second one gets null back, moves no
 * bottles and sends no second notification.
 */
jest.mock('../models/Bottle', () => ({ distinct: jest.fn().mockResolvedValue([]), updateMany: jest.fn().mockResolvedValue({ modifiedCount: 0 }) }));
jest.mock('../models/BottleImage', () => ({ updateMany: jest.fn().mockResolvedValue({}) }));
jest.mock('./dataVersion', () => ({ bumpDataVersion: jest.fn() }));
jest.mock('./notifications', () => ({ createNotification: jest.fn() }));
jest.mock('../utils/vintageProfile', () => ({ ensurePendingVintageProfile: jest.fn() }));

const Bottle = require('../models/Bottle');
const { createNotification } = require('./notifications');
const { completeRequestResolve, completeRequestReject } = require('./wineRequestOps');

const notFound = () => Object.assign(new Error('No document found'), { name: 'DocumentNotFoundError' });
const requestDoc = (save) => {
  const doc = { _id: 'r1', user: 'u1', wineName: 'X', requestType: 'new_wine', status: 'pending' };
  doc.save = jest.fn(async () => {
    doc.whereAtSave = doc.$where; // what Mongoose would add to the save's filter
    return save();
  });
  return doc;
};
const wine = { _id: 'w1', name: 'Y', producer: 'Z' };

beforeEach(() => jest.clearAllMocks());

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
});
