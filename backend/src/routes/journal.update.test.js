/**
 * PUT /api/journal/:id: editing an entry.
 *
 * Creating an entry refuses a date that is not one. Editing took whatever was
 * sent: a date that cannot be read reached the save and came back as a failed
 * request (500). An edit now goes through services/journalOps.updateEntry,
 * beside create and delete, with create's date check and the audit row.
 *
 * Harness from journal.refs.test.js: the real router and auth, models mocked.
 */


process.env.JWT_SECRET = 'test-secret';

jest.mock('../models/JournalEntry', () => ({
  find: jest.fn(),
  countDocuments: jest.fn(),
  create: jest.fn(),
  findById: jest.fn(),
  findOne: jest.fn(),
  findOneAndDelete: jest.fn(),
}));
jest.mock('../models/Bottle', () => ({ find: jest.fn() }));
jest.mock('../models/User', () => ({ findById: jest.fn() }));
jest.mock('../models/WineDefinition', () => ({ find: jest.fn() }));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../services/notifications', () => ({ createNotification: jest.fn() }));

const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const JournalEntry = require('../models/JournalEntry');
const { logAudit } = require('../services/audit');
const journalRouter = require('./journal');

const AUTHOR_ID = '64b000000000000000000001';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/journal', journalRouter);
  return app;
}

function makeReq(app, method, url, { headers = {}, body } = {}) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const port = server.address().port;
      const payload = body ? JSON.stringify(body) : null;
      const req = http.request(
        {
          port,
          path: url,
          method,
          headers: {
            ...headers,
            ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
          },
        },
        (res) => {
          const chunks = [];
          res.on('data', c => chunks.push(c));
          res.on('end', () => {
            server.close();
            const text = Buffer.concat(chunks).toString();
            resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null });
          });
        }
      );
      req.on('error', () => { server.close(); resolve({ status: 0 }); });
      if (payload) req.write(payload);
      req.end();
    });
  });
}

const authorToken = () =>
  jwt.sign({ id: AUTHOR_ID, roles: ['user'] }, 'test-secret', { algorithm: 'HS256', expiresIn: '1h' });

const ENTRY_ID = '64b0000000000000000000e1';
const put = (body, id = ENTRY_ID) => makeReq(buildApp(), 'PUT', `/api/journal/${id}`, { headers: { authorization: `Bearer ${authorToken()}` }, body });

let stored;
beforeEach(() => {
  jest.clearAllMocks();
  stored = {
    _id: ENTRY_ID, user: AUTHOR_ID, title: 'Sunday lunch', date: new Date('2026-10-04T00:00:00.000Z'), notes: 'Lamb',
    save: jest.fn(async function save() { return this; }),
  };
  JournalEntry.findOne.mockResolvedValue(stored);
  JournalEntry.findById.mockReturnValue({ populate: jest.fn().mockReturnValue({ lean: jest.fn(async () => ({ _id: ENTRY_ID, title: stored.title, date: stored.date, people: [], pairings: [] })) }) });
});

test('a date that cannot be read is a 400, and nothing is saved or audited', async () => {
  const res = await put({ title: 'Sunday lunch, again', date: 'the fourth of October' });
  expect(res.status).toBe(400);
  expect(res.body.error).toBe('Valid date is required');
  expect(stored.save).not.toHaveBeenCalled();
  expect(stored.title).toBe('Sunday lunch');
  expect(logAudit).not.toHaveBeenCalled();
});

test('an edit without a date keeps the stored date', async () => {
  const res = await put({ title: 'Sunday lunch, again' });
  expect(res.status).toBe(200);
  expect(stored.title).toBe('Sunday lunch, again');
  expect(stored.date).toEqual(new Date('2026-10-04T00:00:00.000Z'));
  expect(stored.save).toHaveBeenCalledTimes(1);
});

test('a real date is stored', async () => {
  const res = await put({ date: '2026-11-01' });
  expect(res.status).toBe(200);
  expect(stored.date).toEqual(new Date('2026-11-01'));
});

test('an edit is audited once, as journal.update on that entry', async () => {
  await put({ notes: 'Lamb and Rioja' });
  expect(logAudit).toHaveBeenCalledTimes(1);
  expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'journal.update', { type: 'journal', id: ENTRY_ID }, undefined);
});

test('an entry of another member, or one that is not there, is a 404', async () => {
  JournalEntry.findOne.mockResolvedValue(null);
  const res = await put({ title: 'x' });
  expect(res.status).toBe(404);
  expect(res.body.error).toBe('Entry not found');
  expect(JournalEntry.findOne).toHaveBeenCalledWith({ _id: ENTRY_ID, user: AUTHOR_ID });
});

test('an id that cannot be one is a 400 before anything is read', async () => {
  const res = await put({ title: 'x' }, 'not-an-id');
  expect(res.status).toBe(400);
  expect(res.body.error).toBe('Invalid ID');
  expect(JournalEntry.findOne).not.toHaveBeenCalled();
});
