const jwt = require('jsonwebtoken');

// Use a fixed test secret so we can sign real tokens
process.env.JWT_SECRET = 'test-secret';

const { requireAuth, requireRole, requireSommOrAdmin } = require('./auth');

// ─── Helpers ────────────────────────────────────────��────────────────────────

function makeReq(overrides = {}) {
  return { headers: {}, ...overrides };
}

function makeRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json   = jest.fn().mockReturnValue(res);
  return res;
}

function signToken(payload, secret = 'test-secret', opts = {}) {
  return jwt.sign(payload, secret, { algorithm: 'HS256', expiresIn: '1h', ...opts });
}

// ─── requireAuth ─────────────────────��───────────────────────────────────────

describe('requireAuth', () => {
  test('401 when Authorization header is absent', async () => {
    const req = makeReq();
    const res = makeRes();
    const next = jest.fn();

    await requireAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('401 when header does not start with "Bearer "', async () => {
    const req = makeReq({ headers: { authorization: 'Token abc' } });
    const res = makeRes();
    const next = jest.fn();

    await requireAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('401 for an invalid/malformed token', async () => {
    const req = makeReq({ headers: { authorization: 'Bearer not.a.valid.token' } });
    const res = makeRes();
    const next = jest.fn();

    await requireAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'Invalid token' }));
  });

  test('401 for an expired token', async () => {
    const token = signToken({ id: 'u1', roles: ['user'] }, 'test-secret', { expiresIn: -1 });
    const req = makeReq({ headers: { authorization: `Bearer ${token}` } });
    const res = makeRes();
    const next = jest.fn();

    await requireAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'Token expired' }));
  });

  test('401 when token is signed with the wrong secret', async () => {
    const token = signToken({ id: 'u1', roles: ['user'] }, 'wrong-secret');
    const req = makeReq({ headers: { authorization: `Bearer ${token}` } });
    const res = makeRes();
    const next = jest.fn();

    await requireAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
  });

  test('attaches req.user and calls next for a valid token with roles array', async () => {
    const token = signToken({ id: 'u1', roles: ['admin'], plan: 'patron' });
    const req = makeReq({ headers: { authorization: `Bearer ${token}` } });
    const res = makeRes();
    const next = jest.fn();

    await requireAuth(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.user).toMatchObject({ id: 'u1', roles: ['admin'], plan: 'patron' });
  });

  test('supports legacy tokens that carry a single "role" string', async () => {
    const token = signToken({ id: 'u2', role: 'admin' });
    const req = makeReq({ headers: { authorization: `Bearer ${token}` } });
    const res = makeRes();
    const next = jest.fn();

    await requireAuth(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.user.roles).toEqual(['admin']);
  });

  test('defaults to ["user"] role and "free" plan when absent from token', async () => {
    const token = signToken({ id: 'u3' });
    const req = makeReq({ headers: { authorization: `Bearer ${token}` } });
    const res = makeRes();
    const next = jest.fn();

    await requireAuth(req, res, next);

    expect(req.user.roles).toEqual(['user']);
    expect(req.user.plan).toBe('free');
  });

  test('downgrades expired plan to free', async () => {
    const expired = new Date(Date.now() - 60000).toISOString();
    const token = signToken({ id: 'u4', roles: ['user'], plan: 'patron', planExpiresAt: expired });
    const req = makeReq({ headers: { authorization: `Bearer ${token}` } });
    const res = makeRes();
    const next = jest.fn();

    await requireAuth(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.user.plan).toBe('free');
  });
});

// ─── requireRole ──────────────────────────────────���──────────────────────────

describe('requireRole', () => {
  test('401 when req.user is not set', () => {
    const middleware = requireRole('admin');
    const req = makeReq();
    const res = makeRes();
    const next = jest.fn();

    middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('403 when user does not have the required role', () => {
    const middleware = requireRole('admin');
    const req = { user: { roles: ['user'] } };
    const res = makeRes();
    const next = jest.fn();

    middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  test('calls next when user has the required role', () => {
    const middleware = requireRole('admin');
    const req = { user: { roles: ['admin'] } };
    const res = makeRes();
    const next = jest.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('user with multiple roles passes if any match', () => {
    const middleware = requireRole('somm');
    const req = { user: { roles: ['user', 'somm'] } };
    const res = makeRes();
    const next = jest.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalled();
  });
});

// ─── requireSommOrAdmin ─────────────────────────��─────────────────────────────

describe('requireSommOrAdmin', () => {
  test('401 when req.user is not set', () => {
    const req = makeReq();
    const res = makeRes();
    const next = jest.fn();

    requireSommOrAdmin(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
  });

  test('403 for a plain user role', () => {
    const req = { user: { roles: ['user'] } };
    const res = makeRes();
    const next = jest.fn();

    requireSommOrAdmin(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  test('calls next for somm role', () => {
    const req = { user: { roles: ['somm'] } };
    const res = makeRes();
    const next = jest.fn();

    requireSommOrAdmin(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  test('calls next for admin role', () => {
    const req = { user: { roles: ['admin'] } };
    const res = makeRes();
    const next = jest.fn();

    requireSommOrAdmin(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  test('calls next when user has both somm and admin roles', () => {
    const req = { user: { roles: ['somm', 'admin'] } };
    const res = makeRes();
    const next = jest.fn();

    requireSommOrAdmin(req, res, next);

    expect(next).toHaveBeenCalled();
  });
});
