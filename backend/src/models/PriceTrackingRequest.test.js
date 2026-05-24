const mongoose = require('mongoose');
const PriceTrackingRequest = require('./PriceTrackingRequest');

describe('PriceTrackingRequest schema', () => {
  const aWineId = new mongoose.Types.ObjectId();
  const aUserId = new mongoose.Types.ObjectId();

  it('accepts a minimal valid document', () => {
    const doc = new PriceTrackingRequest({ wineDefinition: aWineId, vintage: '2018' });
    const err = doc.validateSync();
    expect(err).toBeUndefined();
  });

  it('requires wineDefinition', () => {
    const doc = new PriceTrackingRequest({ vintage: '2018' });
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err.errors.wineDefinition).toBeDefined();
  });

  it('requires vintage', () => {
    const doc = new PriceTrackingRequest({ wineDefinition: aWineId });
    const err = doc.validateSync();
    expect(err).toBeDefined();
    expect(err.errors.vintage).toBeDefined();
  });

  it('defaults requesters to an empty array', () => {
    const doc = new PriceTrackingRequest({ wineDefinition: aWineId, vintage: '2018' });
    expect(Array.isArray(doc.requesters)).toBe(true);
    expect(doc.requesters).toHaveLength(0);
  });

  it('sets firstRequestedAt and lastRequestedAt by default', () => {
    const before = Date.now();
    const doc = new PriceTrackingRequest({ wineDefinition: aWineId, vintage: '2018' });
    expect(doc.firstRequestedAt).toBeInstanceOf(Date);
    expect(doc.lastRequestedAt).toBeInstanceOf(Date);
    expect(doc.firstRequestedAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('accepts a requester with user, requestedAt, and note', () => {
    const doc = new PriceTrackingRequest({
      wineDefinition: aWineId,
      vintage: '2018',
      requesters: [{ user: aUserId, requestedAt: new Date(), note: 'Premier Cru worth watching' }]
    });
    const err = doc.validateSync();
    expect(err).toBeUndefined();
    expect(doc.requesters).toHaveLength(1);
    expect(doc.requesters[0].user.toString()).toBe(aUserId.toString());
    expect(doc.requesters[0].note).toBe('Premier Cru worth watching');
  });

  it('rejects requester note longer than 500 chars', () => {
    const doc = new PriceTrackingRequest({
      wineDefinition: aWineId,
      vintage: '2018',
      requesters: [{ user: aUserId, note: 'x'.repeat(501) }]
    });
    const err = doc.validateSync();
    expect(err).toBeDefined();
    // The error should be on the requesters subdocument's note field
    expect(err.errors['requesters.0.note']).toBeDefined();
  });

  it('declares a unique (wineDefinition, vintage) compound index', () => {
    const indexes = PriceTrackingRequest.schema.indexes();
    const uniqueOnPair = indexes.find(([keys, opts]) =>
      keys.wineDefinition === 1 && keys.vintage === 1 && opts?.unique === true
    );
    expect(uniqueOnPair).toBeDefined();
  });

  it('requesters subdoc has no _id field (clean shape)', () => {
    const doc = new PriceTrackingRequest({
      wineDefinition: aWineId,
      vintage: '2018',
      requesters: [{ user: aUserId }]
    });
    expect(doc.requesters[0]._id).toBeUndefined();
  });
});
