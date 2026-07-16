// Per-user mutation budget for MCP tools — write-limiter parity at the tool
// layer (see the isMcp comment in app.js). Lives in its own module so BOTH
// mcp/server.js (which charges one slot per mutating tool call) and batch
// tools like bulk_add (which charge one slot PER ITEM upfront) can use it
// without a circular require.
//
// In-memory like express-rate-limit; the whole map is cleared at the cap.
const WRITE_WINDOW_MS = 15 * 60 * 1000;
const mutationWindows = new Map(); // userId -> { start, count }
const MUTATION_WINDOWS_MAX = 5000;

/**
 * Try to take `n` mutation slots for a user in the current 15-minute window.
 * All-or-nothing: returns false (and takes NOTHING) when fewer than n remain,
 * so a batch never half-charges before being refused.
 */
function takeMutationSlot(userId, n = 1) {
  const max = require('../config/rateLimits').get().write.max;
  const now = Date.now();
  let w = mutationWindows.get(userId);
  if (!w || now - w.start >= WRITE_WINDOW_MS) {
    if (mutationWindows.size >= MUTATION_WINDOWS_MAX) mutationWindows.clear();
    w = { start: now, count: 0 };
    mutationWindows.set(userId, w);
  }
  if (w.count + n > max) return false;
  w.count += n;
  return true;
}

module.exports = { takeMutationSlot, WRITE_WINDOW_MS };
