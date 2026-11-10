/**
 * The sommelier tools when the row changed under the curator's feet.
 *
 * Each of these tools loads a row, then removes it. Between the two another
 * curator can act on the same row, and the tool must then report what
 * happened instead of repeating it:
 *   - remove_from_maturity_queue: a row reviewed since the load is a conflict,
 *     with no ledger row and no audit row for a removal that did not happen
 *   - reject_price_request: a request another curator declined first is
 *     not_found, and its requesters are not told a second time
 * Plus what the removal snapshot must hold: a pending row can carry a member's
 * imported suggestion, and undo_last has only the snapshot to bring it back.
 *
 * The REST twins pin the same races in routes/somm/maturity.remove.test.js and
 * routes/somm/prices.decline.test.js; the rules themselves are pinned in
 * services/maturityOps.test.js and services/priceOps.test.js.
 */
const chain = (result) => {
  const c = {};
  for (const m of ['populate', 'sort', 'select']) c[m] = jest.fn(() => c);
  c.lean = jest.fn(() => Promise.resolve(result));
  c.then = (res, rej) => Promise.resolve(result).then(res, rej);
  return c;
};

jest.mock('../../../models/WineDefinition', () => ({ findById: jest.fn() }));
jest.mock('../../../models/WineVintageProfile', () => ({ findById: jest.fn(), deleteOne: jest.fn() }));
jest.mock('../../../models/PriceTrackingRequest', () => ({ findById: jest.fn(), findOneAndDelete: jest.fn() }));
jest.mock('../../../models/PriceTrackingSkip', () => ({ findOneAndUpdate: jest.fn() }));
jest.mock('../../../models/WineVintagePrice', () => ({}));
jest.mock('../../../models/McpActionLog', () => ({ create: jest.fn() }));
jest.mock('../../../services/audit', () => ({ logAudit: jest.fn(), logger: { warn: jest.fn() } }));
jest.mock('../../../services/dataVersion', () => ({ bumpWineOwners: jest.fn() }));
jest.mock('../../../services/notifications', () => ({ createNotification: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../../utils/exchangeRates', () => ({ getOrCreateDailySnapshot: jest.fn().mockResolvedValue({}) }));

const WineDefinition = require('../../../models/WineDefinition');
const WineVintageProfile = require('../../../models/WineVintageProfile');
const PriceTrackingRequest = require('../../../models/PriceTrackingRequest');
const PriceTrackingSkip = require('../../../models/PriceTrackingSkip');
const McpActionLog = require('../../../models/McpActionLog');
const { logAudit } = require('../../../services/audit');
const { createNotification } = require('../../../services/notifications');
const { allTools } = require('../../registry');
require('./maturity');
require('./prices');

const oid = (c) => c.repeat(24);
const ME = oid('a');
const SOMM_CTX = { user: { id: ME, roles: ['somm'] }, scopes: ['read', 'write'], req: { user: { id: ME, roles: ['somm'] }, headers: {}, apiToken: { id: 't1' } } };
const tool = (name) => allTools().find((t) => t.name === name);
const parse = (res) => JSON.parse(res.content[0].text);

beforeEach(() => {
  jest.clearAllMocks();
  McpActionLog.create.mockResolvedValue({});
});

describe('remove_from_maturity_queue', () => {
  const profile = (over = {}) => {
    const p = { _id: oid('1'), vintage: '2027', status: 'pending', relative: false, wineDefinition: { _id: oid('f'), name: 'Barolo' }, ...over };
    WineVintageProfile.findById.mockReturnValue(chain(p));
    return p;
  };

  test('a row reviewed between the load and the delete is a conflict: nothing ledgered, nothing audited', async () => {
    profile();
    WineVintageProfile.deleteOne.mockResolvedValue({ deletedCount: 0 });
    const body = parse(await tool('remove_from_maturity_queue').handler({ profile_id: oid('1'), reason: '2027 not released' }, SOMM_CTX));
    expect(WineVintageProfile.deleteOne).toHaveBeenCalledWith({ _id: oid('1'), status: { $ne: 'reviewed' } });
    expect(body.error.code).toBe('conflict');
    expect(McpActionLog.create).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  test('a pending row carrying an imported suggestion is snapshotted whole, so undo can bring the suggestion back', async () => {
    profile({ peakFrom: 2030, peakUntil: 2038, sommNotes: 'From my cellar book', setBy: oid('b') });
    WineVintageProfile.deleteOne.mockResolvedValue({ deletedCount: 1 });
    const body = parse(await tool('remove_from_maturity_queue').handler({ profile_id: oid('1'), reason: 'duplicate vintage' }, SOMM_CTX));
    expect(body.error).toBeUndefined();
    const row = McpActionLog.create.mock.calls[0][0];
    expect(row.action).toBe('somm_maturity_remove');
    expect(row.prev).toMatchObject({
      wineDefinition: oid('f'), vintage: '2027', status: 'pending', relative: false,
      peakFrom: 2030, peakUntil: 2038, earlyFrom: null, sommNotes: 'From my cellar book', setBy: oid('b'),
    });
  });
});

describe('reject_price_request', () => {
  const REQ_ID = oid('9');
  const WINE_ID = oid('f');
  const request = { _id: REQ_ID, wineDefinition: WINE_ID, vintage: '2019', requesters: [{ user: oid('b') }, { user: oid('c') }] };

  test('declined by another curator between the load and the delete: not_found, nobody notified twice, nothing ledgered', async () => {
    WineDefinition.findById.mockReturnValue(chain({ _id: WINE_ID, name: 'Everyday Shiraz', producer: 'Casella' }));
    PriceTrackingRequest.findById.mockReturnValue(chain(request));
    // The other curator's suppression is already there, and the request is gone.
    PriceTrackingSkip.findOneAndUpdate.mockResolvedValue({ lastErrorObject: { updatedExisting: true }, value: { _id: 'sk1' } });
    PriceTrackingRequest.findOneAndDelete.mockResolvedValue(null);
    const body = parse(await tool('reject_price_request').handler({ request_id: REQ_ID, reason: 'No secondary market.' }, SOMM_CTX));
    expect(PriceTrackingRequest.findOneAndDelete).toHaveBeenCalledWith({ _id: REQ_ID });
    expect(body.error.code).toBe('not_found');
    expect(createNotification).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
    expect(McpActionLog.create).not.toHaveBeenCalled();
  });
});
