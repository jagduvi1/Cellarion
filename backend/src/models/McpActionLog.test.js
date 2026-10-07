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
const fs = require('fs');
const path = require('path');
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

// Every tool test mocks this model, so an action missing from the enum only
// shows up in production — logAction swallows the validation error, the tool
// still succeeds, and the ledger row is silently never written. Three curator
// tools shipped that way. Scan every logAction call in src/mcp and check each
// literal action it can log; dynamic ones (undo's row.action) replay values
// that were already validated.
describe('McpActionLog action enum covers every logAction call', () => {
  const mcpDir = path.join(__dirname, '..', 'mcp');
  const files = [];
  (function walk(dir) {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (name.endsWith('.js') && !name.endsWith('.test.js')) files.push(p);
    }
  })(mcpDir);

  const logged = [];
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    const re = /logAction\(ctx,/g;
    let m;
    while ((m = re.exec(src))) {
      const call = src.slice(m.index, src.indexOf('});', m.index));
      const expr = call.match(/\baction:\s*([^,\n}]+)/);
      if (!expr) continue;
      for (const [, value] of expr[1].matchAll(/'([a-z_]+)'/g)) {
        logged.push({ value, at: `${path.relative(mcpDir, file)}:${src.slice(0, m.index).split('\n').length}` });
      }
    }
  }

  test('the scan finds the tool calls (guards the scanner itself)', () => {
    expect(logged.length).toBeGreaterThan(50);
  });

  test('every logged action is an enum value', () => {
    const enumVals = McpActionLog.schema.path('action').enumValues;
    const missing = logged.filter(({ value }) => !enumVals.includes(value));
    expect(missing).toEqual([]);
  });
});
