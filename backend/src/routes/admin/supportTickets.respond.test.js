/**
 * PUT /api/admin/support-tickets/:id/respond also emails the answer.
 *
 * WHY THIS TEST EXISTS:
 * An answer used to reach only the in-app bell, so someone who asked and left
 * never saw it. Now it is emailed too: only to a verified address, not when
 * the user turned support-reply emails off (a missing setting means on), and
 * never at the cost of the reply itself: a mail failure still answers the
 * ticket and notifies in the app. The audit row records whether it went out.
 */
jest.mock('../../middleware/auth', () => ({
  requireAuth: (req, _res, next) => { req.user = { id: 'b'.repeat(24), roles: ['admin'] }; next(); },
  requireRole: () => (_req, _res, next) => next(),
}));
jest.mock('../../models/SupportTicket', () => ({ findById: jest.fn(), find: jest.fn(), countDocuments: jest.fn(), findByIdAndUpdate: jest.fn() }));
jest.mock('../../models/Notification', () => ({ create: jest.fn(async () => ({})) }));
jest.mock('../../models/User', () => ({ findById: jest.fn() }));
jest.mock('../../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../../services/mailgun', () => ({ sendSupportReplyEmail: jest.fn(async () => {}), EMAIL_VERIFICATION_ENABLED: true }));

const express = require('express');
const http = require('http');
const rateLimit = require('express-rate-limit');
const SupportTicket = require('../../models/SupportTicket');
const Notification = require('../../models/Notification');
const User = require('../../models/User');
const { logAudit } = require('../../services/audit');
const { sendSupportReplyEmail } = require('../../services/mailgun');
const router = require('./supportTickets');

const TICKET_ID = 'a'.repeat(24);
const AUTHOR_ID = 'c'.repeat(24);

let server;
let baseUrl;
beforeAll((done) => {
  const app = express();
  // Like the real app (app.js mounts API rate limiters ahead of every router);
  // generous enough never to trip in these tests.
  app.use(rateLimit({ windowMs: 60 * 1000, max: 10000, standardHeaders: false, legacyHeaders: false }));
  app.use(express.json());
  app.use('/api/admin/support-tickets', router);
  server = http.createServer(app);
  server.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => {
  server.closeAllConnections();
  server.close(done);
});

let ticket;
const author = (over = {}) => ({ email: 'james@example.com', emailVerified: true, username: 'james', ...over });
const withAuthor = (doc) => User.findById.mockReturnValue({ select: () => ({ lean: async () => doc }) });

beforeEach(() => {
  jest.clearAllMocks();
  ticket = {
    _id: TICKET_ID, user: AUTHOR_ID, subject: 'Import from CellarTracker?', status: 'open', replies: [],
    save: jest.fn(async () => ticket),
    populate: jest.fn(async () => ticket),
  };
  SupportTicket.findById.mockResolvedValue(ticket);
  withAuthor(author());
});

const respond = (body) => fetch(`${baseUrl}/api/admin/support-tickets/${TICKET_ID}/respond`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

test('the answer is emailed to a verified address, and the audit row records it', async () => {
  const res = await respond({ adminResponse: 'Yes, it can.\nCreate a cellar first.', status: 'closed' });

  expect(res.status).toBe(200);
  expect((await res.json()).emailed).toBe(true);
  expect(sendSupportReplyEmail).toHaveBeenCalledWith(
    'james@example.com', 'james', AUTHOR_ID, 'Import from CellarTracker?', 'Yes, it can.\nCreate a cellar first.',
  );
  expect(Notification.create).toHaveBeenCalled();
  expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'support.ticket.responded',
    { type: 'SupportTicket', id: TICKET_ID }, { status: 'closed', emailed: true });
});

test('the display name greets, when there is one', async () => {
  withAuthor(author({ displayName: 'James C' }));
  await respond({ adminResponse: 'Answer', status: 'closed' });
  expect(sendSupportReplyEmail.mock.calls[0][1]).toBe('James C');
});

test('not emailed when the user turned support-reply emails off', async () => {
  withAuthor(author({ preferences: { notifications: { supportReply: { email: false } } } }));
  const res = await respond({ adminResponse: 'Answer', status: 'closed' });

  expect((await res.json()).emailed).toBe(false);
  expect(sendSupportReplyEmail).not.toHaveBeenCalled();
  expect(Notification.create).toHaveBeenCalled(); // the bell still gets it
});

test('not emailed to an address that was never verified', async () => {
  withAuthor(author({ emailVerified: false }));
  const res = await respond({ adminResponse: 'Answer', status: 'closed' });

  expect((await res.json()).emailed).toBe(false);
  expect(sendSupportReplyEmail).not.toHaveBeenCalled();
});

test('a mail failure never fails the reply', async () => {
  const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
  sendSupportReplyEmail.mockRejectedValueOnce(new Error('mailgun down'));
  const res = await respond({ adminResponse: 'Answer', status: 'closed' });

  expect(res.status).toBe(200);
  expect((await res.json()).emailed).toBe(false);
  expect(ticket.save).toHaveBeenCalled();
  expect(Notification.create).toHaveBeenCalled();
  expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'support.ticket.responded',
    { type: 'SupportTicket', id: TICKET_ID }, { status: 'closed', emailed: false });
  spy.mockRestore();
});
