/**
 * /api/owner-inquiries — the owner-side contract.
 *
 * Pins: /mine returns ONLY the caller's own recipient entry (never other
 * recipients' identities or answers — the privacy line of the feature) and
 * filters expired-open rows query-time; respond is an atomic single-shot
 * claim — recipient-only (403), immutable (second attempt 409), demo-blocked
 * (403), closed/expired-blocked (409) — that flips the inquiry to 'answered'
 * and notifies the asker.
 */

process.env.JWT_SECRET = 'test-secret';

jest.mock('../models/WineOwnerInquiry', () => ({
  find: jest.fn(),
  findById: jest.fn(),
  findOneAndUpdate: jest.fn(),
}));
// requireAuth calls User.exists for demo tokens (must resolve truthy or the
// demo test would 401 and prove nothing); the respond path reads the asker's
// roles for the notification link.
jest.mock('../models/User', () => ({
  exists: jest.fn(async () => ({ _id: 'demo1' })),
  findById: jest.fn(),
}));
jest.mock('../services/notifications', () => ({ createNotification: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const WineOwnerInquiry = require('../models/WineOwnerInquiry');
const User = require('../models/User');
const { createNotification } = require('../services/notifications');
const { logAudit } = require('../services/audit');
const ownerInquiriesRouter = require('./ownerInquiries');

const oid = (c) => c.repeat(24);
const ME = oid('1');
const OTHER = oid('2');
const ASKER = oid('3');
const I1 = oid('b');
const W1 = oid('a');

const tokenFor = (id, extra = {}) => jwt.sign({ id, roles: ['user'], ...extra }, 'test-secret');

let server, baseUrl;
beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/owner-inquiries', ownerInquiriesRouter);
  server = http.createServer(app);
  server.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.closeAllConnections(); server.close(done); });

beforeEach(() => jest.clearAllMocks());

const mine = (qs = '', token = tokenFor(ME)) => fetch(`${baseUrl}/api/owner-inquiries/mine${qs}`, {
  headers: { Authorization: `Bearer ${token}` },
});
const respond = (id, body, token = tokenFor(ME)) => fetch(`${baseUrl}/api/owner-inquiries/${id}/respond`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const findChain = (rows) => {
  const c = {};
  for (const m of ['sort', 'limit', 'populate']) c[m] = jest.fn(() => c);
  c.lean = jest.fn(() => Promise.resolve(rows));
  return c;
};

const INQUIRY_ROW = {
  _id: I1,
  status: 'open',
  question: 'What does the label say the producer is?',
  wineDefinition: { _id: W1, name: 'Barolo', producer: 'Pira' },
  recipients: [
    { user: ME, bottle: oid('5'), notifiedAt: '2026-08-01T00:00:00.000Z', response: null, respondedAt: null },
    { user: OTHER, bottle: oid('6'), notifiedAt: '2026-08-01T00:00:00.000Z', response: 'Secret answer from another owner', respondedAt: '2026-08-02T00:00:00.000Z' },
  ],
  createdAt: '2026-08-01T00:00:00.000Z',
  expiresAt: '2026-10-01T00:00:00.000Z',
};

describe('GET /mine', () => {
  test('returns ONLY the caller recipient view — no other recipients, identities or answers', async () => {
    WineOwnerInquiry.find.mockReturnValue(findChain([INQUIRY_ROW]));

    const res = await mine();
    expect(res.status).toBe(200);
    const { inquiries } = await res.json();
    expect(inquiries).toHaveLength(1);

    const row = inquiries[0];
    expect(row.question).toBe(INQUIRY_ROW.question);
    expect(String(row.bottle)).toBe(oid('5')); // MY bottle
    expect(row.responded).toBe(false);
    // The privacy line: nothing about the other recipient may appear.
    expect(row.recipients).toBeUndefined();
    const raw = JSON.stringify(row);
    expect(raw).not.toContain(OTHER);
    expect(raw).not.toContain('Secret answer from another owner');

    // Query scope: addressed to me, and only answerable rows (answered, or
    // open-and-not-expired — the query-time half of the expiry design).
    const filter = WineOwnerInquiry.find.mock.calls[0][0];
    expect(filter['recipients.user']).toBe(ME);
    expect(filter.$or[0]).toEqual({ status: 'answered' });
    expect(filter.$or[1].status).toBe('open');
    expect(filter.$or[1].expiresAt.$gt).toBeInstanceOf(Date);
  });

  test('?wine= scopes to one wine; an invalid id yields an empty list, never a cast error', async () => {
    WineOwnerInquiry.find.mockReturnValue(findChain([]));
    await mine(`?wine=${W1}`);
    expect(WineOwnerInquiry.find.mock.calls[0][0].wineDefinition).toBe(W1);

    const res = await mine('?wine=not-an-id');
    expect(res.status).toBe(200);
    expect((await res.json()).inquiries).toEqual([]);
    expect(WineOwnerInquiry.find).toHaveBeenCalledTimes(1); // invalid id never queried
  });
});

describe('POST /:id/respond', () => {
  const claimed = () => {
    const doc = {
      _id: I1, status: 'answered', askedBy: ASKER,
      wineDefinition: { _id: W1, name: 'Barolo', producer: 'Pira' },
    };
    const q = { populate: jest.fn().mockResolvedValue(doc) };
    WineOwnerInquiry.findOneAndUpdate.mockReturnValue(q);
    return doc;
  };
  const askerIs = (roles) => User.findById.mockReturnValue({
    select: () => ({ lean: async () => ({ _id: ASKER, roles }) }),
  });

  test('happy path: atomic recipient claim, positional write, flips to answered, notifies the ADMIN asker with the queue link, audits', async () => {
    claimed();
    askerIs(['admin']);

    const res = await respond(I1, { response: 'The label says E. Pira e Figli.' });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('answered');

    const [filter, update] = WineOwnerInquiry.findOneAndUpdate.mock.calls[0];
    // Recipient + not-yet-answered + still-answerable, all in ONE filter —
    // that is what makes the second submit lose atomically.
    expect(filter._id).toBe(I1);
    expect(filter.recipients.$elemMatch).toEqual({ user: ME, response: null });
    expect(filter.$or[0]).toEqual({ status: 'answered' });
    expect(update.$set['recipients.$.response']).toBe('The label says E. Pira e Figli.');
    expect(update.$set['recipients.$.respondedAt']).toBeInstanceOf(Date);
    expect(update.$set.status).toBe('answered');

    await new Promise((r) => setTimeout(r, 0)); // asker notify is fire-and-forget
    expect(createNotification).toHaveBeenCalledWith(
      ASKER, 'owner_inquiry_response',
      expect.any(String), expect.stringContaining('Pira — Barolo'),
      '/admin/wines', 'community'
    );
    const audit = logAudit.mock.calls.find((c) => c[1] === 'user.ownerInquiry.respond');
    expect(audit).toBeTruthy();
    // Data minimisation: the audit detail carries the length, never the text.
    expect(JSON.stringify(audit[3])).not.toContain('E. Pira e Figli');
  });

  test('a somm asker gets the notification WITHOUT the admin-queue link (they read answers over MCP)', async () => {
    claimed();
    askerIs(['somm']);

    await respond(I1, { response: 'The label says E. Pira e Figli.' });
    await new Promise((r) => setTimeout(r, 0));
    expect(createNotification.mock.calls[0][4]).toBeNull();
  });

  test('HTML strips to plain text; an empty or overlong response is 400 before any write', async () => {
    let res = await respond(I1, { response: '<b></b>' });
    expect(res.status).toBe(400);
    res = await respond(I1, { response: 'x'.repeat(1001) });
    expect(res.status).toBe(400);
    expect(WineOwnerInquiry.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test('demo accounts are 403ed before any write (requireNonDemo)', async () => {
    const res = await respond(I1, { response: 'A perfectly good answer' }, tokenFor('demo1', { isDemo: true }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/demo/i);
    expect(WineOwnerInquiry.findOneAndUpdate).not.toHaveBeenCalled();
  });

  const failClaim = () => WineOwnerInquiry.findOneAndUpdate.mockReturnValue({ populate: jest.fn().mockResolvedValue(null) });
  const diagnose = (doc) => WineOwnerInquiry.findById.mockReturnValue({
    select: () => ({ lean: async () => doc }),
  });

  test('failed claim diagnoses: 404 gone, 403 non-recipient, 409 second attempt, 409 no longer open', async () => {
    failClaim();

    diagnose(null);
    let res = await respond(I1, { response: 'answer' });
    expect(res.status).toBe(404);

    diagnose({ status: 'open', expiresAt: new Date(Date.now() + 1000), recipients: [{ user: OTHER, response: null }] });
    res = await respond(I1, { response: 'answer' });
    expect(res.status).toBe(403);

    diagnose({ status: 'answered', recipients: [{ user: ME, response: 'already said so' }] });
    res = await respond(I1, { response: 'answer' });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/already answered/);

    diagnose({ status: 'resolved', recipients: [{ user: ME, response: null }] });
    res = await respond(I1, { response: 'answer' });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/no longer open/);
  });
});
