/**
 * GET /api/admin/support-tickets — the admin queue's list and its filters.
 *
 * WHY THIS TEST EXISTS:
 * Beta feedback (category 'beta', sent from a feature's own "Give feedback"
 * button) has to be findable per feature, so the list takes a category and a
 * feature filter next to the status one. Each filter value is taken from a
 * fixed list, never from the query string itself, and a beta ticket carries
 * its feature's English title for the badge.
 */
jest.mock('../../middleware/auth', () => ({
  requireAuth: (req, _res, next) => { req.user = { id: 'b'.repeat(24), roles: ['admin'] }; next(); },
  requireRole: () => (_req, _res, next) => next(),
}));
jest.mock('../../models/SupportTicket', () => ({ find: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../../models/Notification', () => ({}));
jest.mock('../../models/User', () => ({}));
jest.mock('../../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../../services/mailgun', () => ({ sendSupportReplyEmail: jest.fn(), EMAIL_VERIFICATION_ENABLED: false }));

const express = require('express');
const http = require('http');
const SupportTicket = require('../../models/SupportTicket');
const router = require('./supportTickets');

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

let rows;
beforeEach(() => {
  jest.clearAllMocks();
  rows = [
    { _id: 't1', category: 'beta', feature: 'vintagePage', subject: 'Beta feedback: One page per wine and vintage', status: 'open' },
    { _id: 't2', category: 'beta', feature: 'retiredFeature', subject: 'Beta feedback', status: 'open' },
    { _id: 't3', category: 'bug', subject: 'Crash', status: 'open' },
  ];
  const chain = { sort: () => chain, skip: () => chain, limit: () => chain, populate: () => chain, lean: async () => rows };
  SupportTicket.find.mockReturnValue(chain);
  SupportTicket.countDocuments.mockResolvedValue(rows.length);
});

const list = async (query = '') => {
  const res = await fetch(`${baseUrl}/api/admin/support-tickets${query}`);
  return { status: res.status, body: await res.json() };
};

test('beta tickets carry their feature\'s title; a flag already gone from the code shows its key', async () => {
  const { status, body } = await list();
  expect(status).toBe(200);
  expect(body.tickets[0].featureTitle).toBe('One page per wine and vintage');
  expect(body.tickets[1].featureTitle).toBe('retiredFeature');
  expect(body.tickets[2].featureTitle).toBeUndefined();
  expect(SupportTicket.find).toHaveBeenCalledWith({});
});

test('status, category and feature filter the list; unknown values are ignored', async () => {
  await list('?status=open&category=beta&feature=vintagePage');
  expect(SupportTicket.find).toHaveBeenLastCalledWith({ status: 'open', category: 'beta', feature: 'vintagePage' });
  expect(SupportTicket.countDocuments).toHaveBeenLastCalledWith({ status: 'open', category: 'beta', feature: 'vintagePage' });

  await list('?category=complaint&feature[$ne]=x');
  expect(SupportTicket.find).toHaveBeenLastCalledWith({});
});
