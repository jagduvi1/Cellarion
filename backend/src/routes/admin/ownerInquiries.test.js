/**
 * Owner-inquiry admin surface — create gating + queue + resolve contract.
 *
 * Pins: the create route accepts BOTH somm and admin (it deliberately lives
 * under /api/admin/wines with per-route requireSommOrAdmin, mounted before
 * the admin-gated wines router) and maps the shared service's codes to
 * 201/400/404/409; the admin list runs the expiry sweep, filters only by
 * static-array literals, exposes recipient emails (the ONE surface allowed
 * to) and the pendingCount/answeredCount badge envelope; resolve is a
 * claim-style update so a double-resolve is a clean 409. The notification
 * fan-out itself is asserted in ownerInquiryOps.test.js — the exact create
 * path this route calls. Mock style follows wineProposals.test.js.
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../../services/ownerInquiryOps', () => ({
  createOwnerInquiry: jest.fn(),
  sweepExpiredInquiries: jest.fn().mockResolvedValue(0),
  queryInquiryPage: jest.fn(),
}));
jest.mock('../../models/WineOwnerInquiry', () => ({
  populate: jest.fn(),
  findOneAndUpdate: jest.fn(),
  exists: jest.fn(),
}));
jest.mock('../../services/audit', () => ({ logAudit: jest.fn() }));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const WineOwnerInquiry = require('../../models/WineOwnerInquiry');
const { createOwnerInquiry, sweepExpiredInquiries, queryInquiryPage } = require('../../services/ownerInquiryOps');
const { logAudit } = require('../../services/audit');
const adminOwnerInquiriesRouter = require('./ownerInquiries');

const oid = (c) => c.repeat(24);
const ADMIN_ID = oid('1');
const SOMM_ID = oid('2');
const USER_ID = oid('3');
const W1 = oid('a');
const I1 = oid('b');

const tokenFor = (id, roles) => jwt.sign({ id, roles }, 'test-secret');
const TOKENS = {
  admin: tokenFor(ADMIN_ID, ['admin']),
  somm: tokenFor(SOMM_ID, ['somm']),
  user: tokenFor(USER_ID, ['user']),
};

let server, baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  // Same mount order as app.js: the somm-or-admin create router rides the
  // /api/admin/wines prefix; the admin-only queue router its own.
  app.use('/api/admin/wines', adminOwnerInquiriesRouter.wineInquiryRouter);
  app.use('/api/admin/owner-inquiries', adminOwnerInquiriesRouter);
  server = http.createServer(app);
  server.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.closeAllConnections(); server.close(done); });

beforeEach(() => {
  jest.clearAllMocks();
  sweepExpiredInquiries.mockResolvedValue(0);
  WineOwnerInquiry.populate.mockResolvedValue(undefined); // rows arrive pre-shaped
});

const ask = (wineId, body, who = 'somm') => fetch(`${baseUrl}/api/admin/wines/${wineId}/owner-inquiry`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${TOKENS[who]}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const list = (qs = '', who = 'admin') => fetch(`${baseUrl}/api/admin/owner-inquiries${qs}`, {
  headers: { Authorization: `Bearer ${TOKENS[who]}` },
});
const resolve = (id, body, who = 'admin') => fetch(`${baseUrl}/api/admin/owner-inquiries/${id}/resolve`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${TOKENS[who]}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const QUESTION = 'What does the label say the producer is?';

describe('POST /api/admin/wines/:id/owner-inquiry (create)', () => {
  const created = () => createOwnerInquiry.mockResolvedValue({
    ok: true,
    inquiry: { _id: I1, status: 'open', question: QUESTION, expiresAt: new Date('2026-10-10') },
    wine: { _id: W1, name: 'Barolo', producer: 'Pira' },
    recipientCount: 4,
    fallbackUsed: false,
  });

  test('somm AND admin can ask (201 with recipient count); the shared service gets via rest + the asker', async () => {
    created();
    let res = await ask(W1, { question: QUESTION }, 'somm');
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.recipientCount).toBe(4);
    expect(data.inquiry.status).toBe('open');
    expect(createOwnerInquiry).toHaveBeenCalledWith(expect.objectContaining({
      wineId: W1, userId: SOMM_ID, via: 'rest', question: QUESTION,
    }));

    created();
    res = await ask(W1, { question: QUESTION }, 'admin');
    expect(res.status).toBe(201);
  });

  test('plain users are 403ed before the service runs; no token is 401', async () => {
    const res = await ask(W1, { question: QUESTION }, 'user');
    expect(res.status).toBe(403);
    expect(createOwnerInquiry).not.toHaveBeenCalled();

    const bare = await fetch(`${baseUrl}/api/admin/wines/${W1}/owner-inquiry`, { method: 'POST' });
    expect(bare.status).toBe(401);
  });

  test('service codes map to the HTTP contract: 404 no wine, 400 no owners, 409 open exists, 400 bad question', async () => {
    const cases = [
      [{ ok: false, code: 'not_found', message: 'No registry wine with that id.' }, 404],
      [{ ok: false, code: 'no_owners', message: 'No bottle owners found for this wine' }, 400],
      [{ ok: false, code: 'conflict', message: 'An open owner inquiry already exists' }, 409],
      [{ ok: false, code: 'invalid_input', message: 'A question of at least 10 characters' }, 400],
    ];
    for (const [result, status] of cases) {
      createOwnerInquiry.mockResolvedValueOnce(result);
      const res = await ask(W1, { question: QUESTION });
      expect(res.status).toBe(status);
      expect((await res.json()).error).toBe(result.message);
    }
  });

  test('a malformed wine id never reaches the service', async () => {
    const res = await ask('not-an-id', { question: QUESTION });
    expect(res.status).toBe(400);
    expect(createOwnerInquiry).not.toHaveBeenCalled();
  });
});

describe('GET /api/admin/owner-inquiries (list)', () => {
  const ROW = {
    _id: I1, status: 'answered', question: QUESTION, askedVia: 'mcp',
    askedBy: { _id: SOMM_ID, username: 'somm1' },
    wineDefinition: { _id: W1, name: 'Barolo', producer: 'Pira', appellation: 'Barolo', type: 'red' },
    recipients: [
      { user: { _id: oid('4'), username: 'owner1', email: 'owner1@example.com' }, bottle: oid('5'), notifiedAt: '2026-08-01T00:00:00.000Z', response: 'Label says E. Pira e Figli', respondedAt: '2026-08-02T00:00:00.000Z' },
      { user: { _id: oid('6'), username: 'owner2', email: 'owner2@example.com' }, bottle: oid('7'), notifiedAt: '2026-08-01T00:00:00.000Z', response: null, respondedAt: null },
    ],
    resolvedBy: null, resolvedAt: null, resolutionNote: null,
    expiresAt: '2026-10-01T00:00:00.000Z', createdAt: '2026-08-01T00:00:00.000Z',
  };

  test('admin-only: a somm gets 403 here (answers-with-identities are the admin surface)', async () => {
    const res = await list('', 'somm');
    expect(res.status).toBe(403);
    expect(queryInquiryPage).not.toHaveBeenCalled();
  });

  test('runs the expiry sweep, returns the badge envelope, exposes recipient emails and response counts', async () => {
    queryInquiryPage.mockResolvedValue({ rows: [ROW], total: 1, pendingCount: 3, answeredCount: 2 });

    const res = await list('?status=active');
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(sweepExpiredInquiries).toHaveBeenCalledTimes(1);
    expect(data).toMatchObject({ total: 1, page: 1, pages: 1, pendingCount: 3, answeredCount: 2 });
    const row = data.inquiries[0];
    expect(row.recipientCount).toBe(2);
    expect(row.responseCount).toBe(1);
    expect(row.recipients[0].user.email).toBe('owner1@example.com');
    expect(row.recipients[0].response).toBe('Label says E. Pira e Figli');
    expect(row.askedBy.username).toBe('somm1');
    expect(row.askedVia).toBe('mcp');

    // 'active' resolves to the static-array literal $in — never raw input.
    expect(queryInquiryPage.mock.calls[0][0]).toEqual({ status: { $in: ['open', 'answered'] } });
  });

  test('status filters come from the static arrays; junk input means no filter', async () => {
    queryInquiryPage.mockResolvedValue({ rows: [], total: 0, pendingCount: 0, answeredCount: 0 });

    await list('?status=answered');
    expect(queryInquiryPage.mock.calls[0][0]).toEqual({ status: 'answered' });

    await list('?status=decided');
    expect(queryInquiryPage.mock.calls[1][0]).toEqual({ status: { $in: ['resolved', 'closed'] } });

    await list('?status[$ne]=x');
    expect(queryInquiryPage.mock.calls[2][0]).toEqual({});
  });
});

describe('POST /api/admin/owner-inquiries/:id/resolve', () => {
  test('requires a note of at least 5 chars — nothing resolved without one', async () => {
    let res = await resolve(I1, {});
    expect(res.status).toBe(400);
    res = await resolve(I1, { note: 'ok' });
    expect(res.status).toBe(400);
    expect(WineOwnerInquiry.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test('resolves via an atomic claim on an ACTIVE row, stores the note, audits', async () => {
    WineOwnerInquiry.findOneAndUpdate.mockResolvedValue({
      _id: I1, wineDefinition: W1, status: 'resolved',
      recipients: [{ response: 'answer' }, { response: null }],
    });

    const res = await resolve(I1, { note: 'Producer corrected to E. Pira e Figli per two owner answers.' });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('resolved');

    const [filter, update] = WineOwnerInquiry.findOneAndUpdate.mock.calls[0];
    expect(filter.status).toEqual({ $in: ['open', 'answered'] });
    expect(update.$set.status).toBe('resolved');
    expect(update.$set.resolvedBy).toBe(ADMIN_ID);
    expect(update.$set.resolutionNote).toMatch(/Producer corrected/);

    const audit = logAudit.mock.calls.find((c) => c[1] === 'admin.wine.ownerInquiry.resolve');
    expect(audit).toBeTruthy();
    expect(audit[3].responses).toBe(1);
  });

  test('a second resolve is a clean 409 (claim already taken), a bogus id is 404', async () => {
    WineOwnerInquiry.findOneAndUpdate.mockResolvedValue(null);
    WineOwnerInquiry.exists.mockResolvedValueOnce({ _id: I1 }).mockResolvedValueOnce(null);

    let res = await resolve(I1, { note: 'Second admin, seconds later.' });
    expect(res.status).toBe(409);
    res = await resolve(I1, { note: 'Never existed.' });
    expect(res.status).toBe(404);
  });

  test('admin-only: a somm cannot resolve', async () => {
    const res = await resolve(I1, { note: 'A valid note.' }, 'somm');
    expect(res.status).toBe(403);
    expect(WineOwnerInquiry.findOneAndUpdate).not.toHaveBeenCalled();
  });
});
