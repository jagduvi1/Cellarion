/**
 * mark_not_wine (release audit 2026-10-28): every outcome answers the shared
 * envelope (a string summary, an object data), and a move — applied or filed —
 * leaves a ledger row so the member's AI activity and the admin aggregate
 * show it. Refusals map the service's codes, the gate's included.
 */
jest.mock('../models/WineDefinition', () => ({ findOne: jest.fn(), find: jest.fn(), findById: jest.fn() }));
jest.mock('../services/wineProposalOps', () => ({ pendingForWine: jest.fn() }));
jest.mock('../services/search', () => ({ getIsAvailable: () => false, search: jest.fn() }));
jest.mock('../services/registryReadTracker', () => ({ gateMcpRead: jest.fn(async () => ({ allowed: true })), CAP_MESSAGE: 'cap' }));
jest.mock('../utils/siteUrl', () => ({ siteBaseUrl: () => 'https://cellarion.app' }));
jest.mock('../services/ownHiddenWines', () => ({ findOwnHiddenWineIds: jest.fn(), isOwnHiddenWine: jest.fn() }));
jest.mock('../services/nonWineOps', () => ({ markNotWineByMember: jest.fn() }));
jest.mock('./actionLedger', () => ({ logAction: jest.fn(async () => ({ _id: 'row' })), replay: jest.fn() }));

const { markNotWineByMember } = require('../services/nonWineOps');
const { logAction } = require('./actionLedger');
const { allTools } = require('./registry');
require('./tools/wines');

const tool = (name) => allTools().find((t) => t.name === name);
const parse = (res) => JSON.parse(res.content[0].text);
const WINE = 'c'.repeat(24);
const CTX = { user: { id: '1'.repeat(24), roles: ['user'] }, req: { user: { id: '1'.repeat(24) } } };

beforeEach(() => jest.clearAllMocks());

describe('mark_not_wine', () => {
  test('an applied move answers a string summary with the data beside it, and logs a not_wine ledger row', async () => {
    markNotWineByMember.mockResolvedValue({ ok: true, status: 'applied', category: 'other' });
    const res = await tool('mark_not_wine').handler({ wine_id: WINE }, CTX);
    const body = parse(res);
    expect(typeof body.summary).toBe('string');
    expect(body.summary).toMatch(/Moved to Other/);
    expect(body.data).toEqual({ wine_id: WINE, status: 'applied', category: 'other' });
    expect(markNotWineByMember).toHaveBeenCalledWith({ wineId: WINE, userId: CTX.user.id, req: CTX.req, via: 'mcp' });
    expect(logAction).toHaveBeenCalledWith(CTX, expect.objectContaining({
      tool: 'mark_not_wine', action: 'not_wine', detail: { wineId: WINE, status: 'applied' },
    }));
  });

  test('a filed move carries the holder count and is logged too; an already-Other row is not', async () => {
    markNotWineByMember.mockResolvedValue({ ok: true, status: 'filed', category: 'wine', holders: 5 });
    const filed = parse(await tool('mark_not_wine').handler({ wine_id: WINE }, CTX));
    expect(filed.data).toEqual({ wine_id: WINE, status: 'filed', category: 'wine', holders: 5 });
    expect(filed.summary).toMatch(/5 members hold/);
    expect(logAction).toHaveBeenCalledTimes(1);

    markNotWineByMember.mockResolvedValue({ ok: true, status: 'already', category: 'other' });
    const already = parse(await tool('mark_not_wine').handler({ wine_id: WINE }, CTX));
    expect(already.data.status).toBe('already');
    expect(logAction).toHaveBeenCalledTimes(1);
  });

  test('refusals map the service codes: forbidden and banned → forbidden, limit → rate_limited, not_found → not_found', async () => {
    for (const [code, expected] of [['forbidden', 'forbidden'], ['banned', 'forbidden'], ['limit', 'rate_limited'], ['not_found', 'not_found'], ['invalid', 'invalid_input']]) {
      markNotWineByMember.mockResolvedValue({ ok: false, code, message: `because ${code}` });
      const res = await tool('mark_not_wine').handler({ wine_id: WINE }, CTX);
      expect(res.isError).toBe(true);
      expect(parse(res).error.code).toBe(expected);
    }
    expect(logAction).not.toHaveBeenCalled();
  });
});
