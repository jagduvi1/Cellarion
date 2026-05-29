const asyncHandler = require('./asyncHandler');

describe('asyncHandler', () => {
  it('forwards a rejected promise to next(err)', async () => {
    const err = new Error('boom');
    const next = jest.fn();
    await asyncHandler(async () => { throw err; })({}, {}, next);
    expect(next).toHaveBeenCalledWith(err);
  });

  it('does not call next on success', async () => {
    const next = jest.fn();
    const res = {};
    await asyncHandler(async (req, r) => { r.ok = true; })({}, res, next);
    expect(res.ok).toBe(true);
    expect(next).not.toHaveBeenCalled();
  });

  it('forwards a rejection that happens after some awaits', async () => {
    const err = new Error('late');
    const next = jest.fn();
    await asyncHandler(async () => {
      await Promise.resolve();
      throw err;
    })({}, {}, next);
    expect(next).toHaveBeenCalledWith(err);
  });

  it('passes (req, res, next) through to the wrapped handler', async () => {
    const seen = {};
    const req = { a: 1 }; const res = { b: 2 }; const next = () => {};
    await asyncHandler(async (q, s, n) => { seen.q = q; seen.s = s; seen.n = n; })(req, res, next);
    expect(seen.q).toBe(req);
    expect(seen.s).toBe(res);
    expect(seen.n).toBe(next);
  });
});
