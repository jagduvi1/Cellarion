/**
 * Per-user concurrent-stream limiter — caps how many SSE chat streams a
 * single user can hold open simultaneously.
 *
 * Why this exists: the /api/chat/stream route opens a long-lived SSE
 * connection that holds an Anthropic API call open for its duration. A
 * scripted client could open many streams in parallel from a single
 * account, racking up Anthropic spend faster than the tier quota or the
 * per-minute burst limiter can catch (those count REQUESTS, not concurrent
 * sessions). This limiter caps in-flight sessions per user.
 *
 * Process-local, in-memory only. If Cellarion ever runs multiple backend
 * processes behind a load balancer, this would need to move to Redis to
 * share state — until then process memory is fine and resets cleanly on
 * container restart.
 *
 * Usage:
 *   const id = limiter.tryAcquire(userId);
 *   if (!id) return res.status(429).json({...});
 *   try { ... do the streaming work ... }
 *   finally { limiter.release(userId, id); }
 *
 * Cap is read on each acquire so admin can tune `chatConcurrentStreams.max`
 * via the rate-limits admin UI without restart.
 */
const crypto = require('crypto');

class ConcurrentStreamLimiter {
  /**
   * @param {() => number} maxPerUser  Function returning the current cap.
   *                                    Called on each acquire so live config
   *                                    changes take effect immediately.
   */
  constructor(maxPerUser) {
    this.maxPerUser = typeof maxPerUser === 'function' ? maxPerUser : () => maxPerUser;
    this.active = new Map(); // userId (string) → Set<streamId>
  }

  /**
   * Reserve a slot for a new stream. Returns a stream id (string) when
   * successful, or null when the user is already at the cap.
   */
  tryAcquire(userId) {
    const key = String(userId);
    const max = this.maxPerUser();
    const streams = this.active.get(key) || new Set();
    if (streams.size >= max) return null;
    const streamId = crypto.randomUUID();
    streams.add(streamId);
    this.active.set(key, streams);
    return streamId;
  }

  /**
   * Release a previously-acquired slot. Safe to call multiple times for
   * the same id — extras are no-ops, so success and error paths in the
   * handler can both call release without double-counting.
   */
  release(userId, streamId) {
    const key = String(userId);
    const streams = this.active.get(key);
    if (!streams) return;
    streams.delete(streamId);
    if (streams.size === 0) this.active.delete(key);
  }

  /** Current in-flight count for a user (useful for diagnostics + tests). */
  count(userId) {
    const streams = this.active.get(String(userId));
    return streams ? streams.size : 0;
  }

  /** Total active users (diagnostics — e.g. for an admin-stats panel). */
  activeUserCount() {
    return this.active.size;
  }

  /** Sum of in-flight streams across all users. */
  totalActive() {
    let total = 0;
    for (const streams of this.active.values()) total += streams.size;
    return total;
  }
}

module.exports = { ConcurrentStreamLimiter };
