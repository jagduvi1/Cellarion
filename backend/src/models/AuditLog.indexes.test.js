/**
 * The account-erasure scrub (services/userDataRegistry) finds other users'
 * share events by the departing user's email: { $or: [{ 'detail.sharedWith':
 * email }, { 'detail.invitedEmail': email }] }. Without an index on each
 * field the $or was a full scan of the audit log on every account deletion
 * (Mongo profiler 2026-10-14). Checked on MongoDB 7 with 90,000 rows: 90,000
 * documents examined before, 1 after, through both sparse indexes.
 */
const AuditLog = require('./AuditLog');

describe('AuditLog indexes', () => {
  const indexes = AuditLog.schema.indexes();
  const find = (field) => indexes.find(([keys]) => Object.keys(keys).length === 1 && keys[field] === 1);

  it.each(['detail.sharedWith', 'detail.invitedEmail'])('%s has its own sparse index', (field) => {
    const idx = find(field);
    expect(idx).toBeDefined();
    expect(idx[1]).toMatchObject({ sparse: true });
  });

  it('the erasure scrub still queries exactly those two fields with an $or', () => {
    const src = require('fs').readFileSync(require.resolve('../services/userDataRegistry'), 'utf8');
    expect(src).toContain("{ $or: [{ 'detail.sharedWith': ctx.userEmail }, { 'detail.invitedEmail': ctx.userEmail }] }");
  });
});
