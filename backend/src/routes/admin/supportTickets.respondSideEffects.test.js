/**
 * PUT /api/admin/support-tickets/:id/respond answers 200 once the reply is saved.
 *
 * WHY THIS TEST EXISTS:
 * The reply is stored by ticket.save(). The in-app bell and the populated
 * response are side effects that run after it. If one of them failed inside
 * the route's try, the admin saw a 500 for a reply that WAS stored, and the
 * natural retry appended the same answer a second time to replies[] (and was
 * the one that sent the email). A failed side effect is logged; the response
 * still says the reply went through. A failed save is still a 500.
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
let errorSpy;
beforeEach(() => {
  jest.clearAllMocks();
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  ticket = {
    _id: TICKET_ID, user: AUTHOR_ID, subject: 'Import from CellarTracker?', status: 'open', replies: [],
    save: jest.fn(async () => ticket),
    populate: jest.fn(async () => ticket),
  };
  SupportTicket.findById.mockResolvedValue(ticket);
  User.findById.mockReturnValue({
    select: () => ({ lean: async () => ({ email: 'james@example.com', emailVerified: true, username: 'james' }) }),
  });
});
afterEach(() => errorSpy.mockRestore());

const respond = (body) => fetch(`${baseUrl}/api/admin/support-tickets/${TICKET_ID}/respond`, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

test('a failed bell notification after the save still answers 200, emails once and audits', async () => {
  Notification.create.mockRejectedValueOnce(new Error('connection reset'));
  const res = await respond({ adminResponse: 'Yes, it can.', status: 'closed' });

  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.ticket._id).toBe(TICKET_ID);
  expect(body.emailed).toBe(true);
  expect(ticket.save).toHaveBeenCalledTimes(1);
  expect(ticket.replies).toHaveLength(1);
  expect(sendSupportReplyEmail).toHaveBeenCalledTimes(1);
  expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'support.ticket.responded',
    { type: 'SupportTicket', id: TICKET_ID }, { status: 'closed', emailed: true });
  expect(errorSpy).toHaveBeenCalled(); // the failure is logged, not swallowed
});

test('a failed populate after the save still answers 200 with the ticket', async () => {
  ticket.populate.mockRejectedValue(new Error('connection reset'));
  const res = await respond({ adminResponse: 'Answer', status: 'in_progress' });

  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.ticket._id).toBe(TICKET_ID);
  expect(ticket.save).toHaveBeenCalledTimes(1);
  expect(Notification.create).toHaveBeenCalledTimes(1);
  expect(logAudit).toHaveBeenCalled();
});

test('a failed save is still a 500, with no bell, email or audit row', async () => {
  ticket.save.mockRejectedValueOnce(new Error('write conflict'));
  const res = await respond({ adminResponse: 'Answer', status: 'closed' });

  expect(res.status).toBe(500);
  expect(Notification.create).not.toHaveBeenCalled();
  expect(sendSupportReplyEmail).not.toHaveBeenCalled();
  expect(logAudit).not.toHaveBeenCalled();
});
