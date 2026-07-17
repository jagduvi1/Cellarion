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
  createWineRequest: jest.fn(),
  // The tool descriptions read these allow-lists at module load — keep them real-ish.
  ALLOWED_CURRENCIES: ['USD', 'EUR', 'SEK'],
  ALLOWED_LANGUAGES: ['en', 'sv'],
  ALLOWED_RATING_SCALES: ['5', '20', '100'],
  ALLOWED_RACK_NAV: ['auto', 'room', 'rack'],
  ALLOWED_RESTOCK_SCOPE: ['all', 'cellar'],
  ALLOWED_VISIBILITY: ['public', 'private'],
  SUPPORT_CATEGORIES: ['bug', 'help', 'feature', 'other'],
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
