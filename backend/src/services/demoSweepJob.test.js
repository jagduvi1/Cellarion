/**
 * Guards the ephemeral-demo reaper invariants:
 *  - only isDemo accounts whose demoExpiresAt is due are selected;
 *  - the FULL cascade (purgeUserData) runs before the user doc is deleted;
 *  - a live SSE stream is closed (eventBus.dropUser) before deletion;
 *  - one user's purge failure never aborts the rest of the batch;
 *  - the sweep is batch-capped so an abusive burst can't run unbounded.
 */
jest.mock('../models/User', () => ({
  find: jest.fn(),
  deleteOne: jest.fn(),
}));
jest.mock('./userDataRegistry', () => ({
  purgeUserData: jest.fn(),
}));
jest.mock('./eventBus', () => ({
  dropUser: jest.fn(),
}));

const User = require('../models/User');
const { purgeUserData } = require('./userDataRegistry');
const eventBus = require('./eventBus');
const { runDemoSweep } = require('./demoSweepJob');

function mockExpiredDemos(users) {
  User.find.mockReturnValue({
    select: jest.fn().mockReturnValue({
      limit: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue(users),
      }),
    }),
  });
}

let logSpy, errorSpy;

beforeEach(() => {
  jest.clearAllMocks();
  purgeUserData.mockResolvedValue();
  User.deleteOne.mockResolvedValue({ deletedCount: 1 });
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
});

describe('runDemoSweep', () => {
  test('selects only isDemo accounts whose demoExpiresAt is due, capped + minimal projection', async () => {
    mockExpiredDemos([]);

    const before = Date.now();
    const result = await runDemoSweep();
    const after = Date.now();

    expect(result).toEqual({ deleted: 0 });
    expect(User.find).toHaveBeenCalledTimes(1);
    const [filter] = User.find.mock.calls[0];
    expect(filter.isDemo).toBe(true);
    expect(filter.demoExpiresAt.$lte).toBeInstanceOf(Date);
    expect(filter.demoExpiresAt.$lte.getTime()).toBeGreaterThanOrEqual(before);
    expect(filter.demoExpiresAt.$lte.getTime()).toBeLessThanOrEqual(after);
    // Data minimisation + batch cap
    const chain = User.find.mock.results[0].value;
    expect(chain.select).toHaveBeenCalledWith('_id email');
    expect(chain.select.mock.results[0].value.limit).toHaveBeenCalledWith(500);
  });

  test('does nothing when no demo accounts are expired', async () => {
    mockExpiredDemos([]);

    await runDemoSweep();

    expect(purgeUserData).not.toHaveBeenCalled();
    expect(User.deleteOne).not.toHaveBeenCalled();
    expect(eventBus.dropUser).not.toHaveBeenCalled();
  });

  test('closes the SSE stream, purges ALL data, then deletes the user doc — in that order', async () => {
    mockExpiredDemos([{ _id: 'd1', email: 'demo-x@demo.cellarion.invalid' }]);

    const result = await runDemoSweep();

    expect(eventBus.dropUser).toHaveBeenCalledWith('d1');
    expect(purgeUserData).toHaveBeenCalledWith('d1', 'demo-x@demo.cellarion.invalid');
    expect(User.deleteOne).toHaveBeenCalledWith({ _id: 'd1' });
    expect(result).toEqual({ deleted: 1 });

    // Order: dropUser → purge → deleteOne (deleting first would orphan cloned data)
    const dropOrder = eventBus.dropUser.mock.invocationCallOrder[0];
    const purgeOrder = purgeUserData.mock.invocationCallOrder[0];
    const deleteOrder = User.deleteOne.mock.invocationCallOrder[0];
    expect(dropOrder).toBeLessThan(purgeOrder);
    expect(purgeOrder).toBeLessThan(deleteOrder);
  });

  test('one demo purge failure does not abort the batch, and is not counted as deleted', async () => {
    mockExpiredDemos([
      { _id: 'd1', email: 'a@demo.cellarion.invalid' },
      { _id: 'd2', email: 'b@demo.cellarion.invalid' },
    ]);
    purgeUserData
      .mockRejectedValueOnce(new Error('purge exploded'))
      .mockResolvedValueOnce();

    const result = await runDemoSweep();

    expect(purgeUserData).toHaveBeenCalledTimes(2);
    // d1 failed before its doc deletion; d2 completed
    expect(User.deleteOne).toHaveBeenCalledTimes(1);
    expect(User.deleteOne).toHaveBeenCalledWith({ _id: 'd2' });
    expect(result).toEqual({ deleted: 1 });
    expect(errorSpy).toHaveBeenCalled();
  });
});
