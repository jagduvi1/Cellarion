const AuditLog = require('./AuditLog');

// services/audit.js stamps the API token a request came with. A field the
// schema does not declare would be dropped without an error.
test('an audit row can carry the id of the API token that made the change', () => {
  const path = AuditLog.schema.path('actor.tokenId');
  expect(path).toBeDefined();
  expect(path.instance).toBe('ObjectId');
  const row = new AuditLog({ action: 'bottle.move.out', actor: { tokenId: 'a'.repeat(24) } });
  expect(String(row.actor.tokenId)).toBe('a'.repeat(24));
  expect(new AuditLog({ action: 'bottle.move.out', actor: {} }).actor.tokenId).toBeUndefined();
});
