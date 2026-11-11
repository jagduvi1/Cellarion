/**
 * Sharing a cellar: GET, POST, PUT and DELETE under /api/cellars/:id/members.
 *
 * Pinned as the endpoints behave today:
 *   - only the owner lists, adds and changes members; anyone else is told the
 *     cellar is not found, and so is the owner of a soft-deleted cellar
 *   - adding someone who has an account makes them a member at once, tells
 *     them, and moves their data version so their cellar list is read again
 *   - adding an address without an account stores a pending invitation and
 *     sends the invite email; an address invited before is refused, and an
 *     account may send only so many invitations a day
 *   - a demo account cannot invite at all
 *   - a role change is the owner's; an editor made a viewer loses the climate
 *     devices they had assigned to the cellar
 *   - the owner removes a member, and a member may remove themself, never
 *     someone else; a removed member's climate devices are detached
 *   - every change is audited
 *
 * Real router and requireAuth (HS256 test tokens); the models are mocked.
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../services/bottleSearch', () => ({ searchBottles: jest.fn(), bottleFacets: jest.fn() }));
jest.mock('../services/openBottleList', () => ({ listOpenBottles: jest.fn() }));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../services/rackOps', () => ({ createCellar: jest.fn() }));
jest.mock('../services/notifications', () => ({ createNotification: jest.fn() }));
jest.mock('../services/cellarTransfer', () => ({ transferCellarOwnership: jest.fn() }));
jest.mock('../services/mailgun', () => ({ sendCellarInviteEmail: jest.fn() }));
jest.mock('../utils/exchangeRates', () => ({
  getSnapshotsForDates: jest.fn(), getOrCreateDailySnapshot: jest.fn(), convertCurrency: jest.fn(),
}));
jest.mock('../models/Cellar', () => ({ findById: jest.fn(), findOne: jest.fn(), find: jest.fn() }));
jest.mock('../models/Bottle', () => ({ find: jest.fn(), countDocuments: jest.fn(), aggregate: jest.fn() }));
jest.mock('../models/WineDefinition', () => ({ find: jest.fn() }));
jest.mock('../models/Rack', () => ({ find: jest.fn() }));
jest.mock('../models/BottleImage', () => ({ find: jest.fn() }));
jest.mock('../models/User', () => ({ findOne: jest.fn(), findById: jest.fn(), exists: jest.fn() }));
jest.mock('../models/AuditLog', () => ({}));
jest.mock('../models/PendingShare', () => ({ findOne: jest.fn(), countDocuments: jest.fn(), create: jest.fn() }));
jest.mock('../models/ClimateDevice', () => ({ updateMany: jest.fn() }));
jest.mock('../models/WineRequest', () => ({}));
jest.mock('../models/Country', () => ({}));
jest.mock('../models/Region', () => ({}));
jest.mock('../models/Grape', () => ({}));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const Cellar = require('../models/Cellar');
const User = require('../models/User');
const PendingShare = require('../models/PendingShare');
const ClimateDevice = require('../models/ClimateDevice');
const { logAudit } = require('../services/audit');
const { createNotification } = require('../services/notifications');
const { sendCellarInviteEmail } = require('../services/mailgun');
const { getDataVersion } = require('../services/dataVersion');
const cellarsRouter = require('./cellars');

const OWNER_ID = '64b000000000000000000001';
const MEMBER_ID = '64b000000000000000000002';
const OTHER_MEMBER_ID = '64b000000000000000000003';
const STRANGER_ID = '64b000000000000000000004';
const CELLAR_ID = '64b0000000000000000000c1';
const BASE = `/api/cellars/${CELLAR_ID}/members`;

function request(method, url, { body, as = OWNER_ID, demo = false } = {}) {
  const app = express();
  app.use(express.json());
  app.use('/api/cellars', cellarsRouter);
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const payload = body === undefined ? null : JSON.stringify(body);
      const claims = { id: as, roles: ['user'], ...(demo ? { isDemo: true } : {}) };
      const req = http.request({
        port: server.address().port,
        path: url,
        method,
        headers: {
          authorization: `Bearer ${jwt.sign(claims, 'test-secret', { algorithm: 'HS256', expiresIn: '1h' })}`,
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          server.close();
          resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) });
        });
      });
      req.on('error', (e) => { server.close(); reject(e); });
      if (payload) req.write(payload);
      req.end();
    });
  });
}

// A query that can be awaited as it is or after .populate(), like Mongoose's.
const query = (doc) => {
  const q = Promise.resolve(doc);
  q.populate = jest.fn(() => Promise.resolve(doc));
  return q;
};
const auditOf = (action) => logAudit.mock.calls.filter((c) => c[1] === action);
const CELLAR_REF = { type: 'cellar', id: CELLAR_ID, cellarId: CELLAR_ID };

let cellar;
let consoleError;

beforeEach(() => {
  jest.clearAllMocks();
  cellar = {
    _id: CELLAR_ID,
    name: 'Home',
    user: OWNER_ID,
    deletedAt: null,
    members: [{ user: MEMBER_ID, role: 'editor' }, { user: OTHER_MEMBER_ID, role: 'viewer' }],
    save: jest.fn().mockResolvedValue(undefined),
    populate: jest.fn().mockResolvedValue(undefined),
  };
  // The owner-only lookups ask for this cellar as its owner; anyone else finds nothing.
  Cellar.findOne.mockImplementation((filter) => query(String(filter.user) === OWNER_ID ? cellar : null));
  Cellar.findById.mockImplementation(() => query(cellar));
  User.findOne.mockResolvedValue(null);
  User.findById.mockReturnValue({ select: () => ({ lean: async () => ({ username: 'owner', email: 'owner@example.com' }) }) });
  User.exists.mockResolvedValue(true);
  PendingShare.findOne.mockResolvedValue(null);
  PendingShare.countDocuments.mockResolvedValue(0);
  PendingShare.create.mockResolvedValue({});
  ClimateDevice.updateMany.mockResolvedValue({});
  sendCellarInviteEmail.mockResolvedValue(undefined);
  consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  consoleError.mockRestore();
});

describe('GET /api/cellars/:id/members', () => {
  test('the owner gets the members, with each one\'s name and address', async () => {
    const { status, body } = await request('GET', BASE);

    expect(status).toBe(200);
    expect(Cellar.findOne).toHaveBeenCalledWith({ _id: CELLAR_ID, user: OWNER_ID, deletedAt: null });
    expect(Cellar.findOne.mock.results[0].value.populate).toHaveBeenCalledWith('members.user', 'username email');
    expect(body.members).toEqual([{ user: MEMBER_ID, role: 'editor' }, { user: OTHER_MEMBER_ID, role: 'viewer' }]);
  });

  test('a member is told the cellar is not found; a malformed id is a 400', async () => {
    expect((await request('GET', BASE, { as: MEMBER_ID })).status).toBe(404);
    expect((await request('GET', '/api/cellars/nope/members')).status).toBe(400);
  });
});

describe('POST /api/cellars/:id/members — someone who has an account', () => {
  const NEW_ID = '64b000000000000000000009';
  beforeEach(() => {
    User.findOne.mockResolvedValue({ _id: NEW_ID, email: 'new@example.com' });
  });

  test('becomes a member at once, is told, and their cellar list is read again', async () => {
    const before = getDataVersion(NEW_ID);

    const { status, body } = await request('POST', BASE, { body: { email: '  New@Example.com ', role: 'viewer' } });

    expect(status).toBe(201);
    // The address is looked up lowercased and trimmed.
    expect(User.findOne).toHaveBeenCalledWith({ email: 'new@example.com' });
    expect(cellar.members[2]).toEqual({ user: NEW_ID, role: 'viewer' });
    expect(cellar.save).toHaveBeenCalledTimes(1);
    expect(getDataVersion(NEW_ID)).not.toBe(before);
    expect(createNotification).toHaveBeenCalledWith(
      NEW_ID, 'cellar_shared', 'Cellar shared with you',
      'owner shared their cellar "Home" with you (viewer).', '/cellars',
    );
    expect(auditOf('cellar.share.add')).toHaveLength(1);
    expect(auditOf('cellar.share.add')[0].slice(2)).toEqual([CELLAR_REF, { sharedWith: 'new@example.com', role: 'viewer' }]);
    expect(cellar.populate).toHaveBeenCalledWith('members.user', 'username email');
    expect(body.members).toHaveLength(3);
    // No invitation, no email.
    expect(PendingShare.create).not.toHaveBeenCalled();
    expect(sendCellarInviteEmail).not.toHaveBeenCalled();
  });

  test('someone who is a member already is refused, and nothing is saved', async () => {
    User.findOne.mockResolvedValue({ _id: MEMBER_ID, email: 'member@example.com' });

    const { status, body } = await request('POST', BASE, { body: { email: 'member@example.com', role: 'viewer' } });

    expect(status).toBe(400);
    expect(body.error).toBe('User is already a member of this cellar');
    expect(cellar.save).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  test('the owner cannot share the cellar with themself', async () => {
    User.findOne.mockResolvedValue({ _id: OWNER_ID, email: 'owner@example.com' });

    const { status, body } = await request('POST', BASE, { body: { email: 'owner@example.com', role: 'editor' } });

    expect(status).toBe(400);
    expect(body.error).toBe('Cannot share a cellar with yourself');
    expect(cellar.save).not.toHaveBeenCalled();
  });
});

describe('POST /api/cellars/:id/members — an address without an account', () => {
  test('gets a pending invitation and the invite email', async () => {
    const { status, body } = await request('POST', BASE, { body: { email: 'Friend@Example.com', role: 'editor' } });

    expect(status).toBe(202);
    expect(body).toEqual({
      invited: true,
      message: 'Invitation sent to friend@example.com. The cellar will be shared when they join Cellarion.',
    });
    expect(PendingShare.findOne).toHaveBeenCalledWith({ email: 'friend@example.com', cellar: CELLAR_ID });
    expect(PendingShare.create).toHaveBeenCalledWith({ email: 'friend@example.com', cellar: CELLAR_ID, role: 'editor', invitedBy: OWNER_ID });
    expect(sendCellarInviteEmail).toHaveBeenCalledWith('friend@example.com', 'owner', 'owner@example.com', 'Home', 'editor');
    expect(auditOf('cellar.share.invite')[0].slice(2)).toEqual([CELLAR_REF, { invitedEmail: 'friend@example.com', role: 'editor' }]);
    // Not a member until they join.
    expect(cellar.members).toHaveLength(2);
    expect(cellar.save).not.toHaveBeenCalled();
  });

  test('the cellar name in the email is cut at 100 characters, and a failed email does not fail the invitation', async () => {
    cellar.name = 'x'.repeat(140);
    sendCellarInviteEmail.mockRejectedValue(new Error('mail down'));

    const { status } = await request('POST', BASE, { body: { email: 'friend@example.com', role: 'viewer' } });

    expect(status).toBe(202);
    expect(sendCellarInviteEmail.mock.calls[0][3]).toBe('x'.repeat(100));
    expect(PendingShare.create).toHaveBeenCalledTimes(1);
  });

  test('an address invited to this cellar before is refused', async () => {
    PendingShare.findOne.mockResolvedValue({ _id: 'p1' });

    const { status, body } = await request('POST', BASE, { body: { email: 'friend@example.com', role: 'viewer' } });

    expect(status).toBe(400);
    expect(body.error).toBe('An invitation has already been sent to this email');
    expect(PendingShare.create).not.toHaveBeenCalled();
    expect(sendCellarInviteEmail).not.toHaveBeenCalled();
  });

  test('the twenty-first invitation of a day is a 429, audited, and nothing is sent', async () => {
    PendingShare.countDocuments.mockResolvedValue(20);
    const sinceBefore = Date.now() - 24 * 3600e3;

    const { status } = await request('POST', BASE, { body: { email: 'friend@example.com', role: 'viewer' } });

    expect(status).toBe(429);
    const counted = PendingShare.countDocuments.mock.calls[0][0];
    expect(counted.invitedBy).toBe(OWNER_ID);
    // Counted over the last 24 hours.
    expect(Math.abs(counted.createdAt.$gte.getTime() - sinceBefore)).toBeLessThan(60e3);
    expect(auditOf('system.rate_limit_exceeded')[0].slice(2)).toEqual([
      { type: 'cellar', id: CELLAR_ID }, { limiter: 'cellarInvites', limit: 20 },
    ]);
    expect(PendingShare.create).not.toHaveBeenCalled();
    expect(sendCellarInviteEmail).not.toHaveBeenCalled();

    // One below the limit still goes out.
    PendingShare.countDocuments.mockResolvedValue(19);
    expect((await request('POST', BASE, { body: { email: 'friend@example.com', role: 'viewer' } })).status).toBe(202);
  });
});

describe('POST /api/cellars/:id/members — who may, and with what', () => {
  test('what is sent is checked before anything is looked up', async () => {
    const post = (body) => request('POST', BASE, { body });

    expect((await post({ role: 'viewer' })).body.error).toBe('email and role are required');
    expect((await post({ email: 'a@b.co' })).body.error).toBe('email and role are required');
    expect((await post({ email: 'a@b.co', role: 'owner' })).body.error).toBe('role must be viewer or editor');
    expect(Cellar.findOne).not.toHaveBeenCalled();

    for (const email of ['not-an-address', 'a b@c.de', `${'x'.repeat(250)}@b.co`]) {
      const { status, body } = await post({ email, role: 'viewer' });
      expect([status, body.error]).toEqual([400, 'A valid email address is required']);
    }
    expect(User.findOne).not.toHaveBeenCalled();
    expect((await request('POST', '/api/cellars/nope/members', { body: { email: 'a@b.co', role: 'viewer' } })).status).toBe(400);
  });

  test('a member, editor or not, is told the cellar is not found', async () => {
    const { status } = await request('POST', BASE, { as: MEMBER_ID, body: { email: 'friend@example.com', role: 'viewer' } });

    expect(status).toBe(404);
    expect(Cellar.findOne).toHaveBeenCalledWith({ _id: CELLAR_ID, user: MEMBER_ID, deletedAt: null });
    expect(PendingShare.create).not.toHaveBeenCalled();
  });

  test('a demo account cannot invite', async () => {
    const { status } = await request('POST', BASE, { demo: true, body: { email: 'friend@example.com', role: 'viewer' } });

    expect(status).toBe(403);
    expect(Cellar.findOne).not.toHaveBeenCalled();
    expect(sendCellarInviteEmail).not.toHaveBeenCalled();
  });
});

describe('PUT /api/cellars/:id/members/:userId', () => {
  const put = (userId, role, options = {}) => request('PUT', `${BASE}/${userId}`, { body: { role }, ...options });

  test('the owner changes a member\'s role; the member\'s cellar list is read again', async () => {
    const before = getDataVersion(OTHER_MEMBER_ID);

    const { status, body } = await put(OTHER_MEMBER_ID, 'editor');

    expect(status).toBe(200);
    expect(cellar.members[1]).toEqual({ user: OTHER_MEMBER_ID, role: 'editor' });
    expect(cellar.save).toHaveBeenCalledTimes(1);
    expect(getDataVersion(OTHER_MEMBER_ID)).not.toBe(before);
    expect(auditOf('cellar.share.update')[0].slice(2)).toEqual([
      CELLAR_REF, { memberId: OTHER_MEMBER_ID, from: 'viewer', to: 'editor' },
    ]);
    expect(body.members).toHaveLength(2);
    // Made an editor: nothing to detach.
    expect(ClimateDevice.updateMany).not.toHaveBeenCalled();
  });

  test('an editor made a viewer loses the climate devices they assigned to this cellar', async () => {
    const { status } = await put(MEMBER_ID, 'viewer');

    expect(status).toBe(200);
    expect(ClimateDevice.updateMany).toHaveBeenCalledWith({ cellar: CELLAR_ID, user: MEMBER_ID }, { $set: { cellar: null } });
  });

  test('a role that is not viewer or editor, a malformed id and an unknown member are refused', async () => {
    expect((await put(MEMBER_ID, 'owner')).status).toBe(400);
    expect((await put(MEMBER_ID, undefined)).status).toBe(400);
    expect((await put('nope', 'viewer')).status).toBe(400);
    expect((await request('PUT', '/api/cellars/nope/members/' + MEMBER_ID, { body: { role: 'viewer' } })).status).toBe(400);

    const unknown = await put(STRANGER_ID, 'viewer');
    expect([unknown.status, unknown.body.error]).toEqual([404, 'Member not found']);
    expect(cellar.save).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  test('a member cannot change a role, their own included: the cellar is not found', async () => {
    const { status, body } = await put(MEMBER_ID, 'editor', { as: MEMBER_ID });

    expect([status, body.error]).toEqual([404, 'Cellar not found']);
    expect(cellar.save).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/cellars/:id/members/:userId', () => {
  const remove = (userId, options = {}) => request('DELETE', `${BASE}/${userId}`, options);

  test('the owner removes a member: gone from the list, devices detached, audited', async () => {
    const before = getDataVersion(MEMBER_ID);

    const { status, body } = await remove(MEMBER_ID);

    expect(status).toBe(200);
    expect(body).toEqual({ message: 'Member removed successfully' });
    expect(cellar.members).toEqual([{ user: OTHER_MEMBER_ID, role: 'viewer' }]);
    expect(cellar.save).toHaveBeenCalledTimes(1);
    expect(getDataVersion(MEMBER_ID)).not.toBe(before);
    expect(ClimateDevice.updateMany).toHaveBeenCalledWith({ cellar: CELLAR_ID, user: MEMBER_ID }, { $set: { cellar: null } });
    expect(auditOf('cellar.share.remove')[0].slice(2)).toEqual([CELLAR_REF, { removedUserId: MEMBER_ID }]);
  });

  test('a member may remove themself', async () => {
    const { status } = await remove(OTHER_MEMBER_ID, { as: OTHER_MEMBER_ID });

    expect(status).toBe(200);
    expect(cellar.members).toEqual([{ user: MEMBER_ID, role: 'editor' }]);
    expect(auditOf('cellar.share.remove')).toHaveLength(1);
  });

  test('a member cannot remove another member, and neither can a stranger', async () => {
    for (const as of [MEMBER_ID, STRANGER_ID]) {
      const { status, body } = await remove(OTHER_MEMBER_ID, { as });
      expect([status, body.error]).toEqual([403, 'Not authorized']);
    }
    expect(cellar.members).toHaveLength(2);
    expect(cellar.save).not.toHaveBeenCalled();
    expect(ClimateDevice.updateMany).not.toHaveBeenCalled();
  });

  test('someone who is not a member, a missing cellar and a malformed id', async () => {
    const notMember = await remove(STRANGER_ID);
    expect([notMember.status, notMember.body.error]).toEqual([404, 'Member not found']);

    Cellar.findById.mockImplementation(() => query(null));
    const noCellar = await remove(MEMBER_ID);
    expect([noCellar.status, noCellar.body.error]).toEqual([404, 'Cellar not found']);

    expect((await remove('nope')).status).toBe(400);
    expect((await request('DELETE', '/api/cellars/nope/members/' + MEMBER_ID)).status).toBe(400);
    expect(cellar.save).not.toHaveBeenCalled();
  });
});

describe('PUT /api/cellars/:id: a name or description that is not text', () => {
  test.each([
    ['a name that is a number', { name: 5 }, 'name must be text'],
    ['a name that is an object', { name: { $gt: '' } }, 'name must be text'],
    ['a description that is a list', { description: ['a'] }, 'description must be text'],
  ])('%s is a 400 before the cellar is read', async (label, body, message) => {
    const res = await request('PUT', `/api/cellars/${CELLAR_ID}`, { body });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(message);
  });
});
