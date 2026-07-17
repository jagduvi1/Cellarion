/**
 * structuralUndo — the unplace-undo status guard (grand-audit M2).
 *
 * Pins that undoing an unplace refuses when the bottle has been CONSUMED (or
 * left the cellar, or the rack shrank) since — and, critically, that it does
 * so BEFORE claiming the ledger row, so a doomed reversal doesn't burn the row
 * (the M1 class). placeBottleInRack is mocked, so a re-slot attempt on a
 * consumed bottle would show up as a call — it must not happen.
 */

jest.mock('../models/Cellar', () => ({ findOne: jest.fn() }));
jest.mock('../models/Rack', () => ({ findOne: jest.fn() }));
jest.mock('../models/Bottle', () => ({ findById: jest.fn() }));
jest.mock('../models/McpActionLog', () => ({ findOneAndUpdate: jest.fn() }));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));
jest.mock('../utils/rackGeometry', () => ({ getMaxPosition: jest.fn(() => 12) }));
jest.mock('../services/rackOps', () => ({
  placeBottleInRack: jest.fn(), clearRackSlot: jest.fn(), moveBottleToCellar: jest.fn(),
}));
jest.mock('./toolUtil', () => ({ resolveBottleAccess: jest.fn(), resolveCellarAccess: jest.fn() }));

const Rack = require('../models/Rack');
const Bottle = require('../models/Bottle');
const McpActionLog = require('../models/McpActionLog');
const { placeBottleInRack } = require('../services/rackOps');
const { resolveCellarAccess } = require('./toolUtil');
const { undoStructural } = require('./structuralUndo');

const oid = (c) => c.repeat(24);
const RACK = oid('a');
const CELLAR = oid('c');
const BOTTLE = oid('b');
const helpers = {
  ok: (summary, data) => ({ ok: true, summary, data }),
  fail: (code, message) => ({ ok: false, code, message }),
  logAction: jest.fn(),
};
const CTX = { user: { id: oid('9') }, req: { headers: {} } };
const unplaceRow = () => ({ _id: oid('f'), action: 'unplace', cellar: CELLAR, bottle: BOTTLE,
  detail: { rackId: RACK, position: 3, bottleId: BOTTLE } });

beforeEach(() => {
  jest.clearAllMocks();
  Rack.findOne.mockResolvedValue({ _id: RACK, cellar: CELLAR, slots: [] });
  resolveCellarAccess.mockResolvedValue({ cellar: { _id: CELLAR } });
  McpActionLog.findOneAndUpdate.mockResolvedValue({ _id: oid('f') });
});

test('refuses to re-slot a CONSUMED bottle, and does NOT claim the row', async () => {
  Bottle.findById.mockResolvedValue({ _id: BOTTLE, status: 'drank', cellar: CELLAR });
  const res = await undoStructural(unplaceRow(), CTX, helpers);
  expect(res.ok).toBe(false);
  expect(res.message).toMatch(/consumed/i);
  expect(placeBottleInRack).not.toHaveBeenCalled();
  expect(McpActionLog.findOneAndUpdate).not.toHaveBeenCalled(); // not burned
});

test('refuses when the bottle left the rack\'s cellar', async () => {
  Bottle.findById.mockResolvedValue({ _id: BOTTLE, status: 'active', cellar: oid('e') });
  const res = await undoStructural(unplaceRow(), CTX, helpers);
  expect(res.ok).toBe(false);
  expect(placeBottleInRack).not.toHaveBeenCalled();
  expect(McpActionLog.findOneAndUpdate).not.toHaveBeenCalled();
});

test('an active in-cellar bottle IS re-slotted (claims, then places)', async () => {
  Bottle.findById.mockResolvedValue({ _id: BOTTLE, status: 'active', cellar: CELLAR });
  placeBottleInRack.mockResolvedValue({ ok: true });
  const res = await undoStructural(unplaceRow(), CTX, helpers);
  expect(res.ok).toBe(true);
  expect(McpActionLog.findOneAndUpdate).toHaveBeenCalled();
  expect(placeBottleInRack).toHaveBeenCalledWith(expect.any(Object), 3, BOTTLE, expect.any(Object));
});
