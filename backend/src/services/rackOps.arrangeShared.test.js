/**
 * The two pieces of the arrange load that the web Arrange preview and MCP
 * auto_arrange share from services/rackOps: the slot populate and the usable
 * position count. Real rack geometry; the models are mocked only so the
 * module loads without MongoDB.
 */

jest.mock('../models/Cellar', () => ({}));
jest.mock('../models/Rack', () => ({}));
jest.mock('../models/Bottle', () => ({}));
jest.mock('./audit', () => ({ logAudit: jest.fn() }));
jest.mock('./bottleOps', () => ({ removeFromRacks: jest.fn() }));

const { ARRANGE_SLOT_POPULATE, usablePositionCount } = require('./rackOps');

const grid = (disabledPositions) => ({ type: 'grid', rows: 2, cols: 2, isModular: false, disabledPositions });

describe('ARRANGE_SLOT_POPULATE', () => {
  test('selects what the arrange engine sorts on, including the NV window anchor', () => {
    expect(ARRANGE_SLOT_POPULATE.path).toBe('slots.bottle');
    expect(ARRANGE_SLOT_POPULATE.select.split(/\s+/).sort()).toEqual([
      'createdAt', 'drinkFrom', 'drinkTo', 'peakFrom', 'peakUntil', 'purchaseDate', 'status', 'vintage', 'wineDefinition',
    ]);
  });

  test('takes only the name, producer and type of the wine', () => {
    expect(ARRANGE_SLOT_POPULATE.populate).toEqual({ path: 'wineDefinition', select: 'name producer type' });
  });
});

describe('usablePositionCount', () => {
  test('every position of the rack when nothing is disabled', () => {
    expect(usablePositionCount(grid([]))).toBe(4);
    expect(usablePositionCount({ type: 'grid', rows: 2, cols: 2 })).toBe(4);
  });

  test('positions of the rack minus the disabled ones', () => {
    expect(usablePositionCount(grid([1, 4]))).toBe(2);
  });

  test('a disabled entry listed twice or beyond the rack does not shrink the count', () => {
    expect(usablePositionCount(grid([1, 99, 99]))).toBe(3);
    expect(usablePositionCount(grid([2, 2]))).toBe(3);
  });

  test('with a fill order, counts the order\'s positions that are not disabled', () => {
    expect(usablePositionCount(grid([1]), [4, 3, 2, 1])).toBe(3);
    expect(usablePositionCount(grid([1]), [1, 2])).toBe(1);
  });
});
