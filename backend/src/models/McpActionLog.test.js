/**
 * McpActionLog index + constants guards (MCP-audit H2).
 *
 * The whole claim-first idempotency guarantee (prior-audit M2) rests on the
 * unique {user, idempotencyKey} index: it's what makes "exactly one twin wins
 * the claim" true. Every actionLedger unit test SIMULATES the E11000 by
 * mocking the model, so nothing else in the suite would catch someone dropping
 * `unique: true` — which would silently let concurrent same-key calls both
 * execute in production. This asserts the index declaration directly (no DB),
 * mirroring models/AiBudgetRequest.test.js.
 */
const McpActionLog = require('./McpActionLog');

describe('McpActionLog indexes', () => {
  const indexes = McpActionLog.schema.indexes();

  test('unique partial index on {user, idempotencyKey} (the idempotency lynchpin)', () => {
    const idem = indexes.find(([fields]) => fields.user === 1 && fields.idempotencyKey === 1);
    expect(idem).toBeDefined();
    expect(idem[1].unique).toBe(true);
    // Partial on string keys only — keyless rows (no idempotency_key) must not
    // collide on a null key.
    expect(idem[1].partialFilterExpression).toEqual({ idempotencyKey: { $type: 'string' } });
  });

  test('90-day TTL on createdAt, single index (no competing plain index → IndexOptionsConflict)', () => {
    const ttl = indexes.find(([fields, opts]) => fields.createdAt === 1 && opts.expireAfterSeconds != null);
    expect(ttl).toBeDefined();
    expect(ttl[1].expireAfterSeconds).toBe(90 * 24 * 60 * 60);
    // The ONLY index whose key is exactly {createdAt:1} is the TTL one.
    const createdAtOnly = indexes.filter(([fields]) => Object.keys(fields).length === 1 && fields.createdAt);
    expect(createdAtOnly).toHaveLength(1);
  });
});

describe('McpActionLog.NON_ACTIVITY_ACTIONS', () => {
  test('excludes preview + pending stubs (single source for timeline/admin/export)', () => {
    expect(McpActionLog.NON_ACTIVITY_ACTIONS).toEqual(['bulk_preview', 'arrange_preview', 'pending']);
  });

  test('every non-activity action is a real enum value (so the $nin actually matches rows)', () => {
    const enumVals = McpActionLog.schema.path('action').enumValues;
    for (const a of McpActionLog.NON_ACTIVITY_ACTIONS) expect(enumVals).toContain(a);
  });
});
