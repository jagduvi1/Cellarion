/**
 * WineOwnerInquiry schema — shape, lifecycle enum, retention and the
 * uniqueness guarantee behind the create route's 409.
 *
 * No MongoDB: validates via Mongoose document validation and inspects the
 * schema's declared indexes (the one-open-per-wine partial unique gate and
 * the 180-day post-resolution TTL that enforces GDPR retention).
 */
const mongoose = require('mongoose');
const WineOwnerInquiry = require('./WineOwnerInquiry');

const oid = () => new mongoose.Types.ObjectId();
const QUESTION = 'What does the label say the producer is?';

describe('WineOwnerInquiry schema', () => {
  test('defaults: open status, rest via, empty recipients, no resolution fields', () => {
    const doc = new WineOwnerInquiry({ wineDefinition: oid(), askedBy: oid(), question: QUESTION });
    expect(doc.validateSync()).toBeUndefined();
    expect(doc.status).toBe('open');
    expect(doc.askedVia).toBe('rest');
    expect(doc.recipients).toEqual([]);
    expect(doc.resolvedBy).toBeNull();
    expect(doc.resolvedAt).toBeNull();
  });

  test('expiresAt defaults to ~60 days out (the answer window)', () => {
    const doc = new WineOwnerInquiry({ wineDefinition: oid(), question: QUESTION });
    const days = (doc.expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    expect(days).toBeGreaterThan(59.9);
    expect(days).toBeLessThan(60.1);
  });

  test('wineDefinition and question are required; askedBy is NULLABLE (GDPR erasure nulls it)', () => {
    const err = new WineOwnerInquiry({}).validateSync();
    expect(err.errors.wineDefinition).toBeDefined();
    expect(err.errors.question).toBeDefined();
    // askedBy must never be required — purgeUserData sets it to null.
    const anon = new WineOwnerInquiry({ wineDefinition: oid(), askedBy: null, question: QUESTION });
    expect(anon.validateSync()).toBeUndefined();
  });

  test('question is bounded 10–500', () => {
    expect(new WineOwnerInquiry({ wineDefinition: oid(), question: 'short' }).validateSync().errors.question).toBeDefined();
    expect(new WineOwnerInquiry({ wineDefinition: oid(), question: 'x'.repeat(501) }).validateSync().errors.question).toBeDefined();
    expect(new WineOwnerInquiry({ wineDefinition: oid(), question: 'x'.repeat(500) }).validateSync()).toBeUndefined();
  });

  test('status is constrained to open|answered|resolved|closed', () => {
    expect(new WineOwnerInquiry({ wineDefinition: oid(), question: QUESTION, status: 'escalated' }).validateSync().errors.status).toBeDefined();
    for (const s of ['open', 'answered', 'resolved', 'closed']) {
      expect(new WineOwnerInquiry({ wineDefinition: oid(), question: QUESTION, status: s }).validateSync()).toBeUndefined();
    }
  });

  test('recipients: user required, response capped at 1000, subdocs carry no _id', () => {
    const missingUser = new WineOwnerInquiry({ wineDefinition: oid(), question: QUESTION, recipients: [{ bottle: oid() }] });
    expect(missingUser.validateSync().errors['recipients.0.user']).toBeDefined();

    const tooLong = new WineOwnerInquiry({
      wineDefinition: oid(), question: QUESTION,
      recipients: [{ user: oid(), response: 'x'.repeat(1001) }],
    });
    expect(tooLong.validateSync().errors['recipients.0.response']).toBeDefined();

    const ok = new WineOwnerInquiry({
      wineDefinition: oid(), question: QUESTION,
      recipients: [{ user: oid(), bottle: oid(), response: 'x'.repeat(1000) }],
    });
    expect(ok.validateSync()).toBeUndefined();
    expect(ok.recipients[0]._id).toBeUndefined();
  });

  test('resolutionNote is capped at 500', () => {
    const doc = new WineOwnerInquiry({ wineDefinition: oid(), question: QUESTION, resolutionNote: 'x'.repeat(501) });
    expect(doc.validateSync().errors.resolutionNote).toBeDefined();
  });

  test('partial unique index enforces at most one OPEN inquiry per wine (race-safe 409)', () => {
    const unique = WineOwnerInquiry.schema.indexes()
      .find(([, opts]) => opts.unique && opts.partialFilterExpression?.status === 'open');
    expect(unique).toBeDefined();
    expect(unique[0]).toEqual({ wineDefinition: 1, status: 1 });
  });

  test('GDPR retention: 180-day TTL on resolvedAt, scoped to resolved/closed rows only', () => {
    const ttl = WineOwnerInquiry.schema.indexes()
      .find(([fields, opts]) => fields.resolvedAt === 1 && opts.expireAfterSeconds != null);
    expect(ttl).toBeDefined();
    expect(ttl[1].expireAfterSeconds).toBe(180 * 24 * 60 * 60);
    // Active rows must never TTL away — the partial filter is the guard.
    expect(ttl[1].partialFilterExpression).toEqual({ status: { $in: ['resolved', 'closed'] } });
  });

  test('timestamps are enabled', () => {
    expect(WineOwnerInquiry.schema.options.timestamps).toBe(true);
  });
});
