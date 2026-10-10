/**
 * SuperAdmin → Feature flags: GET /api/superadmin/features and
 * PATCH /api/superadmin/features/:key.
 *
 * WHY THIS TEST EXISTS:
 * The PATCH decides which screens members see, without a deploy. It must
 * refuse an unknown feature, a body with nothing to change and a forum link
 * off this site, hand a valid change to services/earlyAccess (which saves it
 * and sends the notices — its own suite), and leave an audit row naming the
 * before and after.
 *
 * Auth is stubbed to a signed-in super admin (the real gate has its own
 * suite); the router's heavy services are stubbed since these routes never
 * touch them.
 */
jest.mock('../middleware/auth', () => ({
  requireAuth: (req, res, next) => { req.user = { id: 'admin-1', roles: ['admin'] }; next(); },
}));
jest.mock('../middleware/superAdmin', () => ({ requireSuperAdmin: (req, res, next) => next() }));
jest.mock('../services/search', () => ({ getIsAvailable: () => false, search: async () => ({ ids: [] }) }));
jest.mock('../services/embeddingJob', () => ({}));
jest.mock('../services/enrichmentJob', () => ({}));
jest.mock('../services/vectorStore', () => ({}));
jest.mock('../services/aiChat', () => ({ getEventLog: () => [] }));
jest.mock('../utils/siteConfig', () => ({ updateSiteConfig: jest.fn() }));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../services/earlyAccess', () => ({ changeFlag: jest.fn(), overview: jest.fn() }));

const express = require('express');
const http = require('http');
const { logAudit } = require('../services/audit');
const earlyAccess = require('../services/earlyAccess');
const superadminRouter = require('./superadmin');

function call(method, path, body) {
  const app = express();
  app.use(express.json());
  app.use('/api/superadmin', superadminRouter);
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const payload = body === undefined ? null : JSON.stringify(body);
      const req = http.request({
        port: server.address().port,
        path,
        method,
        headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          server.close();
          resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString() || 'null') });
        });
      });
      req.on('error', (e) => { server.close(); reject(e); });
      if (payload) req.write(payload);
      req.end();
    });
  });
}

const flag = (over = {}) => ({ key: 'vintagePage', title: 'One page per wine and vintage', state: 'beta', betaAt: null, releasedAt: null, forumPath: null, ...over });

beforeEach(() => {
  jest.clearAllMocks();
  earlyAccess.changeFlag.mockImplementation(async (key, patch) => ({
    before: flag(),
    after: flag({ ...(patch.state ? { state: patch.state } : {}), ...(patch.forumPath !== undefined ? { forumPath: patch.forumPath } : {}) }),
    notified: { announced: 0, thanked: patch.state === 'everyone' ? 4 : 0 },
  }));
});

describe('GET /api/superadmin/features', () => {
  test('answers the overview: members in early access and each flag with its feedback', async () => {
    earlyAccess.overview.mockResolvedValue({ optedIn: 3, features: [flag({ feedback: { total: 2, open: 1 } })] });
    const { status, body } = await call('GET', '/api/superadmin/features');
    expect(status).toBe(200);
    expect(body.optedIn).toBe(3);
    expect(body.features[0].feedback).toEqual({ total: 2, open: 1 });
  });
});

describe('PATCH /api/superadmin/features/:key', () => {
  test('moves a flag, answers the new state and the notices sent, and writes an audit row', async () => {
    const { status, body } = await call('PATCH', '/api/superadmin/features/vintagePage', { state: 'everyone' });
    expect(status).toBe(200);
    expect(body.feature.state).toBe('everyone');
    expect(body.notified).toEqual({ announced: 0, thanked: 4 });
    expect(earlyAccess.changeFlag).toHaveBeenCalledWith('vintagePage', { state: 'everyone' }, 'admin-1');
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'superadmin.feature_flag', { type: 'feature', id: 'vintagePage' }, {
      from: { state: 'beta', forumPath: null },
      to: { state: 'everyone', forumPath: null },
      notified: { announced: 0, thanked: 4 },
    });
  });

  test('a full forum link to this site is saved as its path; one to another site is refused before anything is saved', async () => {
    let res = await call('PATCH', '/api/superadmin/features/vintagePage', { forumPath: 'https://cellarion.app/community/discussions/vintage-page' });
    expect(res.status).toBe(200);
    expect(earlyAccess.changeFlag).toHaveBeenCalledWith('vintagePage', { forumPath: '/community/discussions/vintage-page' }, 'admin-1');

    earlyAccess.changeFlag.mockClear();
    res = await call('PATCH', '/api/superadmin/features/vintagePage', { forumPath: 'https://elsewhere.example.com/thread' });
    expect(res.status).toBe(400);
    expect(earlyAccess.changeFlag).not.toHaveBeenCalled();
  });

  test('an unknown feature is a 404 and an empty body a 400', async () => {
    expect((await call('PATCH', '/api/superadmin/features/noSuchFeature', { state: 'beta' })).status).toBe(404);
    expect((await call('PATCH', '/api/superadmin/features/vintagePage', {})).status).toBe(400);
    expect(earlyAccess.changeFlag).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  test('a refusal from the service (an unknown state) is passed on, with no audit row', async () => {
    earlyAccess.changeFlag.mockResolvedValue({ error: { status: 400, message: 'state must be one of: off, beta, everyone' } });
    const { status, body } = await call('PATCH', '/api/superadmin/features/vintagePage', { state: 'later' });
    expect(status).toBe(400);
    expect(body.error).toMatch(/state must be/);
    expect(logAudit).not.toHaveBeenCalled();
  });
});
