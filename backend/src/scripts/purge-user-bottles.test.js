/**
 * scripts/purge-user-bottles — every bottle goes through the app's own delete
 * cascade, and the user's "Recently deleted" is emptied the way the trash
 * purge does it. Models and the two services mocked; the script's loop is
 * what is tested here (purge-user-bottles.mongo.test.js runs it for real).
 */
jest.mock('../models/Bottle', () => ({ find: jest.fn() }));
jest.mock('../models/BottleImage', () => ({ countDocuments: jest.fn() }));
jest.mock('../models/DeletedBottle', () => ({ countDocuments: jest.fn() }));
jest.mock('../models/Rack', () => ({ countDocuments: jest.fn() }));
jest.mock('../services/bottleOps', () => ({ removeBottleCascade: jest.fn() }));
jest.mock('../services/bottleTrash', () => ({ purgeTrashRows: jest.fn() }));
jest.mock('../services/audit', () => ({ logAudit: jest.fn() }));

const Bottle = require('../models/Bottle');
const BottleImage = require('../models/BottleImage');
const DeletedBottle = require('../models/DeletedBottle');
const Rack = require('../models/Rack');
const { removeBottleCascade } = require('../services/bottleOps');
const { purgeTrashRows } = require('../services/bottleTrash');
const { logAudit } = require('../services/audit');
const { OWN_PHOTO, REGISTRY_PHOTO } = require('../services/photoRetention');
const { purgeUserBottles } = require('./purge-user-bottles');

const oid = (c) => c.repeat(24);
const user = { _id: oid('u'), username: 'tester', email: 'tester@example.test' };
const bottles = [
  { _id: oid('1'), status: 'active', cellar: oid('c') },
  { _id: oid('2'), status: 'drank', cellar: oid('c') },
  { _id: oid('3'), status: 'ordered', cellar: oid('d') },
];

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  Bottle.find.mockResolvedValue(bottles);
  BottleImage.countDocuments.mockImplementation(async (q) => (q.$or === OWN_PHOTO.$or ? 4 : 2));
  DeletedBottle.countDocuments.mockResolvedValue(5);
  Rack.countDocuments.mockResolvedValue(1);
  removeBottleCascade.mockResolvedValue({ removed: true });
  purgeTrashRows.mockResolvedValue(5);
});

afterEach(() => jest.restoreAllMocks());

test('a dry run reports and deletes nothing', async () => {
  const r = await purgeUserBottles(user);
  expect(r).toMatchObject({
    bottles: 3,
    byStatus: { active: 1, drank: 1, ordered: 1 },
    cellars: 2,
    ownPhotos: 4,
    registryPhotos: 2,
    racks: 1,
    trash: 5,
  });
  expect(removeBottleCascade).not.toHaveBeenCalled();
  expect(purgeTrashRows).not.toHaveBeenCalled();
  expect(logAudit).not.toHaveBeenCalled();
});

test('the photo counts use the shared retention rule', async () => {
  await purgeUserBottles(user);
  const ids = bottles.map((b) => b._id);
  expect(BottleImage.countDocuments).toHaveBeenCalledWith({ bottle: { $in: ids }, ...OWN_PHOTO });
  expect(BottleImage.countDocuments).toHaveBeenCalledWith({ bottle: { $in: ids }, ...REGISTRY_PHOTO });
  expect(DeletedBottle.countDocuments).toHaveBeenCalledWith({ user: user._id });
});

test('--confirm runs the delete cascade once per bottle document, any status', async () => {
  const r = await purgeUserBottles(user, { confirm: true });
  expect(Bottle.find).toHaveBeenCalledWith({ user: user._id });
  expect(removeBottleCascade).toHaveBeenCalledTimes(3);
  bottles.forEach((b, i) => {
    expect(removeBottleCascade).toHaveBeenNthCalledWith(i + 1, b, null, 'bottle.delete',
      { anyStatus: true, auditDetail: { via: 'purge-user-bottles' } });
  });
  expect(r).toMatchObject({ removed: 3, failed: 0 });
});

test('--confirm then empties the user\'s trash and audits it', async () => {
  const r = await purgeUserBottles(user, { confirm: true });
  expect(purgeTrashRows).toHaveBeenCalledWith({ user: user._id });
  expect(purgeTrashRows.mock.invocationCallOrder[0])
    .toBeGreaterThan(removeBottleCascade.mock.invocationCallOrder[2]);
  expect(logAudit).toHaveBeenCalledWith(null, 'bottle.trash_purge',
    { type: 'user', id: user._id }, { bottles: 5, via: 'purge-user-bottles' });
  expect(r.trashPurged).toBe(5);
});

test('an empty trash writes no trash audit row', async () => {
  purgeTrashRows.mockResolvedValue(0);
  await purgeUserBottles(user, { confirm: true });
  expect(logAudit).not.toHaveBeenCalled();
});

test('a bottle the cascade refuses is reported and the loop goes on', async () => {
  removeBottleCascade
    .mockResolvedValueOnce({ removed: true })
    .mockResolvedValueOnce({ error: { status: 400, message: 'refused' } })
    .mockResolvedValueOnce({ removed: true });
  const r = await purgeUserBottles(user, { confirm: true });
  expect(removeBottleCascade).toHaveBeenCalledTimes(3);
  expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(String(bottles[1]._id)));
  expect(r).toMatchObject({ removed: 2, failed: 1 });
  expect(purgeTrashRows).toHaveBeenCalled();
});
