/**
 * mcpSnapshotRetentionJob — a delete_bottle snapshot is cleared once the undo
 * window has passed (GDPR data minimisation): only `delete` rows, only past
 * RESTORE_WINDOW_MS, only rows that still hold one; the row itself stays.
 */
jest.mock('../models/McpActionLog', () => ({ updateMany: jest.fn() }));
jest.mock('./bottleOps', () => ({ RESTORE_WINDOW_MS: 2 * 24 * 60 * 60 * 1000 }));

const McpActionLog = require('../models/McpActionLog');
const { runMcpSnapshotScrub } = require('./mcpSnapshotRetentionJob');

test('clears prev on delete rows older than the undo window, and nothing else', async () => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  McpActionLog.updateMany.mockResolvedValue({ modifiedCount: 3 });
  const before = Date.now();
  const out = await runMcpSnapshotScrub();
  expect(out).toEqual({ scrubbed: 3 });
  const [filter, update] = McpActionLog.updateMany.mock.calls[0];
  expect(filter.action).toBe('delete');
  expect(filter.prev).toEqual({ $ne: null });
  const cutoff = filter.createdAt.$lt.getTime();
  expect(cutoff).toBeGreaterThanOrEqual(before - 2 * 24 * 60 * 60 * 1000 - 1000);
  expect(cutoff).toBeLessThanOrEqual(Date.now() - 2 * 24 * 60 * 60 * 1000);
  // The row stays (the activity timeline line); only the contents go.
  expect(update).toEqual({ $set: { prev: null } });
});
