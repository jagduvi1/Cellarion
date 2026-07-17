/**
 * actionLedger — the idempotency CLAIM contract (prior-audit M2).
 *
 * The old shape (findOne → mutate → create, duplicate-key swallowed) let two
 * concurrent same-key requests BOTH mutate; only the ledger row was deduped,
 * after the fact. These tests pin the claim-first semantics: replay() reserves
 * the key atomically before any mutation, a losing twin gets the stored result
 * or an in-progress conflict (never a green light), a failed call's claim is
 * releasable, and logAction completes the claim in place.
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
const parse = (env) => JSON.parse(env.content[0].text);

beforeEach(() => jest.clearAllMocks());

describe('replay — atomic claim', () => {
  test('no key → null, no DB access', async () => {
    expect(await replay(CTX, undefined)).toBeNull();
    expect(McpActionLog.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test('fresh key: upsert inserts the pending stub and the caller proceeds (null)', async () => {
    McpActionLog.findOneAndUpdate.mockResolvedValue({ lastErrorObject: { updatedExisting: false }, value: null });
    expect(await replay(CTX, KEY)).toBeNull();
    const [query, update, opts] = McpActionLog.findOneAndUpdate.mock.calls[0];
    expect(query).toEqual({ user: 'u1', idempotencyKey: KEY });
    expect(update.$setOnInsert).toMatchObject({ action: 'pending', pending: true, idempotencyKey: KEY });
    expect(opts).toMatchObject({ upsert: true, new: false });
  });

  test('completed key → the stored result is replayed verbatim', async () => {
    McpActionLog.findOneAndUpdate.mockResolvedValue({
      lastErrorObject: { updatedExisting: true },
      value: { pending: false, result: { summary: 'done', data: { x: 1 } } },
    });
    const env = await replay(CTX, KEY);
    expect(env.isError).toBeUndefined();
    expect(parse(env)).toEqual({ summary: 'done', data: { x: 1 } });
  });

  test('live pending twin → in-progress conflict marked idempotencyBusy (never a green light)', async () => {
    McpActionLog.findOneAndUpdate.mockResolvedValue({
      lastErrorObject: { updatedExisting: true },
      value: { _id: 'row1', pending: true, createdAt: new Date() },
    });
    const env = await replay(CTX, KEY);
    expect(env.isError).toBe(true);
    expect(env.idempotencyBusy).toBe(true);
    expect(parse(env).error.code).toBe('conflict');
    // Exactly one findOneAndUpdate: no steal attempt on a FRESH claim.
    expect(McpActionLog.findOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  test('stale pending claim (crashed twin) is taken over atomically', async () => {
    const staleDate = new Date(Date.now() - CLAIM_STALE_MS - 1000);
    McpActionLog.findOneAndUpdate
      .mockResolvedValueOnce({ lastErrorObject: { updatedExisting: true }, value: { _id: 'row1', pending: true, createdAt: staleDate } })
      .mockResolvedValueOnce({ _id: 'row1' }); // the steal wins
    expect(await replay(CTX, KEY)).toBeNull(); // we own the re-claim → proceed
    const stealQuery = McpActionLog.findOneAndUpdate.mock.calls[1][0];
    expect(stealQuery).toMatchObject({ _id: 'row1', pending: true, createdAt: staleDate });
  });

  test('losing the steal race → in-progress, not a green light', async () => {
    const staleDate = new Date(Date.now() - CLAIM_STALE_MS - 1000);
    McpActionLog.findOneAndUpdate
      .mockResolvedValueOnce({ lastErrorObject: { updatedExisting: true }, value: { _id: 'row1', pending: true, createdAt: staleDate } })
      .mockResolvedValueOnce(null); // another taker got there first
    const env = await replay(CTX, KEY);
    expect(env.isError).toBe(true);
    expect(env.idempotencyBusy).toBe(true);
  });

  test('E11000 on the racing upsert falls back to the existing row (loser replays)', async () => {
    McpActionLog.findOneAndUpdate.mockRejectedValue(Object.assign(new Error('dup'), { code: 11000 }));
    McpActionLog.findOne.mockReturnValue({ lean: () => Promise.resolve({ pending: false, result: { summary: 'orig' } }) });
    const env = await replay(CTX, KEY);
    expect(parse(env).summary).toBe('orig');
  });
});

describe('logAction', () => {
  test('with a key: completes the pending claim in place (same row, pending→false)', async () => {
    McpActionLog.findOneAndUpdate.mockResolvedValue({ _id: 'row1' });
    await logAction(CTX, { tool: 'add_bottle', action: 'add', idempotencyKey: KEY, result: { summary: 's' } });
    const [query, update] = McpActionLog.findOneAndUpdate.mock.calls[0];
    expect(query).toEqual({ user: 'u1', idempotencyKey: KEY, pending: true });
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
    await expect(logAction(CTX, { action: 'add', idempotencyKey: KEY })).resolves.toBeNull();
  });
});

describe('releaseClaim', () => {
  test('deletes ONLY the pending stub for this user+key', async () => {
    McpActionLog.deleteOne.mockResolvedValue({});
    await releaseClaim(CTX, KEY);
    expect(McpActionLog.deleteOne).toHaveBeenCalledWith({ user: 'u1', idempotencyKey: KEY, pending: true });
  });

  test('no key / no user / DB error → silent no-op', async () => {
    await releaseClaim(CTX, undefined);
    await releaseClaim({}, KEY);
    expect(McpActionLog.deleteOne).not.toHaveBeenCalled();
    McpActionLog.deleteOne.mockRejectedValue(new Error('down'));
    await expect(releaseClaim(CTX, KEY)).resolves.toBeUndefined();
  });
});
