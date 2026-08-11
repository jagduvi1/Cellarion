/**
 * Owner-inquiry MCP tools (ask_bottle_owner / list_owner_inquiries) — role
 * gating + the anonymisation line.
 *
 * Pins: structural invisibility without the somm/admin role AND the
 * in-handler re-check; ask delegating to the SHARED ownerInquiryOps create
 * (via 'mcp', so REST and MCP cannot drift) with the service→MCP error-code
 * mapping (no_owners → conflict); the list running the expiry sweep, reading
 * the shared page query, and exposing answers under "owner N" labels with NO
 * recipient identities — user ids and emails must never cross this surface.
 */

const chain = (result) => {
  const c = {};
  for (const m of ['populate', 'sort', 'skip', 'limit', 'select']) c[m] = jest.fn(() => c);
  c.lean = jest.fn(() => Promise.resolve(result));
  c.then = (res, rej) => Promise.resolve(result).then(res, rej);
  return c;
};

jest.mock('../models/Cellar', () => ({ find: jest.fn(), findById: jest.fn() }));
jest.mock('../models/Bottle', () => ({ find: jest.fn(), findById: jest.fn(), aggregate: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../models/Rack', () => ({ find: jest.fn(), findOne: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../models/WishlistItem', () => ({ find: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../models/JournalEntry', () => ({ find: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../models/WineDefinition', () => ({ find: jest.fn(), findById: jest.fn() }));
jest.mock('../models/Grape', () => ({ findOne: jest.fn() }));
jest.mock('../models/User', () => ({ findById: jest.fn() }));
jest.mock('../models/WineEmbedding', () => ({ findOne: jest.fn() }));
jest.mock('../models/McpActionLog', () => ({ create: jest.fn(), findOne: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock('../models/WineVintageProfile', () => ({ find: jest.fn(), findById: jest.fn(), findOne: jest.fn(), countDocuments: jest.fn(), deleteOne: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock('../models/WineVintagePrice', () => {
  const M = jest.fn(function (doc) { Object.assign(this, doc); this._id = 'price-1'; this.save = jest.fn().mockResolvedValue(undefined); });
  M.aggregate = jest.fn().mockResolvedValue([]);
  M.deleteOne = jest.fn();
  return M;
});
jest.mock('../models/PriceTrackingRequest', () => ({ find: jest.fn(), findOne: jest.fn(), findById: jest.fn(), deleteOne: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock('../models/PriceTrackingSkip', () => ({ find: jest.fn(), findOne: jest.fn(), findOneAndUpdate: jest.fn(), deleteOne: jest.fn() }));
jest.mock('../models/WineCorrectionProposal', () => ({ create: jest.fn(), findById: jest.fn(), deleteOne: jest.fn() }));
jest.mock('../models/WineOwnerInquiry', () => ({ populate: jest.fn(), aggregate: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../utils/rackGeometry', () => ({ getMaxPosition: jest.fn(() => 12) }));
jest.mock('../services/search', () => ({ getIsAvailable: jest.fn(() => false), search: jest.fn(), searchBottles: jest.fn(), indexWine: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/statsService', () => ({ computeOverview: jest.fn(), buildEmptyStats: jest.fn() }));
jest.mock('../services/vectorStore', () => ({ getPoints: jest.fn(), searchSimilar: jest.fn() }));
jest.mock('../config/aiConfig', () => ({ get: jest.fn(() => ({ vectorIndex: 'v1' })) }));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../services/embeddingJob', () => ({ reembedActiveVintages: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/notifications', () => ({ createNotification: jest.fn().mockResolvedValue(undefined), createNotifications: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../utils/exchangeRates', () => ({ getOrCreateDailySnapshot: jest.fn().mockResolvedValue({}) }));
jest.mock('../services/findOrCreateWine', () => ({ findOrCreateWine: jest.fn() }));
jest.mock('../services/bottleOps', () => ({
  consumeBottle: jest.fn(), restoreBottle: jest.fn(), removeFromRacks: jest.fn(),
  RESTORE_WINDOW_MS: 2 * 24 * 60 * 60 * 1000,
  addBottle: jest.fn(), updateBottleFields: jest.fn(), removeBottleCascade: jest.fn(),
  UPDATABLE_FIELDS: ['price', 'currency', 'notes', 'occasion', 'rating', 'ratingScale', 'drinkFrom', 'drinkTo'],
}));
jest.mock('./mutationBudget', () => ({ takeMutationSlot: jest.fn(() => true), WRITE_WINDOW_MS: 15 * 60 * 1000 }));
jest.mock('../services/ownerInquiryOps', () => ({
  QUESTION_MIN: 10,
  QUESTION_MAX: 500,
  createOwnerInquiry: jest.fn(),
  sweepExpiredInquiries: jest.fn().mockResolvedValue(0),
  queryInquiryPage: jest.fn(),
}));

const WineOwnerInquiry = require('../models/WineOwnerInquiry');
const { createOwnerInquiry, sweepExpiredInquiries, queryInquiryPage } = require('../services/ownerInquiryOps');
const { allTools, toolsForScopes } = require('./registry');
require('./tools');

const oid = (c) => c.repeat(24);
const ME = oid('a');
const SOMM_CTX = { user: { id: ME, roles: ['somm'] }, scopes: ['read', 'write'], req: { user: { id: ME, roles: ['somm'] }, headers: {} } };
const USER_CTX = { user: { id: ME, roles: ['user'] }, scopes: ['read', 'write'], req: { user: { id: ME, roles: ['user'] }, headers: {} } };

const tool = (name) => allTools().find((t) => t.name === name);
const parse = (res) => JSON.parse(res.content[0].text);
const QUESTION = 'What does the label say the producer is?';

beforeEach(() => {
  jest.clearAllMocks();
  sweepExpiredInquiries.mockResolvedValue(0);
  WineOwnerInquiry.populate.mockResolvedValue(undefined);
});

describe('role + scope gating', () => {
  test('both tools are INVISIBLE without the somm/admin role; ask needs write, list needs only read', () => {
    const plain = toolsForScopes(['read', 'write'], ['user']).map((t) => t.name);
    expect(plain).not.toContain('ask_bottle_owner');
    expect(plain).not.toContain('list_owner_inquiries');

    for (const role of ['somm', 'admin']) {
      const names = toolsForScopes(['read', 'write'], [role]).map((t) => t.name);
      expect(names).toContain('ask_bottle_owner');
      expect(names).toContain('list_owner_inquiries');
    }

    // A read-only somm token can read answers but never notify owners.
    const readSomm = toolsForScopes(['read'], ['somm']).map((t) => t.name);
    expect(readSomm).toContain('list_owner_inquiries');
    expect(readSomm).not.toContain('ask_bottle_owner');
  });

  test('defense-in-depth: handlers refuse a role-less ctx even if reached', async () => {
    for (const n of ['ask_bottle_owner', 'list_owner_inquiries']) {
      const res = await tool(n).handler({ wine_id: oid('f'), question: QUESTION }, USER_CTX);
      expect(parse(res).error.code).toBe('forbidden_scope');
    }
  });
});

describe('ask_bottle_owner', () => {
  test('delegates to the SHARED create with via mcp and the caller as asker; envelope carries the recipient count', async () => {
    createOwnerInquiry.mockResolvedValue({
      ok: true,
      inquiry: { _id: oid('e'), status: 'open', expiresAt: new Date('2026-10-10') },
      wine: { _id: oid('f'), name: 'Barolo', producer: 'Pira' },
      recipientCount: 4,
      fallbackUsed: false,
    });

    const res = await tool('ask_bottle_owner').handler({ wine_id: oid('f'), question: QUESTION }, SOMM_CTX);
    const body = parse(res);

    expect(createOwnerInquiry).toHaveBeenCalledWith(expect.objectContaining({
      wineId: oid('f'), userId: ME, via: 'mcp', question: QUESTION,
    }));
    expect(body.summary).toMatch(/4 bottle owner/);
    expect(body.summary).toMatch(/Pira — Barolo/);
    expect(body.data.recipients_notified).toBe(4);
    expect(body.data.status).toBe('open');
    expect(body.data.note).toMatch(/Not undoable/);
  });

  test('the consumed-owner fallback is SAID, not silent', async () => {
    createOwnerInquiry.mockResolvedValue({
      ok: true,
      inquiry: { _id: oid('e'), status: 'open', expiresAt: null },
      wine: { _id: oid('f'), name: 'Barolo', producer: 'Pira' },
      recipientCount: 2,
      fallbackUsed: true,
    });
    const body = parse(await tool('ask_bottle_owner').handler({ wine_id: oid('f'), question: QUESTION }, SOMM_CTX));
    expect(body.summary).toMatch(/consumed bottles/);
    expect(body.data.asked_consumed_owners).toBe(true);
  });

  test('service codes map to the MCP taxonomy — no_owners and duplicate-open are conflicts, missing wine not_found', async () => {
    const cases = [
      ['not_found', 'not_found'],
      ['conflict', 'conflict'],
      ['no_owners', 'conflict'],
      ['invalid_input', 'invalid_input'],
    ];
    for (const [serviceCode, mcpCode] of cases) {
      createOwnerInquiry.mockResolvedValueOnce({ ok: false, code: serviceCode, message: 'nope.' });
      const body = parse(await tool('ask_bottle_owner').handler({ wine_id: oid('f'), question: QUESTION }, SOMM_CTX));
      expect(body.error.code).toBe(mcpCode);
    }
  });
});

describe('list_owner_inquiries', () => {
  const ROW = {
    _id: oid('e'), status: 'answered', question: QUESTION, askedVia: 'mcp',
    wineDefinition: { _id: oid('f'), name: 'Barolo', producer: 'Pira', grapes: [] },
    recipients: [
      { user: oid('1'), bottle: oid('2'), notifiedAt: 'n1', response: 'Label says E. Pira e Figli', respondedAt: 'r1' },
      { user: oid('3'), bottle: oid('4'), notifiedAt: 'n1', response: null, respondedAt: null },
    ],
    resolutionNote: null, resolvedAt: null, expiresAt: 'x1', createdAt: 'c1',
  };

  test('sweeps expiry, defaults to the active filter, anonymises recipients as "owner N" with NO identities', async () => {
    queryInquiryPage.mockResolvedValue({ rows: [ROW], total: 1, pendingCount: 3, answeredCount: 1 });

    const res = await tool('list_owner_inquiries').handler({}, SOMM_CTX);
    const body = parse(res);

    expect(sweepExpiredInquiries).toHaveBeenCalledTimes(1);
    expect(queryInquiryPage.mock.calls[0][0]).toEqual({ status: { $in: ['open', 'answered'] } });

    expect(body.summary).toMatch(/1 inquiry\(ies\) with answers waiting/);
    const row = body.data[0];
    expect(row.recipients).toEqual([
      { label: 'owner 1', notified_at: 'n1', responded: true, response: 'Label says E. Pira e Figli', responded_at: 'r1' },
      { label: 'owner 2', notified_at: 'n1', responded: false, response: null, responded_at: null },
    ]);
    expect(row.response_count).toBe(1);
    expect(row.recipient_count).toBe(2);

    // The anonymisation line: recipient user ids (and any email shape) must
    // never appear anywhere in the payload.
    const raw = res.content[0].text;
    expect(raw).not.toContain(oid('1'));
    expect(raw).not.toContain(oid('3'));
    expect(raw).not.toMatch(/@/);
  });

  test('status and wine_id narrow the filter from static literals', async () => {
    queryInquiryPage.mockResolvedValue({ rows: [], total: 0, pendingCount: 0, answeredCount: 0 });

    await tool('list_owner_inquiries').handler({ status: 'decided', wine_id: oid('f') }, SOMM_CTX);
    expect(queryInquiryPage.mock.calls[0][0]).toEqual({
      status: { $in: ['resolved', 'closed'] },
      wineDefinition: oid('f'),
    });

    await tool('list_owner_inquiries').handler({ status: 'answered' }, SOMM_CTX);
    expect(queryInquiryPage.mock.calls[1][0]).toEqual({ status: 'answered' });
  });
});
