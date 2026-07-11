/**
 * Reference-validation tests for /api/journal (security audit 2026-07-08, L-5).
 *
 * WHY THIS TEST EXISTS:
 * sanitizeEntry used to accept any well-formed ObjectId for
 * pairings[].bottle / pairings[].wine / people[].user, and the populate on
 * create/read would then echo back a FOREIGN bottle's vintage + wine
 * name/producer, and a private user's username/displayName — re-opening the
 * private-profile enumeration oracle users.js GET /public/:userId closes.
 *
 * The fix (mirroring sanitizeEntry's silently-drop style):
 *  - write time: pairings[].bottle must resolve to a bottle the author owns
 *    or can access via a cellar role (getCellarRole); pairings[].wine must
 *    exist. Inaccessible/unknown refs are nulled, not 400s.
 *  - read time: populated people[].user with profileVisibility 'private'
 *    (and not the requester) is reduced to its bare _id; the
 *    profileVisibility field fetched for the gate is stripped everywhere.
 *
 * The real journal router is mounted with the real requireAuth middleware
 * (HS256 test tokens); models are mocked so no MongoDB is needed.
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
const Bottle = require('../models/Bottle');
const WineDefinition = require('../models/WineDefinition');
const journalRouter = require('./journal');

const AUTHOR_ID = '64b000000000000000000001';
const OTHER_ID = '64b000000000000000000002';
const OWN_BOTTLE = '64b0000000000000000000a1';
const FOREIGN_BOTTLE = '64b0000000000000000000a2';
const SHARED_BOTTLE = '64b0000000000000000000a3';
const KNOWN_WINE = '64b0000000000000000000c1';
const UNKNOWN_WINE = '64b0000000000000000000c2';
const PRIVATE_USER = '64b0000000000000000000d1';
const PUBLIC_USER = '64b0000000000000000000d2';

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

// --- chainable query-mock helpers -----------------------------------------

// Bottle.find(...).select(...).populate(...).lean()
const mockBottleFind = (docs) =>
  Bottle.find.mockReturnValue({
    select: jest.fn().mockReturnValue({
      populate: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(docs) }),
    }),
  });

// WineDefinition.find(...).select(...).lean()  — journal only uses this shape
// inside validatePairingRefs; wine-search adds .limit, unused here.
const mockWineFind = (docs) =>
  WineDefinition.find.mockReturnValue({
    select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(docs) }),
  });

// JournalEntry.findById(...).populate(...).lean()
const mockPopulatedEntry = (doc) =>
  JournalEntry.findById.mockReturnValue({
    populate: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(doc) }),
  });

// JournalEntry.find(...).sort().skip().limit().populate().lean()
const mockEntryList = (items) => {
  const chain = {
    sort: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    populate: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(items),
  };
  JournalEntry.find.mockReturnValue(chain);
  JournalEntry.countDocuments.mockResolvedValue(items.length);
};

beforeEach(() => jest.clearAllMocks());

describe('POST /api/journal pairing bottle ownership (L-5 write gate)', () => {
  test('a pairing referencing a FOREIGN bottle is silently dropped; own and shared-cellar bottles are kept', async () => {
    mockBottleFind([
      // author's own bottle
      { _id: OWN_BOTTLE, user: AUTHOR_ID, cellar: null },
      // someone else's bottle in a cellar the author has NO role in
      { _id: FOREIGN_BOTTLE, user: OTHER_ID, cellar: { user: OTHER_ID, members: [], deletedAt: null } },
      // someone else's bottle in a cellar shared with the author (viewer)
      {
        _id: SHARED_BOTTLE,
        user: OTHER_ID,
        cellar: { user: OTHER_ID, members: [{ user: AUTHOR_ID, role: 'viewer' }], deletedAt: null },
      },
    ]);
    mockWineFind([]);
    JournalEntry.create.mockResolvedValue({ _id: 'e1' });
    mockPopulatedEntry({ _id: 'e1', visibility: 'private', people: [], pairings: [] });

    const { status } = await makeReq(buildApp(), 'POST', '/api/journal', {
      headers: { authorization: `Bearer ${authorToken()}` },
      body: {
        date: '2026-07-01',
        pairings: [
          { dish: 'Steak', bottle: OWN_BOTTLE },
          { dish: 'Fish', bottle: FOREIGN_BOTTLE },
          { dish: 'Cheese', bottle: SHARED_BOTTLE },
        ],
      },
    });

    expect(status).toBe(201);
    const created = JournalEntry.create.mock.calls[0][0];
    expect(created.pairings[0].bottle).toBe(OWN_BOTTLE);   // own → kept
    expect(created.pairings[1].bottle).toBeNull();          // foreign → dropped
    expect(created.pairings[2].bottle).toBe(SHARED_BOTTLE); // shared cellar → kept
  });

  test('a pairing referencing a bottle id that does not exist is dropped', async () => {
    mockBottleFind([]); // lookup resolves nothing
    mockWineFind([]);
    JournalEntry.create.mockResolvedValue({ _id: 'e1' });
    mockPopulatedEntry({ _id: 'e1', visibility: 'private', people: [], pairings: [] });

    const { status } = await makeReq(buildApp(), 'POST', '/api/journal', {
      headers: { authorization: `Bearer ${authorToken()}` },
      body: { date: '2026-07-01', pairings: [{ dish: 'Steak', bottle: FOREIGN_BOTTLE }] },
    });

    expect(status).toBe(201);
    expect(JournalEntry.create.mock.calls[0][0].pairings[0].bottle).toBeNull();
  });

  test('pairings[].wine keeps existing registry wines and drops unknown ids', async () => {
    mockBottleFind([]);
    mockWineFind([{ _id: KNOWN_WINE }]);
    JournalEntry.create.mockResolvedValue({ _id: 'e1' });
    mockPopulatedEntry({ _id: 'e1', visibility: 'private', people: [], pairings: [] });

    const { status } = await makeReq(buildApp(), 'POST', '/api/journal', {
      headers: { authorization: `Bearer ${authorToken()}` },
      body: {
        date: '2026-07-01',
        pairings: [
          { dish: 'Steak', wine: KNOWN_WINE },
          { dish: 'Fish', wine: UNKNOWN_WINE },
        ],
      },
    });

    expect(status).toBe(201);
    const created = JournalEntry.create.mock.calls[0][0];
    expect(created.pairings[0].wine).toBe(KNOWN_WINE);
    expect(created.pairings[1].wine).toBeNull();
  });

  test('entries with no pairings never hit the Bottle/WineDefinition lookups', async () => {
    JournalEntry.create.mockResolvedValue({ _id: 'e1' });
    mockPopulatedEntry({ _id: 'e1', visibility: 'private', people: [], pairings: [] });

    const { status } = await makeReq(buildApp(), 'POST', '/api/journal', {
      headers: { authorization: `Bearer ${authorToken()}` },
      body: { date: '2026-07-01', title: 'Quiet night' },
    });

    expect(status).toBe(201);
    expect(Bottle.find).not.toHaveBeenCalled();
    expect(WineDefinition.find).not.toHaveBeenCalled();
  });
});

describe('GET /api/journal people populate privacy (L-5 read gate)', () => {
  test('a PRIVATE tagged user is reduced to a bare _id — no username/displayName', async () => {
    mockEntryList([
      {
        _id: 'e1',
        people: [
          {
            name: 'Anna',
            user: { _id: PRIVATE_USER, username: 'secretanna', displayName: 'Anna S', profileVisibility: 'private' },
          },
        ],
        pairings: [],
      },
    ]);

    const { status, body } = await makeReq(buildApp(), 'GET', '/api/journal', {
      headers: { authorization: `Bearer ${authorToken()}` },
    });

    expect(status).toBe(200);
    const person = body.items[0].people[0];
    expect(person.user).toEqual({ _id: PRIVATE_USER });
    expect(JSON.stringify(body)).not.toContain('secretanna');
    expect(JSON.stringify(body)).not.toContain('Anna S');
  });

  test('a PUBLIC tagged user keeps username/displayName, with the gate field stripped', async () => {
    mockEntryList([
      {
        _id: 'e1',
        people: [
          {
            name: 'Bob',
            user: { _id: PUBLIC_USER, username: 'bobwine', displayName: 'Bob W', profileVisibility: 'public' },
          },
        ],
        pairings: [],
      },
    ]);

    const { body } = await makeReq(buildApp(), 'GET', '/api/journal', {
      headers: { authorization: `Bearer ${authorToken()}` },
    });

    const person = body.items[0].people[0];
    expect(person.user.username).toBe('bobwine');
    expect(person.user.displayName).toBe('Bob W');
    expect(person.user.profileVisibility).toBeUndefined();
  });

  test('the requester always sees THEMSELVES, even with a private profile', async () => {
    mockEntryList([
      {
        _id: 'e1',
        people: [
          {
            name: 'Me',
            user: { _id: AUTHOR_ID, username: 'author', displayName: 'The Author', profileVisibility: 'private' },
          },
        ],
        pairings: [],
      },
    ]);

    const { body } = await makeReq(buildApp(), 'GET', '/api/journal', {
      headers: { authorization: `Bearer ${authorToken()}` },
    });

    expect(body.items[0].people[0].user.username).toBe('author');
  });

  test('unpopulated (deleted) people.user and plain-name people pass through untouched', async () => {
    mockEntryList([
      { _id: 'e1', people: [{ name: 'Ghost', user: null }, { name: 'Plain' }], pairings: [] },
    ]);

    const { status, body } = await makeReq(buildApp(), 'GET', '/api/journal', {
      headers: { authorization: `Bearer ${authorToken()}` },
    });

    expect(status).toBe(200);
    expect(body.items[0].people[0].user).toBeNull();
    expect(body.items[0].people[1].name).toBe('Plain');
  });
});

describe('POST /api/journal response redaction (old rows / create echo)', () => {
  test('the create response itself withholds a private tagged user (and still notifies by id)', async () => {
    const User = require('../models/User');
    const { createNotification } = require('../services/notifications');
    mockBottleFind([]);
    mockWineFind([]);
    JournalEntry.create.mockResolvedValue({ _id: 'e1' });
    mockPopulatedEntry({
      _id: 'e1',
      title: 'Tasting',
      visibility: 'public',
      people: [
        {
          name: 'Anna',
          user: { _id: PRIVATE_USER, username: 'secretanna', displayName: 'Anna S', profileVisibility: 'private' },
        },
      ],
      pairings: [],
    });
    User.findById.mockReturnValue({
      select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({ username: 'author' }) }),
    });

    const { status, body } = await makeReq(buildApp(), 'POST', '/api/journal', {
      headers: { authorization: `Bearer ${authorToken()}` },
      body: { date: '2026-07-01', visibility: 'public', people: [{ name: 'Anna', user: PRIVATE_USER }] },
    });

    expect(status).toBe(201);
    expect(body.entry.people[0].user).toEqual({ _id: PRIVATE_USER });
    expect(JSON.stringify(body)).not.toContain('secretanna');
    // the mention notification still reaches the tagged user (by id, no name leak).
    // Trailing args: category (undefined here) + actor (the mentioner) so GDPR
    // erasure can remove the notification on the mentioner's deletion.
    expect(createNotification).toHaveBeenCalledWith(
      PRIVATE_USER, 'journal_mention', 'Journal Mention', expect.any(String), expect.any(String), undefined, expect.any(String)
    );
  });
});
