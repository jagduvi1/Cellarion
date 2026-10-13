/**
 * POST /api/support/:id/close — the user marks their own ticket resolved.
 *
 * The rules (own ticket only, malformed id, already closed) live in
 * services/accountOps.closeTicket and are covered there; this pins the route
 * wiring: the caller's id goes to the service, its errors become statuses,
 * and only a real close writes an audit row (a repeat close is a no-op).
 */
jest.mock('../middleware/auth', () => ({
  requireAuth: (req, _res, next) => { req.user = { id: 'b'.repeat(24) }; next(); },
  requireNonDemo: (_req, _res, next) => next(),
}));
jest.mock('../models/SupportTicket', () => ({ find: jest.fn() }));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../services/accountOps', () => ({
  createSupportTicket: jest.fn(),
  replyToTicket: jest.fn(),
  closeTicket: jest.fn(),
}));

const express = require('express');
const http = require('http');
const rateLimit = require('express-rate-limit');
const { logAudit } = require('../services/audit');
const { closeTicket } = require('../services/accountOps');
const router = require('./support');

const ME = 'b'.repeat(24);
const TICKET_ID = 'a'.repeat(24);

let server;
let baseUrl;
beforeAll((done) => {
  const app = express();
  // Like the real app (app.js mounts API rate limiters ahead of every router).
  app.use(rateLimit({ windowMs: 60 * 1000, max: 10000, standardHeaders: false, legacyHeaders: false }));
  app.use(express.json());
  app.use('/api/support', router);
  server = http.createServer(app);
  server.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => {
  server.closeAllConnections();
  server.close(done);
});

beforeEach(() => jest.clearAllMocks());

const close = (id = TICKET_ID) => fetch(`${baseUrl}/api/support/${id}/close`, { method: 'POST' });

test('closes the caller\'s ticket, returns it and audits the close', async () => {
  closeTicket.mockResolvedValue({ ticket: { _id: TICKET_ID, status: 'closed' }, alreadyClosed: false });
  const res = await close();
  expect(res.status).toBe(200);
  expect((await res.json()).ticket.status).toBe('closed');
  expect(closeTicket).toHaveBeenCalledWith(ME, TICKET_ID);
  expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'support.ticket.closed_by_user', { type: 'SupportTicket', id: TICKET_ID }, {});
});

test('closing an already closed ticket answers 200 without a second audit row', async () => {
  closeTicket.mockResolvedValue({ ticket: { _id: TICKET_ID, status: 'closed' }, alreadyClosed: true });
  const res = await close();
  expect(res.status).toBe(200);
  expect(logAudit).not.toHaveBeenCalled();
});

test('a missing or foreign ticket is a 404 and nothing is audited', async () => {
  closeTicket.mockResolvedValue({ error: { status: 404, message: 'Ticket not found' } });
  const res = await close();
  expect(res.status).toBe(404);
  expect((await res.json()).error).toBe('Ticket not found');
  expect(logAudit).not.toHaveBeenCalled();
});

test('a service failure is a 500', async () => {
  const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
  closeTicket.mockRejectedValue(new Error('db down'));
  const res = await close();
  expect(res.status).toBe(500);
  spy.mockRestore();
});
