/**
 * Wrap an async Express route handler so a rejected promise is forwarded to the
 * centralized error handler (see app.js) via next(err), instead of surfacing as
 * an unhandledRejection that hangs the request with no response.
 *
 * Express 4 does not await route handlers, so an async handler that throws (or
 * awaits a rejecting promise) outside its own try/catch escapes Express. This
 * wrapper closes that gap; new routes should use it instead of hand-rolling a
 * try/catch:
 *
 *   router.post('/', asyncHandler(async (req, res) => {
 *     const doc = await Thing.create(req.body); // a rejection here → 500 via next(err)
 *     res.status(201).json({ doc });
 *   }));
 *
 * @param {Function} fn async (req, res, next) => Promise
 * @returns {Function} an Express handler that catches rejections
 */
function asyncHandler(fn) {
  return function wrapped(req, res, next) {
    return Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = asyncHandler;
