/**
 * list_curator_questions / answer_curator_question — the OWNER side of owner
 * inquiries over MCP (2026-09-24).
 *
 * Pins: both tools are plain user tools (no somm gate; list read-scoped,
 * answer write-scoped and budgeted like every write); the list runs the SAME
 * recipient projection the web card uses (only the caller's entry — no other
 * recipient's id or answer ever crosses this surface) with unanswered rows
 * first; the answer delegates to the shared claim (via 'mcp'), maps a
 * non-recipient exactly like a missing inquiry (never confirms what others
 * were asked), refuses a second answer as conflict, writes a ledger row that
 * undo_last can never select, and keeps the answer text out of the ledger.
 */

jest.mock('../models/WineOwnerInquiry', () => ({
  find: jest.fn(),
  findById: jest.fn(),
  findOne: jest.fn(),
  findOneAndUpdate: jest.fn(),
}));
jest.mock('../models/User', () => ({ findById: jest.fn() }));
jest.mock('../services/notifications', () => ({
  createNotification: jest.fn().mockResolvedValue(undefined),
  createNotifications: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../models/McpActionLog', () => ({ create: jest.fn(), findOne: jest.fn(), findOneAndUpdate: jest.fn() }));
// revert.js and tools/write.js top-require bottleOps (search/meili chain) —
// same load-time mock as every other MCP tool suite.
jest.mock('../services/bottleOps', () => ({
  consumeBottle: jest.fn(), restoreBottle: jest.fn(), removeFromRacks: jest.fn(),
  RESTORE_WINDOW_MS: 2 * 24 * 60 * 60 * 1000,
  addBottle: jest.fn(), updateBottleFields: jest.fn(), removeBottleCascade: jest.fn(),
  UPDATABLE_FIELDS: ['price', 'currency', 'notes', 'occasion', 'rating', 'ratingScale', 'drinkFrom', 'drinkTo'],
}));

const WineOwnerInquiry = require('../models/WineOwnerInquiry');
const User = require('../models/User');
const McpActionLog = require('../models/McpActionLog');
const { logAudit } = require('../services/audit');
const { allTools, toolsForScopes } = require('./registry');
const { reversibleActionsFor } = require('./revert');
require('./tools');

const oid = (c) => c.repeat(24);
const ME = oid('a');
const OTHER = oid('b');
const ASKER = oid('c');
const WINE = oid('d');
const I1 = oid('e');
const CTX = { user: { id: ME, roles: ['user'] }, scopes: ['read', 'write'], req: { user: { id: ME }, headers: {} } };

const tool = (name) => allTools().find((t) => t.name === name);
const parse = (res) => JSON.parse(res.content[0].text);
const findChain = (rows) => {
  const c = {};
  for (const m of ['sort', 'limit', 'populate']) c[m] = jest.fn(() => c);
  c.lean = jest.fn(() => Promise.resolve(rows));
  return c;
};
const QUESTION = 'What does the back label say the producer is?';
const wine = { _id: WINE, name: 'Barolo', producer: 'Pira' };
const row = (over = {}) => ({
  _id: I1, status: 'open', question: QUESTION, wineDefinition: wine,
  recipients: [
    { user: ME, bottle: oid('5'), response: null, respondedAt: null },
    { user: OTHER, bottle: oid('6'), response: 'Secret answer from another owner', respondedAt: new Date('2026-08-02') },
  ],
  createdAt: new Date('2026-08-01'), expiresAt: new Date('2026-10-01'),
  ...over,
});

beforeEach(() => jest.clearAllMocks());

describe('registration', () => {
  test('plain user tools: list is read scope, answer is a budgeted write with no somm gate', () => {
    expect(tool('list_curator_questions').scope).toBe('read');
    expect(tool('list_curator_questions').requireRole).toBeUndefined();
    expect(tool('answer_curator_question').scope).toBe('write');
    expect(tool('answer_curator_question').requireRole).toBeUndefined();
    expect(tool('answer_curator_question').selfBudgeted).toBeFalsy();
    expect(tool('answer_curator_question').annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false });
    const readNames = toolsForScopes(['read'], ['user']).map((t) => t.name);
    expect(readNames).toContain('list_curator_questions');
    expect(readNames).not.toContain('answer_curator_question');
    expect(toolsForScopes(['read', 'write'], ['user']).map((t) => t.name)).toContain('answer_curator_question');
  });

  test('an answer is never undo-eligible — undo_last cannot select the ledger action', () => {
    expect(reversibleActionsFor(['read', 'write', 'consume'])).not.toContain('inquiry_answer');
  });
});

describe('list_curator_questions', () => {
  test('caller-scoped recipient view: own entry only, unanswered first, other owners invisible', async () => {
    const answered = row({
      _id: oid('f'), status: 'resolved',
      recipients: [{ user: ME, bottle: oid('7'), response: 'Says E. Pira e Figli', respondedAt: new Date('2026-08-02') }],
      ownerReply: 'Thanks — recorded.', resolutionNote: 'Curator-only note', resolvedAt: new Date('2026-08-10'),
      createdAt: new Date('2026-08-05'),
    });
    // The service returns newest first; the tool puts the unanswered one first regardless.
    WineOwnerInquiry.find.mockReturnValue(findChain([answered, row()]));

    const body = parse(await tool('list_curator_questions').handler({}, CTX));

    expect(body.error).toBeUndefined();
    expect(body.summary).toMatch(/1 question\(s\) waiting for an answer, 1 answered \(1 with a curator reply\)/);
    expect(body.data.map((r) => r.answered)).toEqual([false, true]);
    expect(body.data[0]).toMatchObject({ inquiry_id: I1, question: QUESTION, wine: { wine_id: WINE, name: 'Barolo', producer: 'Pira' } });
    expect(String(body.data[0].bottle_id)).toBe(oid('5'));
    expect(body.data[1]).toMatchObject({ answered: true, my_answer: 'Says E. Pira e Figli', curator_reply: 'Thanks — recorded.' });
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('recipients');
    expect(raw).not.toContain(OTHER);
    expect(raw).not.toContain('Secret answer from another owner');
    expect(raw).not.toContain('Curator-only note');
    expect(WineOwnerInquiry.find.mock.calls[0][0]['recipients.user']).toBe(ME);
    // The one-shot warning rides only while something is waiting.
    expect(body.warnings[0]).toMatch(/answered ONCE/);
  });

  test('wine_id scopes the query; nothing waiting means no warning', async () => {
    WineOwnerInquiry.find.mockReturnValue(findChain([]));
    const body = parse(await tool('list_curator_questions').handler({ wine_id: WINE }, CTX));
    expect(WineOwnerInquiry.find.mock.calls[0][0].wineDefinition).toBe(WINE);
    expect(body.data).toEqual([]);
    expect(body.summary).toMatch(/No curator questions/);
    expect(body.warnings).toBeUndefined();
  });
});

describe('answer_curator_question', () => {
  const claimed = () => {
    const doc = { _id: I1, status: 'answered', askedBy: ASKER, wineDefinition: wine };
    WineOwnerInquiry.findOneAndUpdate.mockReturnValue({ populate: jest.fn().mockResolvedValue(doc) });
    User.findById.mockReturnValue({ select: () => ({ lean: async () => ({ _id: ASKER, roles: ['somm'] }) }) });
    return doc;
  };
  const failClaim = () => WineOwnerInquiry.findOneAndUpdate.mockReturnValue({ populate: jest.fn().mockResolvedValue(null) });
  const diagnose = (doc) => WineOwnerInquiry.findById.mockReturnValue({ select: () => ({ lean: async () => doc }) });

  test('delegates to the shared claim as the caller via mcp, and the ledger row carries lengths, never the text', async () => {
    claimed();
    const answer = 'Back label: "Mis en bouteille par E. Pira e Figli".';

    const body = parse(await tool('answer_curator_question').handler({ inquiry_id: I1, answer }, CTX));

    expect(body.error).toBeUndefined();
    expect(body.summary).toBe('Answer sent to the curator about Pira — Barolo');
    expect(body.data).toMatchObject({ inquiry_id: I1, wine_id: WINE, status: 'answered' });
    expect(body.data.note).toMatch(/cannot be changed/);
    const [filter, update] = WineOwnerInquiry.findOneAndUpdate.mock.calls[0];
    expect(filter._id).toBe(I1);
    expect(filter.recipients.$elemMatch).toEqual({ user: ME, response: null });
    expect(update.$set['recipients.$.response']).toBe(answer);
    const audit = logAudit.mock.calls.find((c) => c[1] === 'user.ownerInquiry.respond');
    expect(audit[3]).toMatchObject({ via: 'mcp', responseLength: answer.length });
    const ledger = McpActionLog.create.mock.calls[0][0];
    expect(ledger).toMatchObject({ user: ME, tool: 'answer_curator_question', action: 'inquiry_answer' });
    expect(ledger.detail).toEqual({ inquiryId: I1, wineId: WINE, answerLength: answer.length });
    expect(JSON.stringify(ledger.detail)).not.toContain('Pira e Figli');
  });

  test('a question addressed to someone else reads exactly like a missing one', async () => {
    failClaim();
    diagnose({ status: 'open', expiresAt: new Date(Date.now() + 1000), recipients: [{ user: OTHER, response: null }] });
    let body = parse(await tool('answer_curator_question').handler({ inquiry_id: I1, answer: 'x' }, CTX));
    expect(body.error.code).toBe('not_found');
    const forbiddenMsg = body.error.message;

    diagnose(null);
    body = parse(await tool('answer_curator_question').handler({ inquiry_id: I1, answer: 'x' }, CTX));
    expect(body.error.code).toBe('not_found');
    expect(body.error.message).toBe(forbiddenMsg);
    expect(McpActionLog.create).not.toHaveBeenCalled();
  });

  test('a second answer, or a closed question, is a conflict with nothing to resend', async () => {
    failClaim();
    diagnose({ status: 'answered', recipients: [{ user: ME, response: 'already said so' }] });
    let body = parse(await tool('answer_curator_question').handler({ inquiry_id: I1, answer: 'again' }, CTX));
    expect(body.error.code).toBe('conflict');
    expect(body.error.message).toMatch(/already answered.*Nothing to resend/);

    diagnose({ status: 'resolved', recipients: [{ user: ME, response: null }] });
    body = parse(await tool('answer_curator_question').handler({ inquiry_id: I1, answer: 'late' }, CTX));
    expect(body.error.code).toBe('conflict');
    expect(body.error.message).toMatch(/no longer open/);
  });

  test('an answer that is only HTML strips to nothing and is refused before any write', async () => {
    const body = parse(await tool('answer_curator_question').handler({ inquiry_id: I1, answer: '<b></b>' }, CTX));
    expect(body.error.code).toBe('invalid_input');
    expect(WineOwnerInquiry.findOneAndUpdate).not.toHaveBeenCalled();
  });
});
