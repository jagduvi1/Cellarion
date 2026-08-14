/**
 * budgetedHandler — the per-tool-call gate (MCP-audit H2, M7).
 *
 * This wrapper decides: per-request cap, cross-request call budget, mutating
 * fail-closed for anonymous, the per-user/IP mutation budget, and the
 * idempotency claim RELEASE-on-error. None of that was driven end-to-end by any
 * test — the keyed tool suites call handlers directly, bypassing the wrapper,
 * so a regression in the release-on-error decision (or the selfBudgeted skip)
 * would ship green. These tests exercise the real wrapper with a stub tool.
 */

// The three registration side-effect requires pull the whole tool graph; stub
// them so this suite stays about the wrapper, not the tools.
jest.mock('./tools', () => {});
jest.mock('./resources', () => {});
jest.mock('./prompts', () => {});
jest.mock('./callBudget', () => ({ withinCallBudget: jest.fn(() => true) }));
jest.mock('./mutationBudget', () => ({ takeMutationSlot: jest.fn(() => true), ipKeyFor: jest.fn(() => null), WRITE_WINDOW_MS: 900000 }));
jest.mock('./actionLedger', () => ({ releaseClaim: jest.fn() }));
jest.mock('../models/McpUsageStat', () => ({ record: jest.fn() }));

const { withinCallBudget } = require('./callBudget');
const { takeMutationSlot } = require('./mutationBudget');
const { releaseClaim } = require('./actionLedger');
const { budgetedHandler, MAX_CALLS_PER_REQUEST } = require('./server');

const USER = { id: 'u1' };
const ctxFor = (over = {}) => ({ user: USER, req: { headers: {} }, ...over });
const readTool = (handler) => ({ name: 'search_bottles', annotations: { readOnlyHint: true }, handler });
const writeTool = (handler, extra = {}) => ({ name: 'add_bottle', annotations: { readOnlyHint: false }, handler, ...extra });
const parse = (env) => JSON.parse(env.content[0].text);
const freshState = () => ({ calls: 0 });

beforeEach(() => {
  jest.clearAllMocks();
  withinCallBudget.mockReturnValue(true);
  takeMutationSlot.mockReturnValue(true);
});

describe('budget gates', () => {
  test('per-request cap: the (max+1)th call is refused, handler not run', async () => {
    const handler = jest.fn(async () => ({ content: [] }));
    const state = { calls: MAX_CALLS_PER_REQUEST }; // next call is over
    const env = await budgetedHandler(readTool(handler), ctxFor(), state)({});
    expect(parse(env).error.code).toBe('rate_limited');
    expect(handler).not.toHaveBeenCalled();
  });

  test('cross-request call budget exhausted → refused before the handler', async () => {
    withinCallBudget.mockReturnValue(false);
    const handler = jest.fn(async () => ({ content: [] }));
    const env = await budgetedHandler(readTool(handler), ctxFor(), freshState())({});
    expect(parse(env).error.code).toBe('rate_limited');
    expect(handler).not.toHaveBeenCalled();
  });

  test('a mutating tool on the anonymous surface is refused (forbidden_scope)', async () => {
    const handler = jest.fn(async () => ({ content: [] }));
    const env = await budgetedHandler(writeTool(handler), ctxFor({ anonymous: true, user: null }), freshState())({});
    expect(parse(env).error.code).toBe('forbidden_scope');
    expect(handler).not.toHaveBeenCalled();
  });

  test('a mutating tool charges the mutation budget and is refused when exhausted', async () => {
    takeMutationSlot.mockReturnValue(false);
    const handler = jest.fn(async () => ({ content: [] }));
    const env = await budgetedHandler(writeTool(handler), ctxFor(), freshState())({});
    expect(takeMutationSlot).toHaveBeenCalledWith('u1', 1, null);
    expect(parse(env).error.code).toBe('rate_limited');
    expect(handler).not.toHaveBeenCalled();
  });

  test('a selfBudgeted tool does NOT ride the generic mutation charge (M7)', async () => {
    const handler = jest.fn(async () => ({ content: [{ type: 'text', text: '{}' }] }));
    await budgetedHandler(writeTool(handler, { selfBudgeted: true }), ctxFor(), freshState())({});
    expect(takeMutationSlot).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalled();
  });
});

describe('idempotency claim release-on-error (H2)', () => {
  const key = 'k1';

  test('a tool that returns an ordinary error RELEASES the claim', async () => {
    const handler = jest.fn(async () => ({ isError: true, content: [{ type: 'text', text: '{}' }] }));
    await budgetedHandler(writeTool(handler), ctxFor(), freshState())({ idempotency_key: key });
    expect(releaseClaim).toHaveBeenCalledWith(ctxForMatch(), key, 'add_bottle');
  });

  test('a tool that returns the idempotency BUSY error does NOT release (a live twin owns it)', async () => {
    const handler = jest.fn(async () => ({ isError: true, idempotencyBusy: true, content: [{ type: 'text', text: '{}' }] }));
    await budgetedHandler(writeTool(handler), ctxFor(), freshState())({ idempotency_key: key });
    expect(releaseClaim).not.toHaveBeenCalled();
  });

  test('a tool that THROWS releases the claim and rethrows', async () => {
    const boom = new Error('boom');
    const handler = jest.fn(async () => { throw boom; });
    await expect(budgetedHandler(writeTool(handler), ctxFor(), freshState())({ idempotency_key: key })).rejects.toThrow('boom');
    expect(releaseClaim).toHaveBeenCalledWith(ctxForMatch(), key, 'add_bottle');
  });

  test('a SUCCESS never releases (logAction completed the claim)', async () => {
    const handler = jest.fn(async () => ({ content: [{ type: 'text', text: '{}' }] }));
    await budgetedHandler(writeTool(handler), ctxFor(), freshState())({ idempotency_key: key });
    expect(releaseClaim).not.toHaveBeenCalled();
  });

  test('no idempotency_key → never touches releaseClaim even on error', async () => {
    const handler = jest.fn(async () => ({ isError: true, content: [{ type: 'text', text: '{}' }] }));
    await budgetedHandler(writeTool(handler), ctxFor(), freshState())({});
    expect(releaseClaim).not.toHaveBeenCalled();
  });
});

// A bare error count says an agent is failing, not WHY — and "the tool's
// contract confuses the model" (invalid_input) and "a backend is down"
// (unavailable) need opposite responses from an admin.
describe('usage counters record the error CODE', () => {
  const McpUsageStat = require('../models/McpUsageStat');
  const failWith = (code) => ({ isError: true, content: [{ type: 'text', text: JSON.stringify({ error: { code, message: 'x' } }) }] });
  const lastRecord = () => McpUsageStat.record.mock.calls.at(-1)[0];

  test('a fail() envelope contributes its code', async () => {
    const handler = jest.fn(async () => failWith('invalid_input'));
    await budgetedHandler(readTool(handler), ctxFor(), freshState())({});
    expect(lastRecord()).toMatchObject({ name: 'search_bottles', error: true, code: 'invalid_input' });
  });

  test('a SUCCESS records no code (nothing to explain)', async () => {
    const handler = jest.fn(async () => ({ content: [{ type: 'text', text: '{}' }] }));
    await budgetedHandler(readTool(handler), ctxFor(), freshState())({});
    expect(lastRecord()).toMatchObject({ error: false, code: undefined });
  });

  test("a THROWN handler is 'threw', not a parsed code — there is no envelope to read", async () => {
    const handler = jest.fn(async () => { throw new Error('boom'); });
    await expect(budgetedHandler(readTool(handler), ctxFor(), freshState())({})).rejects.toThrow('boom');
    expect(lastRecord()).toMatchObject({ error: true, code: 'threw' });
  });

  test('a non-JSON / shapeless error body degrades to unknown instead of throwing inside instrumentation', async () => {
    const handler = jest.fn(async () => ({ isError: true, content: [{ type: 'text', text: 'not json' }] }));
    await budgetedHandler(readTool(handler), ctxFor(), freshState())({});
    expect(lastRecord()).toMatchObject({ error: true, code: 'unknown' });
  });

  test('budget refusals carry their own codes (the handler never ran to produce one)', async () => {
    withinCallBudget.mockReturnValue(false);
    await budgetedHandler(readTool(jest.fn()), ctxFor(), freshState())({});
    expect(lastRecord()).toMatchObject({ error: true, code: 'rate_limited' });

    // Reset: the call budget is checked BEFORE the mutating gate, so leaving it
    // exhausted would re-assert rate_limited and never reach forbidden_scope.
    withinCallBudget.mockReturnValue(true);
    await budgetedHandler(writeTool(jest.fn()), ctxFor({ anonymous: true, user: null }), freshState())({});
    expect(lastRecord()).toMatchObject({ error: true, code: 'forbidden_scope' });
  });
});

// ctx is spread with extra fields; assert on the object shape we passed.
function ctxForMatch() {
  return expect.objectContaining({ user: USER });
}
