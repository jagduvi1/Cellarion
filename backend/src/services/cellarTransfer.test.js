/**
 * Cellar ownership transfer.
 *
 * The failure this guards is silent and delayed: `user` on Cellar, Bottle and
 * Rack each mean "whose is this", and account deletion purges all three BY THAT
 * FIELD. A transfer that moves only the cellar therefore hands someone a
 * collection that is still scheduled for destruction when the previous owner
 * closes their account — and nothing looks wrong until that day. So the tests
 * that matter are about what moves, and in what order.
 */

const mockBottleUpdateMany = jest.fn();
const mockRackUpdateMany = jest.fn();
const mockBottleDistinct = jest.fn();
const mockRackDistinct = jest.fn();
const mockCellarFindOne = jest.fn();
const mockCellarExists = jest.fn();
const mockUserFindById = jest.fn();

jest.mock('../models/Cellar', () => ({
  findOne: (...a) => mockCellarFindOne(...a),
  exists: (...a) => mockCellarExists(...a),
}));
jest.mock('../models/Bottle', () => ({
  updateMany: (...a) => mockBottleUpdateMany(...a),
  find: () => ({ distinct: (...a) => mockBottleDistinct(...a) }),
}));
jest.mock('../models/Rack', () => ({
  updateMany: (...a) => mockRackUpdateMany(...a),
  find: () => ({ distinct: (...a) => mockRackDistinct(...a) }),
}));
jest.mock('../models/User', () => ({ findById: (...a) => mockUserFindById(...a) }));

const { transferCellarOwnership } = require('./cellarTransfer');

const OWNER = '64b000000000000000000001';
const CLIENT = '64b000000000000000000002';
const STRANGER = '64b000000000000000000003';
const CELLAR = '64b0000000000000000000c1';

/** A saveable cellar stub that records when save() happened. */
function cellarStub(over = {}, order = []) {
  return {
    _id: CELLAR,
    name: "Client's Cellar",
    user: OWNER,
    deletedAt: null,
    members: [{ user: CLIENT, role: 'editor', addedAt: new Date() }],
    save: jest.fn(async () => { order.push('cellar'); }),
    ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockBottleUpdateMany.mockResolvedValue({ modifiedCount: 0 });
  mockRackUpdateMany.mockResolvedValue({ modifiedCount: 0 });
  mockBottleDistinct.mockResolvedValue([]);
  mockRackDistinct.mockResolvedValue([]);
  mockCellarExists.mockResolvedValue(null); // no name clash unless a test says so
  mockUserFindById.mockReturnValue({ select: () => ({ lean: async () => ({ _id: CLIENT, username: 'client', email: 'c@example.com' }) }) });
});

describe('what moves', () => {
  test('the bottles move, or the new owner inherits a deletion cascade', async () => {
    mockCellarFindOne.mockResolvedValue(cellarStub());
    mockBottleUpdateMany.mockResolvedValue({ modifiedCount: 214 });
    const res = await transferCellarOwnership(CELLAR, CLIENT, OWNER);

    expect(mockBottleUpdateMany).toHaveBeenCalledWith(
      { cellar: CELLAR, user: OWNER },
      { $set: { user: CLIENT } },
    );
    expect(res.bottlesMoved).toBe(214);
  });

  test('the racks move too', async () => {
    mockCellarFindOne.mockResolvedValue(cellarStub());
    mockRackUpdateMany.mockResolvedValue({ modifiedCount: 6 });
    const res = await transferCellarOwnership(CELLAR, CLIENT, OWNER);

    expect(mockRackUpdateMany).toHaveBeenCalledWith(
      { cellar: CELLAR, user: OWNER },
      { $set: { user: CLIENT } },
    );
    expect(res.racksMoved).toBe(6);
  });

  test('bottles and racks are matched on the OLD owner, so a re-run is a no-op', async () => {
    // Idempotency is the only recovery mechanism available: production Mongo is
    // standalone, so a partial transfer cannot be rolled back, only completed.
    const cellar = cellarStub();
    mockCellarFindOne.mockResolvedValue(cellar);
    await transferCellarOwnership(CELLAR, CLIENT, OWNER);
    const [bottleFilter] = mockBottleUpdateMany.mock.calls[0];
    expect(bottleFilter.user).toBe(OWNER);
  });

  test('the cellar ends up owned by the new owner', async () => {
    const cellar = cellarStub();
    mockCellarFindOne.mockResolvedValue(cellar);
    await transferCellarOwnership(CELLAR, CLIENT, OWNER);
    expect(String(cellar.user)).toBe(CLIENT);
    expect(cellar.save).toHaveBeenCalled();
  });
});

describe('ordering — the cellar flips LAST', () => {
  test('bottles and racks are rewritten before the cellar changes hands', async () => {
    // Flip the cellar first and a failure at the bottle step leaves the new
    // owner holding bottles that still purge with the old owner's account.
    const order = [];
    mockBottleUpdateMany.mockImplementation(async () => { order.push('bottles'); return { modifiedCount: 1 }; });
    mockRackUpdateMany.mockImplementation(async () => { order.push('racks'); return { modifiedCount: 1 }; });
    mockCellarFindOne.mockResolvedValue(cellarStub({}, order));

    await transferCellarOwnership(CELLAR, CLIENT, OWNER);
    expect(order).toEqual(['bottles', 'racks', 'cellar']);
  });

  test('a failure moving bottles leaves ownership untouched', async () => {
    const cellar = cellarStub();
    mockCellarFindOne.mockResolvedValue(cellar);
    mockBottleUpdateMany.mockRejectedValue(new Error('mongo went away'));

    await expect(transferCellarOwnership(CELLAR, CLIENT, OWNER)).rejects.toThrow('mongo went away');
    expect(String(cellar.user)).toBe(OWNER);   // still theirs — retry is safe
    expect(cellar.save).not.toHaveBeenCalled();
  });
});

describe('the cellar must be able to LAND before anything moves', () => {
  // A cellar name is unique per owner. Without this check the bottles and racks
  // moved first and the final save was then refused, leaving a collection owned
  // by one account inside a cellar owned by another — and a re-run could not
  // repair it, because the bottles no longer matched the old owner.
  test('a recipient who already has a cellar of that name is refused, and NOTHING moves', async () => {
    mockCellarFindOne.mockResolvedValue(cellarStub());
    mockCellarExists.mockResolvedValue({ _id: 'their-own-cellar' });

    await expect(transferCellarOwnership(CELLAR, CLIENT, OWNER))
      .rejects.toMatchObject({ status: 409, message: expect.stringContaining("Client's Cellar") });

    expect(mockCellarExists).toHaveBeenCalledWith({ user: CLIENT, name: "Client's Cellar", deletedAt: null });
    expect(mockBottleUpdateMany).not.toHaveBeenCalled();
    expect(mockRackUpdateMany).not.toHaveBeenCalled();
  });

  test('a soft-deleted cellar of the same name does not block the handover', async () => {
    mockCellarFindOne.mockResolvedValue(cellarStub());
    mockCellarExists.mockResolvedValue(null); // the query excludes deleted ones
    await expect(transferCellarOwnership(CELLAR, CLIENT, OWNER)).resolves.toBeDefined();
  });
});

describe('a refused save leaves no trace', () => {
  const withMoved = (over = {}) => {
    mockBottleDistinct.mockResolvedValue(['b1', 'b2']);
    mockRackDistinct.mockResolvedValue(['r1']);
    const cellar = cellarStub(over);
    mockCellarFindOne.mockResolvedValue(cellar);
    return cellar;
  };

  test('the exact bottles and racks are put back when the cellar save fails', async () => {
    const cellar = withMoved({ save: jest.fn().mockRejectedValue(new Error('mongo went away')) });

    await expect(transferCellarOwnership(CELLAR, CLIENT, OWNER)).rejects.toThrow('mongo went away');

    // By id, never a blind inverse: the recipient was already a member and may
    // own bottles here themselves, which must not be given to the old owner.
    expect(mockBottleUpdateMany).toHaveBeenLastCalledWith({ _id: { $in: ['b1', 'b2'] } }, { $set: { user: OWNER } });
    expect(mockRackUpdateMany).toHaveBeenLastCalledWith({ _id: { $in: ['r1'] } }, { $set: { user: OWNER } });
    expect(String(cellar.user)).toBe(OWNER);
  });

  test('a duplicate-key save is reported as a 409, not a 500', async () => {
    const dup = Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
    withMoved({ save: jest.fn().mockRejectedValue(dup) });

    await expect(transferCellarOwnership(CELLAR, CLIENT, OWNER))
      .rejects.toMatchObject({ status: 409 });
  });

  test('nothing is rolled back when nothing moved', async () => {
    withMoved({ save: jest.fn().mockRejectedValue(new Error('nope')) });
    mockBottleDistinct.mockResolvedValue([]);
    mockRackDistinct.mockResolvedValue([]);

    await expect(transferCellarOwnership(CELLAR, CLIENT, OWNER)).rejects.toThrow('nope');
    // Only the forward updateMany calls happened — no empty $in rollback.
    expect(mockBottleUpdateMany).toHaveBeenCalledTimes(1);
    expect(mockRackUpdateMany).toHaveBeenCalledTimes(1);
  });
});

describe('membership after the handover', () => {
  test('the outgoing owner stays on as an editor', async () => {
    // The entire professional workflow depends on this: build it, hand it over,
    // keep adding stock.
    const cellar = cellarStub();
    mockCellarFindOne.mockResolvedValue(cellar);
    await transferCellarOwnership(CELLAR, CLIENT, OWNER);

    const outgoing = cellar.members.find((m) => String(m.user) === OWNER);
    expect(outgoing).toBeDefined();
    expect(outgoing.role).toBe('editor');
  });

  test('the incoming owner is removed from the member list — owner is not a membership row', async () => {
    const cellar = cellarStub();
    mockCellarFindOne.mockResolvedValue(cellar);
    await transferCellarOwnership(CELLAR, CLIENT, OWNER);
    expect(cellar.members.some((m) => String(m.user) === CLIENT)).toBe(false);
  });

  test('other members are left alone', async () => {
    const cellar = cellarStub({
      members: [
        { user: CLIENT, role: 'editor', addedAt: new Date() },
        { user: STRANGER, role: 'viewer', addedAt: new Date() },
      ],
    });
    mockCellarFindOne.mockResolvedValue(cellar);
    await transferCellarOwnership(CELLAR, CLIENT, OWNER);
    const kept = cellar.members.find((m) => String(m.user) === STRANGER);
    expect(kept).toBeDefined();
    expect(kept.role).toBe('viewer');
  });
});

describe('who may do it, and to whom', () => {
  test('only the owner can transfer', async () => {
    mockCellarFindOne.mockResolvedValue(cellarStub());
    await expect(transferCellarOwnership(CELLAR, CLIENT, STRANGER))
      .rejects.toMatchObject({ status: 403 });
    expect(mockBottleUpdateMany).not.toHaveBeenCalled();
  });

  test('the recipient must already be a member', async () => {
    // The consent step: nobody is handed a stranger's collection — and its
    // storage cost and GDPR position — without having been invited first.
    mockCellarFindOne.mockResolvedValue(cellarStub());
    await expect(transferCellarOwnership(CELLAR, STRANGER, OWNER))
      .rejects.toMatchObject({ status: 400, message: 'The new owner must already be a member of this cellar' });
    expect(mockBottleUpdateMany).not.toHaveBeenCalled();
  });

  test('transferring to yourself is refused', async () => {
    mockCellarFindOne.mockResolvedValue(cellarStub());
    await expect(transferCellarOwnership(CELLAR, OWNER, OWNER))
      .rejects.toMatchObject({ status: 400 });
  });

  test('a missing cellar is a 404, and nothing is written', async () => {
    mockCellarFindOne.mockResolvedValue(null);
    await expect(transferCellarOwnership(CELLAR, CLIENT, OWNER))
      .rejects.toMatchObject({ status: 404 });
    expect(mockBottleUpdateMany).not.toHaveBeenCalled();
  });

  test('a soft-deleted cellar cannot be transferred', async () => {
    // findOne is called with deletedAt: null, so a deleted cellar simply is not
    // found — pinned because "transfer the thing I just deleted" is a plausible
    // support request and the answer must be no.
    mockCellarFindOne.mockResolvedValue(null);
    await expect(transferCellarOwnership(CELLAR, CLIENT, OWNER)).rejects.toMatchObject({ status: 404 });
    expect(mockCellarFindOne).toHaveBeenCalledWith({ _id: CELLAR, deletedAt: null });
  });

  test('a member whose account has since vanished is a 404', async () => {
    mockCellarFindOne.mockResolvedValue(cellarStub());
    mockUserFindById.mockReturnValue({ select: () => ({ lean: async () => null }) });
    await expect(transferCellarOwnership(CELLAR, CLIENT, OWNER)).rejects.toMatchObject({ status: 404 });
    expect(mockBottleUpdateMany).not.toHaveBeenCalled();
  });
});
