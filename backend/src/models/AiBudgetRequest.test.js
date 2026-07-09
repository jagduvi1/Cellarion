/**
 * AiBudgetRequest schema — shape, enum, retention and uniqueness guarantees.
 *
 * No MongoDB: validates via Mongoose document validation and inspects the
 * schema's declared indexes (TTL + the partial unique "one pending per user"
 * gate that makes the route's 409 race-safe).
 */
const mongoose = require('mongoose');
const AiBudgetRequest = require('./AiBudgetRequest');

const uid = () => new mongoose.Types.ObjectId();

describe('AiBudgetRequest schema', () => {
  test('defaults: pending status, empty reason, no decision fields', () => {
    const doc = new AiBudgetRequest({ user: uid() });
    expect(doc.validateSync()).toBeUndefined();
    expect(doc.status).toBe('pending');
    expect(doc.reason).toBe('');
    expect(doc.decidedBy).toBeNull();
    expect(doc.decidedAt).toBeNull();
    expect(doc.grantedMax).toBeNull();
    expect(doc.grantedUntil).toBeNull();
    expect(doc.requestedContext.pendingRows).toBeNull();
  });

  test('user is required', () => {
    const doc = new AiBudgetRequest({});
    const err = doc.validateSync();
    expect(err.errors.user).toBeDefined();
  });

  test('status is constrained to pending|approved|denied', () => {
    const doc = new AiBudgetRequest({ user: uid(), status: 'escalated' });
    expect(doc.validateSync().errors.status).toBeDefined();
    for (const s of ['pending', 'approved', 'denied']) {
      expect(new AiBudgetRequest({ user: uid(), status: s }).validateSync()).toBeUndefined();
    }
  });

  test('reason is capped at 500 chars', () => {
    const ok = new AiBudgetRequest({ user: uid(), reason: 'x'.repeat(500) });
    expect(ok.validateSync()).toBeUndefined();
    const tooLong = new AiBudgetRequest({ user: uid(), reason: 'x'.repeat(501) });
    expect(tooLong.validateSync().errors.reason).toBeDefined();
  });

  test('requestedContext.pendingRows is stored', () => {
    const doc = new AiBudgetRequest({ user: uid(), requestedContext: { pendingRows: 620 } });
    expect(doc.validateSync()).toBeUndefined();
    expect(doc.requestedContext.pendingRows).toBe(620);
  });

  test('180-day TTL index on createdAt', () => {
    const ttl = AiBudgetRequest.schema.indexes()
      .find(([fields, opts]) => fields.createdAt === 1 && opts.expireAfterSeconds != null);
    expect(ttl).toBeDefined();
    expect(ttl[1].expireAfterSeconds).toBe(180 * 24 * 60 * 60);
  });

  test('partial unique index enforces at most one PENDING request per user', () => {
    const unique = AiBudgetRequest.schema.indexes()
      .find(([, opts]) => opts.unique && opts.partialFilterExpression?.status === 'pending');
    expect(unique).toBeDefined();
    expect(unique[0]).toEqual({ user: 1, status: 1 });
  });

  test('timestamps are enabled', () => {
    expect(AiBudgetRequest.schema.options.timestamps).toBe(true);
  });
});
