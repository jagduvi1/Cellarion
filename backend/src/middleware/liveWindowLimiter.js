const rateLimit = require('express-rate-limit');

const { MemoryStore } = rateLimit;

/**
 * An express-rate-limit limiter whose window follows the admin-tunable
 * rate-limit config. Takes the same options as rateLimit(), except that
 * `windowMs` is a function, read on every request.
 *
 * express-rate-limit reads windowMs once, when the limiter is built (its
 * MemoryStore sizes its buckets from it), so this builds the limiter on first
 * use and builds a new one whenever the configured window differs from the
 * one it was built with. A new limiter starts with empty counters, the same
 * as after a restart; an unchanged window keeps the limiter and its counts.
 * `max` can stay a function, read per request as usual.
 */
function liveWindowLimiter({ windowMs: getWindowMs, ...options }) {
  let limiter = null;
  let store = null;
  let builtWindowMs;

  return function liveWindowRateLimit(req, res, next) {
    const windowMs = getWindowMs();
    if (!limiter || windowMs !== builtWindowMs) {
      if (store) store.shutdown(); // stops the old store's sweep timer
      store = new MemoryStore();
      builtWindowMs = windowMs;
      limiter = rateLimit({
        ...options,
        windowMs,
        store,
        // The limiter is built while a request is being answered and then
        // kept until the window changes; the creationStack check is for
        // limiters built per request, which this is not.
        validate: { creationStack: false },
      });
    }
    return limiter(req, res, next);
  };
}

module.exports = liveWindowLimiter;
