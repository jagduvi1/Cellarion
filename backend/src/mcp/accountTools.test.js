/**
 * MCP Phase-7 self-service tools — get/update_preferences, get/update_profile,
 * create_support_ticket, request_wine_addition.
 *
 * Pins the tool-layer contract: scope + role visibility, snake_case→camelCase
 * param mapping onto the shared accountOps service, the PII-safe response
 * views, error-code mapping, and that the two update tools are ledger-less but
 * still write-scoped (so they ride the mutation budget). The validation itself
 * is exhaustively covered by services/accountOps.test.js — here accountOps is
 * mocked so we test the wiring, not re-test the rules.
 */

jest.mock('../models/Cellar', () => ({ find: jest.fn(), findById: jest.fn(), findOne: jest.fn() }));
jest.mock('../models/Bottle', () => ({
  find: jest.fn(), findById: jest.fn(), aggregate: jest.fn(), countDocuments: jest.fn(), distinct: jest.fn(),
}));
jest.mock('../models/Rack', () => ({ find: jest.fn(), findOne: jest.fn() }));
jest.mock('../models/User', () => ({ findById: jest.fn() }));
jest.mock('../models/WishlistItem', () => ({ find: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../models/JournalEntry', () => ({ find: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../models/WineDefinition', () => ({ find: jest.fn(), findById: jest.fn() }));
jest.mock('../models/WineEmbedding', () => ({ findOne: jest.fn() }));
jest.mock('../models/McpActionLog', () => ({ create: jest.fn(), findOne: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock('../models/Notification', () => ({
  find: jest.fn(), countDocuments: jest.fn(), updateOne: jest.fn(), updateMany: jest.fn(),
}));
jest.mock('../models/ClimateDevice', () => ({ find: jest.fn() }));
jest.mock('../models/SupportTicket', () => ({ find: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../services/climateAlerts', () => ({ effectiveClimateConfig: jest.fn() }));
jest.mock('../services/search', () => ({ getIsAvailable: jest.fn(() => false), search: jest.fn(), searchBottles: jest.fn() }));
jest.mock('../services/statsService', () => ({ computeOverview: jest.fn(), buildEmptyStats: jest.fn() }));
jest.mock('../services/bottleOps', () => ({
  consumeBottle: jest.fn(), restoreBottle: jest.fn(), addBottle: jest.fn(), updateBottleFields: jest.fn(),
  removeBottleCascade: jest.fn(), RESTORE_WINDOW_MS: 2 * 24 * 60 * 60 * 1000,
  UPDATABLE_FIELDS: ['price', 'currency', 'notes', 'occasion', 'rating', 'ratingScale', 'drinkFrom', 'drinkTo'],
}));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../services/accountOps', () => ({
  updatePreferences: jest.fn(),
  updateProfile: jest.fn(),
  createSupportTicket: jest.fn(),
  replyToTicket: jest.fn(),
  createWineRequest: jest.fn(),
  // The tool descriptions read these allow-lists at module load — keep them real-ish.
  ALLOWED_CURRENCIES: ['USD', 'EUR', 'SEK'],
  LANGUAGE_TAG: /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/,
  ALLOWED_RATING_SCALES: ['5', '20', '100'],
  ALLOWED_RACK_NAV: ['auto', 'room', 'rack'],
  ALLOWED_RESTOCK_SCOPE: ['all', 'cellar'],
  ALLOWED_VISIBILITY: ['public', 'private'],
  SUPPORT_CATEGORIES: ['bug', 'help', 'feature', 'other'],
  TICKET_REPLY_CAP: 30,
}));

const User = require('../models/User');
const { logAudit } = require('../services/audit');
const accountOps = require('../services/accountOps');
const { allTools, toolsForScopes } = require('./registry');
require('./tools');

const oid = (c) => c.repeat(24);
const ME = oid('a');
const REQ = { headers: {}, user: { id: ME } };
const CTX = { user: { id: ME }, scopes: ['read', 'write'], req: REQ };
const tool = (name) => allTools().find((t) => t.name === name);
const parse = (res) => JSON.parse(res.content[0].text);

beforeEach(() => jest.clearAllMocks());

describe('registration + scope visibility', () => {
  test('the six self-service tools exist with the right scopes and annotations', () => {
    expect(tool('get_preferences').scope).toBe('read');
    expect(tool('get_profile').scope).toBe('read');
    for (const n of ['update_preferences', 'update_profile', 'create_support_ticket', 'request_wine_addition']) {
      expect(tool(n).scope).toBe('write');
      // write-scoped so budgetedHandler charges the mutation budget
      expect(tool(n).annotations.readOnlyHint).toBe(false);
    }
    // the two settings updates are idempotent/cosmetic; the two creates are not
    expect(tool('update_preferences').annotations.idempotentHint).toBe(true);
    expect(tool('update_profile').annotations.idempotentHint).toBe(true);
    expect(tool('create_support_ticket').annotations.idempotentHint).toBe(false);
  });

  test('a read-only token sees the gets but NOT the writes', () => {
    const names = toolsForScopes(['read']).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['get_preferences', 'get_profile']));
    expect(names).not.toContain('update_preferences');
    expect(names).not.toContain('create_support_ticket');
  });
});

describe('get_preferences / get_profile', () => {
  test('get_preferences returns a PII-safe view with resolved defaults', async () => {
    User.findById.mockReturnValue({ lean: () => Promise.resolve({
      preferences: { currency: 'SEK', ratingScale: '100', notifications: { drinkWindow: { enabled: false } } },
    }) });
    const body = parse(await tool('get_preferences').handler({}, CTX));
    expect(body.data.currency).toBe('SEK');
    expect(body.data.rating_scale).toBe('100');
    expect(body.data.language).toBe('en'); // default filled
    expect(body.data.notifications.drink_window.enabled).toBe(false);
    expect(body.data.notifications.community_reply.push).toBe(true); // default
  });

  test('get_profile omits email and other PII', async () => {
    User.findById.mockReturnValue({ lean: () => Promise.resolve({
      username: 'jo', email: 'jo@example.com', displayName: 'Jo', bio: 'Barolo', followersCount: 3,
    }) });
    const body = parse(await tool('get_profile').handler({}, CTX));
    expect(body.data).toEqual({
      username: 'jo', display_name: 'Jo', bio: 'Barolo', profile_visibility: 'public', followers: 3, following: 0,
      supporter: false, // boolean courtesy flag only — tier/billing never leave (supporterAwareness.test.js)
    });
    expect(JSON.stringify(body)).not.toContain('jo@example.com');
  });

  test('get_preferences 404s when the account is gone', async () => {
    User.findById.mockReturnValue({ lean: () => Promise.resolve(null) });
    const res = await tool('get_preferences').handler({}, CTX);
    expect(res.isError).toBe(true);
    expect(parse(res).error.code).toBe('not_found');
  });
});

describe('update_preferences', () => {
  test('maps snake_case params to the camelCase accountOps body and echoes the result', async () => {
    accountOps.updatePreferences.mockResolvedValue({ user: { preferences: { currency: 'EUR' } }, changed: ['preferences.currency'] });
    const body = parse(await tool('update_preferences').handler(
      { currency: 'EUR', rating_scale: '100', default_cellar_id: null, notifications: { drinkWindow: { push: true } } }, CTX));
    expect(accountOps.updatePreferences).toHaveBeenCalledWith(ME, {
      currency: 'EUR', ratingScale: '100', defaultCellarId: null, notifications: { drinkWindow: { push: true } },
    });
    expect(body.data.currency).toBe('EUR');
  });

  test('a validation error maps to invalid_input; a 404 maps to not_found', async () => {
    accountOps.updatePreferences.mockResolvedValue({ error: { status: 400, message: 'Invalid currency' } });
    expect(parse(await tool('update_preferences').handler({ currency: 'ZZZ' }, CTX)).error.code).toBe('invalid_input');
    accountOps.updatePreferences.mockResolvedValue({ error: { status: 404, message: 'User not found' } });
    expect(parse(await tool('update_preferences').handler({ currency: 'EUR' }, CTX)).error.code).toBe('not_found');
  });

  test('does NOT write a McpActionLog row (ledger-less, cosmetic)', async () => {
    const McpActionLog = require('../models/McpActionLog');
    accountOps.updatePreferences.mockResolvedValue({ user: { preferences: {} }, changed: ['preferences.currency'] });
    await tool('update_preferences').handler({ currency: 'EUR' }, CTX);
    expect(McpActionLog.create).not.toHaveBeenCalled();
  });
});

describe('update_profile', () => {
  test('delegates, audits via ctx.req, and returns the profile view', async () => {
    accountOps.updateProfile.mockResolvedValue({ user: { _id: ME, username: 'jo', bio: 'Loves Barolo' }, changed: ['bio'] });
    const body = parse(await tool('update_profile').handler({ bio: 'Loves Barolo', display_name: 'Jo' }, CTX));
    expect(accountOps.updateProfile).toHaveBeenCalledWith(ME, { bio: 'Loves Barolo', displayName: 'Jo' });
    expect(logAudit).toHaveBeenCalledWith(REQ, 'user.profile.update', { type: 'user', id: ME }, { via: 'mcp' });
    expect(body.data.bio).toBe('Loves Barolo');
  });
});

describe('create_support_ticket / request_wine_addition', () => {
  test('create_support_ticket delegates, audits, and returns a human-queue note', async () => {
    accountOps.createSupportTicket.mockResolvedValue({ ticket: { _id: 't1', category: 'bug', status: 'open' } });
    const body = parse(await tool('create_support_ticket').handler(
      { category: 'bug', subject: 'Crash', message: 'It broke' }, CTX));
    expect(accountOps.createSupportTicket).toHaveBeenCalledWith(ME, { category: 'bug', subject: 'Crash', message: 'It broke' });
    expect(logAudit).toHaveBeenCalledWith(REQ, 'support.ticket.created', { type: 'SupportTicket', id: 't1' }, { via: 'mcp', category: 'bug' });
    expect(body.data.ticket_id).toBe('t1');
    expect(body.data.note).toMatch(/web app/);
  });

  test('request_wine_addition maps params, delegates, and audits', async () => {
    accountOps.createWineRequest.mockResolvedValue({ wineRequest: { _id: 'wr1', wineName: 'Barolo', status: 'pending' } });
    const body = parse(await tool('request_wine_addition').handler(
      { wine_name: 'Barolo', source_url: 'https://vivino.com/w/1' }, CTX));
    expect(accountOps.createWineRequest).toHaveBeenCalledWith(ME, { wineName: 'Barolo', sourceUrl: 'https://vivino.com/w/1', image: undefined });
    expect(logAudit).toHaveBeenCalledWith(REQ, 'wineRequest.create', { type: 'wineRequest', id: 'wr1' }, { via: 'mcp' });
    expect(body.data.request_id).toBe('wr1');
  });

  test('a service validation error surfaces as invalid_input', async () => {
    accountOps.createWineRequest.mockResolvedValue({ error: { status: 400, message: 'Source URL is required' } });
    const res = await tool('request_wine_addition').handler({ wine_name: 'X', source_url: 'bad' }, CTX);
    expect(res.isError).toBe(true);
    expect(parse(res).error.code).toBe('invalid_input');
  });
});

describe('list_my_tickets (the read side of create_support_ticket)', () => {
  const SupportTicket = require('../models/SupportTicket');
  const ticketChain = (result) => {
    const c = {};
    for (const m of ['sort', 'skip', 'limit', 'select']) c[m] = jest.fn(() => c);
    c.lean = jest.fn(() => Promise.resolve(result));
    return c;
  };

  test('is read-scoped and read-only', () => {
    const t = tool('list_my_tickets');
    expect(t.scope).toBe('read');
    expect(t.annotations.readOnlyHint).toBe(true);
  });

  test('queries ONLY the caller\'s tickets, maps the response shape incl. the admin reply', async () => {
    SupportTicket.countDocuments.mockResolvedValue(2);
    SupportTicket.find.mockReturnValue(ticketChain([
      { _id: 't1', category: 'bug', subject: 'Rack view', message: 'It flickers', status: 'closed', adminResponse: 'Fixed in 1.82', respondedAt: new Date('2026-07-16'), createdAt: new Date('2026-07-15') },
      { _id: 't2', category: 'help', subject: 'Import', message: 'CSV?', status: 'open', createdAt: new Date('2026-07-17') },
    ]));
    const body = parse(await tool('list_my_tickets').handler({}, CTX));
    expect(SupportTicket.find).toHaveBeenCalledWith({ user: ME });
    expect(SupportTicket.countDocuments).toHaveBeenCalledWith({ user: ME });
    expect(body.data[0]).toEqual({
      ticket_id: 't1', category: 'bug', subject: 'Rack view', message: 'It flickers',
      status: 'closed', admin_response: 'Fixed in 1.82',
      responded_at: new Date('2026-07-16').toISOString(), created_at: new Date('2026-07-15').toISOString(),
      replies: [], can_reply: false, // closed → no follow-ups
    });
    expect(body.data[1].admin_response).toBeNull();
    expect(body.data[1].can_reply).toBe(true);
    expect(body.summary).toContain('2 support ticket(s)');
    expect(body.page.total).toBe(2);
  });

  test('can_reply is false once the reply cap is reached, even on an OPEN ticket (M6)', async () => {
    // reply_to_ticket refuses at TICKET_REPLY_CAP (admin replies count too), so
    // an open thread already at the cap must report can_reply:false.
    const replies = Array.from({ length: 30 }, (_, i) => ({ author: i % 2 ? 'admin' : 'user', message: `r${i}`, createdAt: new Date() }));
    SupportTicket.countDocuments.mockResolvedValue(1);
    SupportTicket.find.mockReturnValue(ticketChain([
      { _id: 't3', category: 'bug', subject: 'Long thread', message: 'start', status: 'open', replies, createdAt: new Date() },
    ]));
    const body = parse(await tool('list_my_tickets').handler({}, CTX));
    expect(body.data[0].status).toBe('open');
    expect(body.data[0].can_reply).toBe(false); // at cap
  });

  test('the conversation thread ships author+message+date, never the by refs', async () => {
    SupportTicket.countDocuments.mockResolvedValue(1);
    SupportTicket.find.mockReturnValue(ticketChain([{
      _id: 't3', category: 'bug', subject: 'S', message: 'M', status: 'open', createdAt: new Date('2026-07-17'),
      replies: [
        { author: 'admin', by: 'admin-id-secret', message: 'Can you retry?', createdAt: new Date('2026-07-17') },
        { author: 'user', by: ME, message: 'Still broken', createdAt: new Date('2026-07-17') },
      ],
    }]));
    const body = parse(await tool('list_my_tickets').handler({}, CTX));
    expect(body.data[0].replies).toEqual([
      { author: 'admin', message: 'Can you retry?', created_at: new Date('2026-07-17').toISOString() },
      { author: 'user', message: 'Still broken', created_at: new Date('2026-07-17').toISOString() },
    ]);
    expect(JSON.stringify(body)).not.toContain('admin-id-secret');
  });

  test('status filter narrows the query; paging clamps to the 50 cap', async () => {
    SupportTicket.countDocuments.mockResolvedValue(0);
    const chain = ticketChain([]);
    SupportTicket.find.mockReturnValue(chain);
    await tool('list_my_tickets').handler({ status: 'open', limit: 500 }, CTX);
    expect(SupportTicket.find).toHaveBeenCalledWith({ user: ME, status: 'open' });
    expect(chain.limit).toHaveBeenCalledWith(50);
  });
});

describe('reply_to_ticket (continuing the support conversation)', () => {
  test('is write-scoped and mutating (rides the mutation budget)', () => {
    const t = tool('reply_to_ticket');
    expect(t.scope).toBe('write');
    expect(t.annotations.readOnlyHint).toBe(false);
    expect(t.annotations.idempotentHint).toBe(false);
  });

  test('delegates to the shared accountOps service and audits via mcp', async () => {
    accountOps.replyToTicket.mockResolvedValue({
      ticket: { _id: 't1', subject: 'Room view crash', status: 'open', replies: [{}, {}] },
    });
    const body = parse(await tool('reply_to_ticket').handler({ ticket_id: 'f'.repeat(24), message: 'Still broken' }, CTX));
    expect(accountOps.replyToTicket).toHaveBeenCalledWith(ME, 'f'.repeat(24), 'Still broken');
    expect(body.data.status).toBe('open');
    expect(body.data.replies).toBe(2);
    expect(body.summary).toMatch(/reopened/i);
    expect(logAudit).toHaveBeenCalledWith(CTX.req, 'support.ticket.replied', expect.any(Object), expect.objectContaining({ via: 'mcp' }));
  });

  test('maps service errors: 404→not_found, 409 closed→conflict, 400→invalid_input', async () => {
    accountOps.replyToTicket.mockResolvedValue({ error: { status: 404, message: 'Ticket not found' } });
    expect(parse(await tool('reply_to_ticket').handler({ ticket_id: 'f'.repeat(24), message: 'x' }, CTX)).error.code).toBe('not_found');
    accountOps.replyToTicket.mockResolvedValue({ error: { status: 409, message: 'closed' } });
    expect(parse(await tool('reply_to_ticket').handler({ ticket_id: 'f'.repeat(24), message: 'x' }, CTX)).error.code).toBe('conflict');
    accountOps.replyToTicket.mockResolvedValue({ error: { status: 400, message: 'too long' } });
    expect(parse(await tool('reply_to_ticket').handler({ ticket_id: 'f'.repeat(24), message: 'x' }, CTX)).error.code).toBe('invalid_input');
  });
});
