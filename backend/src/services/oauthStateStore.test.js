/**
 * Tests for the cookie-backed OAuth state store.
 *
 * WHY THIS TEST EXISTS:
 * This store is the only thing binding an OAuth callback to the browser that
 * started the flow. If it silently accepts — a missing cookie, a mismatched
 * state, a replayed one — the callback is back to exchanging any authorization
 * code presented to it, which signs a victim into the attacker's account. Every
 * rejection path is therefore pinned here, not just the happy one, and the
 * PKCE verifier's round trip with it.
 */

process.env.JWT_SECRET = 'test-secret';

const { CookieStateStore, DEFAULT_COOKIE_NAME } = require('./oauthStateStore');

// Minimal express-shaped req/res: cookie()/clearCookie() record their calls,
// and req.cookies is what cookie-parser would have populated on the way back.
function makeReq(cookies = {}) {
  const res = {
    cookie: jest.fn(),
    clearCookie: jest.fn(),
  };
  return { cookies, res };
}

/** Run store() and return { state, payload, options } as the browser would see them. */
function runStore(store, req, verifier) {
  let state;
  store.store(req, verifier, undefined, {}, (err, value) => {
    if (err) throw err;
    state = value;
  });
  const [name, payload, options] = req.res.cookie.mock.calls[0];
  expect(name).toBe(DEFAULT_COOKIE_NAME);
  return { state, payload, options };
}

describe('CookieStateStore', () => {
  it('stores a random state in an httpOnly, lax, path-scoped cookie and returns it', () => {
    const store = new CookieStateStore({ secure: true });
    const req = makeReq();

    const { state, payload, options } = runStore(store, req);

    expect(typeof state).toBe('string');
    expect(state.length).toBeGreaterThanOrEqual(32);
    expect(payload.startsWith(`${state}.`)).toBe(true);
    expect(options).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/api/auth',
    });
    expect(options.maxAge).toBeGreaterThan(0);
  });

  it('mints a different state per flow', () => {
    const store = new CookieStateStore();
    const first = runStore(store, makeReq()).state;
    const second = runStore(store, makeReq()).state;
    expect(first).not.toBe(second);
  });

  it('accepts the state it issued, and consumes the cookie', () => {
    const store = new CookieStateStore();
    const outbound = makeReq();
    const { state, payload } = runStore(store, outbound);

    const back = makeReq({ [DEFAULT_COOKIE_NAME]: payload });
    const cb = jest.fn();
    store.verify(back, state, cb);

    expect(cb).toHaveBeenCalledWith(null, true);
    expect(back.res.clearCookie).toHaveBeenCalledWith(
      DEFAULT_COOKIE_NAME,
      expect.objectContaining({ path: '/api/auth' })
    );
    // clearCookie must NOT be handed a maxAge — Express would then re-derive a
    // future expiry and leave the cookie in place.
    expect(back.res.clearCookie.mock.calls[0][1].maxAge).toBeUndefined();
  });

  it('rejects a state that does not match the cookie — the login-CSRF case', () => {
    const store = new CookieStateStore();
    const { payload } = runStore(store, makeReq());

    // The attacker's authorization code arrives with the attacker's state.
    const back = makeReq({ [DEFAULT_COOKIE_NAME]: payload });
    const cb = jest.fn();
    store.verify(back, 'a-state-this-browser-never-issued', cb);

    expect(cb).toHaveBeenCalledWith(null, false, { code: 'invalid_state' });
  });

  it('rejects when the browser sends no cookie at all', () => {
    const store = new CookieStateStore();
    const cb = jest.fn();
    store.verify(makeReq(), 'anything', cb);
    expect(cb).toHaveBeenCalledWith(null, false, { code: 'invalid_state' });
  });

  it('rejects when the callback carries no state', () => {
    const store = new CookieStateStore();
    const { payload } = runStore(store, makeReq());
    const cb = jest.fn();
    store.verify(makeReq({ [DEFAULT_COOKIE_NAME]: payload }), undefined, cb);
    expect(cb).toHaveBeenCalledWith(null, false, { code: 'invalid_state' });
  });

  it('rejects a garbled cookie without throwing', () => {
    const store = new CookieStateStore();
    const cb = jest.fn();
    store.verify(makeReq({ [DEFAULT_COOKIE_NAME]: 'not-a-payload' }), 'not-a-payload', cb);
    expect(cb).toHaveBeenCalledWith(null, false, { code: 'invalid_state' });
  });

  it('rejects a state older than the TTL even if the browser still holds it', () => {
    const store = new CookieStateStore({ ttlMs: 1000 });
    const req = makeReq();
    const { state, payload } = runStore(store, req);

    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 5000);
    try {
      const cb = jest.fn();
      store.verify(makeReq({ [DEFAULT_COOKIE_NAME]: payload }), state, cb);
      expect(cb).toHaveBeenCalledWith(null, false, { code: 'invalid_state' });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('clears the cookie on failure too, so a rejected flow cannot be retried with the same state', () => {
    // "Single-use" here means the browser is not asked for the value twice. The
    // server keeps no ledger of spent states and does not need one: the
    // authorization code is single-use at the provider, so a replayed pair dies
    // at the token exchange.
    const store = new CookieStateStore();
    const { payload } = runStore(store, makeReq());

    const back = makeReq({ [DEFAULT_COOKIE_NAME]: payload });
    store.verify(back, 'wrong', jest.fn());

    expect(back.res.clearCookie).toHaveBeenCalledTimes(1);
  });

  it('round-trips the PKCE verifier and returns it as the success value', () => {
    const store = new CookieStateStore();
    const verifier = 'a-code-verifier-from-passport-oauth2';
    const outbound = makeReq();
    const { state, payload } = runStore(store, outbound, verifier);

    expect(payload.endsWith(`.${verifier}`)).toBe(true);

    const cb = jest.fn();
    store.verify(makeReq({ [DEFAULT_COOKIE_NAME]: payload }), state, cb);

    // passport-oauth2 reads a STRING ok as the code_verifier for the token
    // request; returning true here would silently drop PKCE.
    expect(cb).toHaveBeenCalledWith(null, verifier);
  });

  it('survives a response that cannot set cookies, reporting the error rather than redirecting blind', () => {
    const store = new CookieStateStore();
    const req = { cookies: {}, res: { cookie: () => { throw new Error('headers already sent'); } } };
    const cb = jest.fn();
    store.store(req, undefined, undefined, {}, cb);
    expect(cb).toHaveBeenCalledWith(expect.any(Error));
  });
});
