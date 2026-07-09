/**
 * Guards the L-16 stdout redaction: the pino stream is an independent copy of
 * the audit trail with no TTL and no GDPR-erasure path, so it must never carry
 * identifiers (IP, email, username, invitee addresses, user-agent). The full
 * entry may only go to the MongoDB AuditLog (TTL'd + scrubbed on erasure).
 */
jest.mock('../models/AuditLog', () => ({
  create: jest.fn().mockResolvedValue({}),
}));

const AuditLog = require('../models/AuditLog');
const { logAudit, logger } = require('./audit');

describe('logAudit stdout redaction (L-16)', () => {
  let infoSpy;

  const req = {
    ip: '203.0.113.7',
    user: { id: 'user123', roles: ['user'] },
    headers: { 'user-agent': 'TestAgent/1.0' },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => {});
  });

  afterEach(() => infoSpy.mockRestore());

  it('emits only actor userId/role, action and resource ids to stdout', () => {
    logAudit(
      req,
      'cellar.share.invite',
      { type: 'cellar', id: 'c1', cellarId: 'c1' },
      { invitedEmail: 'friend@example.com', sharedWith: 'friend@example.com', email: 'a@b.c', username: 'alice', role: 'viewer' }
    );

    expect(infoSpy).toHaveBeenCalledTimes(1);
    const [stdoutObj, msg] = infoSpy.mock.calls[0];
    expect(msg).toBe('cellar.share.invite');
    expect(stdoutObj).toEqual({
      actor: { userId: 'user123', role: 'user' },
      action: 'cellar.share.invite',
      resource: { type: 'cellar', id: 'c1', cellarId: 'c1' },
    });

    // Belt and braces: no identifier can appear anywhere in the stdout line.
    const serialized = JSON.stringify(stdoutObj);
    expect(serialized).not.toContain('203.0.113.7');
    expect(serialized).not.toContain('friend@example.com');
    expect(serialized).not.toContain('alice');
    expect(serialized).not.toContain('TestAgent');
    expect(stdoutObj).not.toHaveProperty('detail');
    expect(stdoutObj).not.toHaveProperty('userAgent');
    expect(stdoutObj.actor).not.toHaveProperty('ipAddress');
  });

  it('still persists the FULL entry (incl. ip + detail) to the DB copy', () => {
    logAudit(
      req,
      'auth.register',
      { type: 'user', id: 'user123' },
      { email: 'a@b.c', username: 'alice' }
    );

    expect(AuditLog.create).toHaveBeenCalledTimes(1);
    const entry = AuditLog.create.mock.calls[0][0];
    expect(entry.actor.ipAddress).toBe('203.0.113.7');
    expect(entry.detail).toEqual({ email: 'a@b.c', username: 'alice' });
    expect(entry.userAgent).toBe('TestAgent/1.0');
  });

  it('handles missing resource fields and system (null req) actors', () => {
    logAudit(null, 'stripe.webhook', {}, { secret: 'nope' });

    const [stdoutObj] = infoSpy.mock.calls[0];
    expect(stdoutObj).toEqual({
      actor: { userId: null, role: 'system' },
      action: 'stripe.webhook',
      resource: { type: null, id: null, cellarId: null },
    });
  });
});
