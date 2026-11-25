/**
 * What a failing sweetness-category read does to the answer that asked for it
 * (services/sweetnessCategory).
 *
 * WHY THIS TEST EXISTS:
 * The category is an extra read beside the read a page is built from. When it
 * fails, a page a member is looking at must still open — and must go out
 * WITHOUT the two keys, never with null: null says "this wine states no
 * sweetness", and the wine record would then offer a style on a wine whose
 * name carries the word. The answers that are kept and tagged (the inventory,
 * the offline copy) must fail instead, so a copy without the reading never
 * stands for one that states none.
 */
const mockFind = jest.fn();
jest.mock('../models/WineDefinition', () => ({ find: (...args) => mockFind(...args) }));
const mockWarn = jest.fn();
jest.mock('./audit', () => ({ logAudit: jest.fn(), logger: { warn: (...args) => mockWarn(...args), info: jest.fn(), error: jest.fn() } }));

const {
  attachSweetnessCategories, attachSweetnessCategoriesIfReadable, readSweetnessCategories,
} = require('./sweetnessCategory');

const ID = '64b0000000000000000000a1';
const down = () => { throw new Error('database away'); };

beforeEach(() => { mockFind.mockReset(); mockWarn.mockReset(); });

test('a page\'s wines go out without the two keys, and the failure is logged with the surface', async () => {
  mockFind.mockImplementation(down);
  const wines = [{ _id: ID, name: 'Riesling trocken' }];
  await expect(attachSweetnessCategoriesIfReadable(wines, 'bottle list')).resolves.toBe(wines);
  expect(wines[0]).not.toHaveProperty('sweetnessCategory');
  expect(wines[0]).not.toHaveProperty('sweetnessCategoryBasis');
  expect(mockWarn).toHaveBeenCalledTimes(1);
  expect(mockWarn.mock.calls[0][0]).toMatchObject({ surface: 'bottle list' });
});

test('a kept answer fails instead: the plain attach and the reader both throw', async () => {
  mockFind.mockImplementation(down);
  await expect(attachSweetnessCategories([{ _id: ID }])).rejects.toThrow('database away');
  await expect(readSweetnessCategories([ID])).rejects.toThrow('database away');
  expect(mockWarn).not.toHaveBeenCalled();
});

test('nothing to read asks the database for nothing', async () => {
  await expect(readSweetnessCategories([])).resolves.toEqual(new Map());
  await expect(readSweetnessCategories(['not-an-id', null, { $ne: null }])).resolves.toEqual(new Map());
  await attachSweetnessCategoriesIfReadable([null, 'an-id-only', { name: 'no id' }], 'bottle');
  expect(mockFind).not.toHaveBeenCalled();
});
