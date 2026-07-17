/**
 * actionLedger — the idempotency CLAIM contract (prior-audit M2, MCP-audit M1/M2).
 *
 * The old shape (findOne → mutate → create, duplicate-key swallowed) let two
 * concurrent same-key requests BOTH mutate; only the ledger row was deduped,
 * after the fact. These tests pin the claim-first semantics: replay() reserves
 * the key atomically before any mutation, a losing same-tool twin gets the
 * stored result or a `busy` conflict (never a green light), a key reused on a
 * DIFFERENT tool is refused, a failed call's claim is releasable, and logAction
 * completes the claim in place.
 */

jest.mock('../models/McpActionLog', () => ({
  create: jest.fn(),
  findOne: jest.fn(),
  findOneAndUpdate: jest.fn(),
  deleteOne: jest.fn(),
}));

const McpActionLog = require('../models/McpActionLog');
const { logAction, replay, releaseClaim, CLAIM_STALE_MS } = require('./actionLedger');

const CTX = { user: { id: 'u1' }, req: { apiToken: { id: 't1' } } };
const KEY = 'idem-abc';
const TOOL = 'add_bottle';
const parse = (env) => JSON.parse(env.content[0].text);

beforeEach(() => jest.clearAllMocks());

describe('replay — atomic claim', () => {
  test('no key → null, no DB access', async () => {
    expect(await replay(CTX, undefined, TOOL)).toBeNull();
    expect(McpActionLog.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test('fresh key: upsert inserts the pending stub (recording the tool) and the caller proceeds (null)', async () => {
    McpActionLog.findOneAndUpdate.mockResolvedValue({ lastErrorObject: { updatedExisting: false }, value: null });
    expect(await replay(CTX, KEY, TOOL)).toBeNull();
    const [query, update, opts] = McpActionLog.findOneAndUpdate.mock.calls[0];
    expect(query).toEqual({ user: 'u1', idempotencyKey: KEY });
    expect(update.$setOnInsert).toMatchObject({ tool: TOOL, action: 'pending', pending: true, idempotencyKey: KEY });
    expect(opts).toMatchObject({ upsert: true, new: false });
  });

  test('completed same-tool key → the stored result is replayed verbatim', async () => {
    McpActionLog.findOneAndUpdate.mockResolvedValue({
      lastErrorObject: { updatedExisting: true },
      value: { tool: TOOL, pending: false, result: { summary: 'done', data: { x: 1 } } },
    });
    const env = await replay(CTX, KEY, TOOL);
    expect(env.isError).toBeUndefined();
    expect(parse(env)).toEqual({ summary: 'done', data: { x: 1 } });
  });

  test('key reused on a DIFFERENT tool → invalid_input, never the other tool\'s result (M2)', async () => {
    McpActionLog.findOneAndUpdate.mockResolvedValue({
      lastErrorObject: { updatedExisting: true },
      value: { tool: 'update_bottle', pending: false, result: { summary: 'updated B1' } },
    });
    const env = await replay(CTX, KEY, 'add_bottle');
    expect(env.isError).toBe(true);
    expect(env.idempotencyBusy).toBeUndefined(); // NOT a busy/steal case
    expect(parse(env).error.code).toBe('invalid_input');
    expect(parse(env).error.message).toMatch(/update_bottle/);
    // Guarded BEFORE any steal attempt.
    expect(McpActionLog.findOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  test('live same-tool twin → busy conflict marked idempotencyBusy (never a green light)', async () => {
    McpActionLog.findOneAndUpdate.mockResolvedValue({
      lastErrorObject: { updatedExisting: true },
      value: { _id: 'row1', tool: TOOL, pending: true, createdAt: new Date() },
    });
    const env = await replay(CTX, KEY, TOOL);
    expect(env.isError).toBe(true);
    expect(env.idempotencyBusy).toBe(true);
    expect(parse(env).error.code).toBe('busy'); // distinct from conflict (M1)
    expect(McpActionLog.findOneAndUpdate).toHaveBeenCalledTimes(1); // no steal on a fresh claim
  });

  test('stale same-tool claim (crashed twin) is taken over atomically', async () => {
    const staleDate = new Date(Date.now() - CLAIM_STALE_MS - 1000);
    McpActionLog.findOneAndUpdate
      .mockResolvedValueOnce({ lastErrorObject: { updatedExisting: true }, value: { _id: 'row1', tool: TOOL, pending: true, createdAt: staleDate } })
      .mockResolvedValueOnce({ _id: 'row1' }); // the steal wins
    expect(await replay(CTX, KEY, TOOL)).toBeNull(); // we own the re-claim → proceed
    const stealQuery = McpActionLog.findOneAndUpdate.mock.calls[1][0];
    expect(stealQuery).toMatchObject({ _id: 'row1', pending: true, createdAt: staleDate });
  });

  test('losing the steal race → busy, not a green light', async () => {
    const staleDate = new Date(Date.now() - CLAIM_STALE_MS - 1000);
    McpActionLog.findOneAndUpdate
      .mockResolvedValueOnce({ lastErrorObject: { updatedExisting: true }, value: { _id: 'row1', tool: TOOL, pending: true, createdAt: staleDate } })
      .mockResolvedValueOnce(null); // another taker got there first
    const env = await replay(CTX, KEY, TOOL);
    expect(env.isError).toBe(true);
    expect(env.idempotencyBusy).toBe(true);
  });

  test('E11000 on the racing upsert falls back to the existing row (loser replays)', async () => {
    McpActionLog.findOneAndUpdate.mockRejectedValue(Object.assign(new Error('dup'), { code: 11000 }));
    McpActionLog.findOne.mockReturnValue({ lean: () => Promise.resolve({ tool: TOOL, pending: false, result: { summary: 'orig' } }) });
    const env = await replay(CTX, KEY, TOOL);
    expect(parse(env).summary).toBe('orig');
  });
});

describe('logAction', () => {
  test('with a key: completes the pending claim in place, scoped by tool', async () => {
    McpActionLog.findOneAndUpdate.mockResolvedValue({ _id: 'row1' });
    await logAction(CTX, { tool: TOOL, action: 'add', idempotencyKey: KEY, result: { summary: 's' } });
    const [query, update] = McpActionLog.findOneAndUpdate.mock.calls[0];
    expect(query).toEqual({ user: 'u1', tool: TOOL, idempotencyKey: KEY, pending: true });
    expect(update.$set).toMatchObject({ action: 'add', pending: false });
    expect(McpActionLog.create).not.toHaveBeenCalled();
  });

  test('without a key: plain create, as before', async () => {
    McpActionLog.create.mockResolvedValue({ _id: 'row2' });
    await logAction(CTX, { tool: 'undo_last', action: 'restore', result: {} });
    expect(McpActionLog.create).toHaveBeenCalled();
    expect(McpActionLog.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test('never throws (the mutation already succeeded)', async () => {
    McpActionLog.findOneAndUpdate.mockRejectedValue(new Error('db down'));
    await expect(logAction(CTX, { tool: TOOL, action: 'add', idempotencyKey: KEY })).resolves.toBeNull();
  });
});

describe('releaseClaim', () => {
  test('deletes ONLY the pending stub for this user+tool+key', async () => {
    McpActionLog.deleteOne.mockResolvedValue({});
    await releaseClaim(CTX, KEY, TOOL);
    expect(McpActionLog.deleteOne).toHaveBeenCalledWith({ user: 'u1', tool: TOOL, idempotencyKey: KEY, pending: true });
  });

  test('no key / no user / DB error → silent no-op', async () => {
    await releaseClaim(CTX, undefined, TOOL);
    await releaseClaim({}, KEY, TOOL);
    expect(McpActionLog.deleteOne).not.toHaveBeenCalled();
    McpActionLog.deleteOne.mockRejectedValue(new Error('down'));
    await expect(releaseClaim(CTX, KEY, TOOL)).resolves.toBeUndefined();
  });
});
