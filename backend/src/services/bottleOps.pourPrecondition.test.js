/**
 * pourFromBottle's expectPours precondition. A pour queued offline carries the
 * number of glasses the user saw on the bottle; it is only recorded while the
 * bottle still shows that many. It guards a queued pour that reaches the
 * server after the server has forgotten its Idempotency-Key (the key's record
 * expires long before the offline queue gives up on a change).
 */

jest.mock('../models/Rack', () => ({ updateMany: jest.fn().mockResolvedValue({}) }));
jest.mock('./audit', () => ({ logAudit: jest.fn() }));
jest.mock('./restockChecker', () => ({ checkRestockGap: jest.fn().mockResolvedValue(undefined), resolveRestockAlerts: jest.fn().mockResolvedValue(undefined) }));

const { logAudit } = require('./audit');
const { pourFromBottle } = require('./bottleOps');

const REQ = { user: { id: 'u1', roles: ['user'] }, headers: {} };
const openDoc = (pours = []) => ({
  _id: 'b1', cellar: 'c1', status: 'active', vintage: '2015',
  openedAt: new Date('2026-07-28T19:00:00Z'), preservationMethod: 'vacuum',
  pours: [...pours], openBottleNotifiedAt: null,
  save: jest.fn().mockResolvedValue(undefined),
});
const glass = () => ({ at: new Date('2026-07-28T20:00:00Z'), ml: 125 });

beforeEach(() => jest.clearAllMocks());

describe('pourFromBottle — expectPours', () => {
  test('the bottle still shows the glasses the user saw → the pour is recorded', async () => {
    const fresh = openDoc();
    expect((await pourFromBottle(fresh, { ml: 150, expectPours: 0 }, REQ)).error).toBeUndefined();
    expect(fresh.pours).toHaveLength(1);
    expect(fresh.pours[0].ml).toBe(150);
    expect(fresh.save).toHaveBeenCalledTimes(1);

    const twoPoured = openDoc([glass(), glass()]);
    expect((await pourFromBottle(twoPoured, { expectPours: 2 }, REQ)).error).toBeUndefined();
    expect(twoPoured.pours).toHaveLength(3);
  });

  test('glasses were poured meanwhile (or this pour already landed) → 409 state_changed, nothing saved', async () => {
    const bottle = openDoc([glass()]);
    const res = await pourFromBottle(bottle, { ml: 125, expectPours: 0 }, REQ);
    expect(res.error).toMatchObject({ status: 409, code: 'state_changed' });
    expect(bottle.pours).toHaveLength(1);
    expect(bottle.save).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  test('fewer glasses than the user saw (a pour undone meanwhile) → also refused', async () => {
    const bottle = openDoc([glass()]);
    const res = await pourFromBottle(bottle, { expectPours: 2 }, REQ);
    expect(res.error).toMatchObject({ status: 409, code: 'state_changed' });
    expect(bottle.save).not.toHaveBeenCalled();
  });

  test('without expectPours (the pour button online, the MCP) → recorded whatever is poured', async () => {
    for (const opts of [{}, { expectPours: undefined }, { expectPours: null }]) {
      const bottle = openDoc([glass(), glass()]);
      expect((await pourFromBottle(bottle, opts, REQ)).error).toBeUndefined();
      expect(bottle.pours).toHaveLength(3);
    }
  });

  test('a bottle that is not open still answers not_open, before the count is compared', async () => {
    const closed = { ...openDoc(), openedAt: null };
    expect((await pourFromBottle(closed, { expectPours: 3 }, REQ)).error.code).toBe('not_open');
  });
});
