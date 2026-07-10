jest.mock('../models/User', () => ({
  findById: jest.fn(),
}));
jest.mock('../services/audit', () => ({
  logAudit: jest.fn(),
}));
jest.mock('../utils/clientIp', () => ({
  getClientIp: jest.fn(),
}));

const User = require('../models/User');
const { logAudit } = require('../services/audit');
const { getClientIp } = require('../utils/clientIp');
const { requireSuperAdmin, checkIsSuperAdmin } = require('./superAdmin');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeReq(overrides = {}) {
  return { user: { id: 'u1' }, path: '/api/superadmin/x', method: 'GET', ...overrides };
}

function makeRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json   = jest.fn().mockReturnValue(res);
  return res;
}

/** Mock the User.findById(...).select('email').lean() chain. */
function mockDbEmail(result) {
  const lean = jest.fn();
  if (result instanceof Error) lean.mockRejectedValue(result);
  else lean.mockResolvedValue(result);
  User.findById.mockReturnValue({ select: jest.fn().mockReturnValue({ lean }) });
}

// Save/restore the env vars the middleware reads on every call
const ENV_KEYS = ['SUPER_ADMIN_EMAIL', 'SUPER_ADMIN_IPS'];
let savedEnv;

beforeEach(() => {
  jest.clearAllMocks();
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

// ─── requireSuperAdmin ───────────────────────────────────────────────────────

describe('requireSuperAdmin', () => {
  test('401 when req.user is not set (must run after requireAuth)', async () => {
    const req = makeReq({ user: undefined });
    const res = makeRes();
    const next = jest.fn();

    await requireSuperAdmin(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Authentication required' });
    expect(next).not.toHaveBeenCalled();
  });

  test('403 when SUPER_ADMIN_EMAIL is not configured — feature disabled, no DB hit', async () => {
    const req = makeReq();
    const res = makeRes();
    const next = jest.fn();

    await requireSuperAdmin(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Access denied' });
    expect(User.findById).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  test('403 when SUPER_ADMIN_EMAIL is only whitespace (treated as unset)', async () => {
    process.env.SUPER_ADMIN_EMAIL = '   ';
    const req = makeReq();
    const res = makeRes();
    const next = jest.fn();

    await requireSuperAdmin(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(User.findById).not.toHaveBeenCalled();
  });

  test('allows access when DB email matches configured email (no IP allowlist)', async () => {
    process.env.SUPER_ADMIN_EMAIL = 'root@cellarion.app';
    mockDbEmail({ email: 'root@cellarion.app' });
    const req = makeReq();
    const res = makeRes();
    const next = jest.fn();

    await requireSuperAdmin(req, res, next);

    expect(User.findById).toHaveBeenCalledWith('u1');
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
    expect(logAudit).toHaveBeenCalledWith(
      req, 'superadmin.access', {},
      { path: '/api/superadmin/x', method: 'GET' }
    );
  });

  test('403 with generic error when the DB email does not match — attempt audited', async () => {
    process.env.SUPER_ADMIN_EMAIL = 'root@cellarion.app';
    mockDbEmail({ email: 'someone-else@cellarion.app' });
    const req = makeReq();
    const res = makeRes();
    const next = jest.fn();

    await requireSuperAdmin(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Access denied' });
    expect(logAudit).toHaveBeenCalledWith(
      req, 'superadmin.access.blocked', {}, { reason: 'email_mismatch' }
    );
    expect(next).not.toHaveBeenCalled();
  });

  test('403 when the user no longer exists in the DB', async () => {
    process.env.SUPER_ADMIN_EMAIL = 'root@cellarion.app';
    mockDbEmail(null);
    const req = makeReq();
    const res = makeRes();
    const next = jest.fn();

    await requireSuperAdmin(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  test('500 when the DB lookup throws', async () => {
    process.env.SUPER_ADMIN_EMAIL = 'root@cellarion.app';
    mockDbEmail(new Error('db down'));
    const req = makeReq();
    const res = makeRes();
    const next = jest.fn();

    await requireSuperAdmin(req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Authentication error' });
    expect(next).not.toHaveBeenCalled();
  });

  test('403 when an IP allowlist is configured and the client IP is not in it — no DB hit', async () => {
    process.env.SUPER_ADMIN_EMAIL = 'root@cellarion.app';
    process.env.SUPER_ADMIN_IPS = '10.0.0.1, 10.0.0.2';
    getClientIp.mockReturnValue('192.168.1.99');
    const req = makeReq();
    const res = makeRes();
    const next = jest.fn();

    await requireSuperAdmin(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Access denied' });
    // IP check happens BEFORE the DB email lookup
    expect(User.findById).not.toHaveBeenCalled();
    expect(logAudit).toHaveBeenCalledWith(
      req, 'superadmin.access.blocked', {},
      { reason: 'ip_not_allowed', ip: '192.168.1.99' }
    );
    expect(next).not.toHaveBeenCalled();
  });

  test('allows access when the client IP is in the (whitespace-padded) allowlist', async () => {
    process.env.SUPER_ADMIN_EMAIL = 'root@cellarion.app';
    process.env.SUPER_ADMIN_IPS = ' 10.0.0.1 , 10.0.0.2 ';
    getClientIp.mockReturnValue('10.0.0.2');
    mockDbEmail({ email: 'root@cellarion.app' });
    const req = makeReq();
    const res = makeRes();
    const next = jest.fn();

    await requireSuperAdmin(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('mixed-case env email is normalised, so a lowercase DB email still matches', async () => {
    process.env.SUPER_ADMIN_EMAIL = '  Root@Cellarion.App  ';
    mockDbEmail({ email: 'root@cellarion.app' });
    const req = makeReq();
    const res = makeRes();
    const next = jest.fn();

    await requireSuperAdmin(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  test('CURRENT BEHAVIOR: DB email is compared raw — a mixed-case DB email never matches', async () => {
    // The env email is lowercased+trimmed but the DB email is NOT lowercased
    // before comparison. If the User doc ever stored 'Root@Cellarion.App',
    // super-admin access would be denied. Pinned so a change here is a
    // conscious decision, not drift.
    process.env.SUPER_ADMIN_EMAIL = 'root@cellarion.app';
    mockDbEmail({ email: 'Root@Cellarion.App' });
    const req = makeReq();
    const res = makeRes();
    const next = jest.fn();

    await requireSuperAdmin(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
});

// ─── checkIsSuperAdmin ───────────────────────────────────────────────────────

describe('checkIsSuperAdmin', () => {
  test('false when SUPER_ADMIN_EMAIL is not configured', () => {
    expect(checkIsSuperAdmin(makeReq(), 'root@cellarion.app')).toBe(false);
  });

  test('true when email matches and no IP allowlist is configured', () => {
    process.env.SUPER_ADMIN_EMAIL = 'root@cellarion.app';
    expect(checkIsSuperAdmin(makeReq(), 'root@cellarion.app')).toBe(true);
    expect(getClientIp).not.toHaveBeenCalled();
  });

  test('false when the email does not match', () => {
    process.env.SUPER_ADMIN_EMAIL = 'root@cellarion.app';
    expect(checkIsSuperAdmin(makeReq(), 'other@cellarion.app')).toBe(false);
  });

  test('CURRENT BEHAVIOR: userEmail is compared raw against the lowercased env email', () => {
    // Same asymmetry as requireSuperAdmin: mixed-case caller email → false.
    process.env.SUPER_ADMIN_EMAIL = 'Root@Cellarion.App';
    expect(checkIsSuperAdmin(makeReq(), 'root@cellarion.app')).toBe(true);
    expect(checkIsSuperAdmin(makeReq(), 'Root@Cellarion.App')).toBe(false);
  });

  test('false when an IP allowlist is configured and the client IP is not in it', () => {
    process.env.SUPER_ADMIN_EMAIL = 'root@cellarion.app';
    process.env.SUPER_ADMIN_IPS = '10.0.0.1';
    getClientIp.mockReturnValue('192.168.1.99');
    expect(checkIsSuperAdmin(makeReq(), 'root@cellarion.app')).toBe(false);
  });

  test('true when the client IP is in the allowlist', () => {
    process.env.SUPER_ADMIN_EMAIL = 'root@cellarion.app';
    process.env.SUPER_ADMIN_IPS = '10.0.0.1,10.0.0.2';
    getClientIp.mockReturnValue('10.0.0.1');
    expect(checkIsSuperAdmin(makeReq(), 'root@cellarion.app')).toBe(true);
  });
});
