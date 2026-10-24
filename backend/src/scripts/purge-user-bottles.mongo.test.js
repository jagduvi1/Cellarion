/**
 * scripts/purge-user-bottles against a REAL MongoDB and real files. The
 * script runs the way an operator runs it (its own process, a dry run unless
 * --confirm is passed), and what it leaves behind must equal what the app's
 * own delete paths leave behind for an identical account: DELETE
 * /api/bottles/:id's cascade (services/bottleOps.removeBottleCascade) for
 * every bottle, then the trash purge (services/bottleTrash.purgeTrashRows).
 *
 * Needs a MongoDB and the uploads root the image code is wired to
 * (/app/uploads), so it runs in a node container with the backend mounted at
 * /app: PURGE_TEST_MONGO_URI, whose database name must start with
 * "cellarion_purge_test" (it is dropped before and after). Without it the
 * suite skips with a notice. Against a throwaway mongo:7:
 *   docker network create purge-test
 *   docker run -d --name purge-test-mongo --network purge-test mongo:7
 *   docker run --rm --network purge-test --tmpfs /app/uploads \
 *     -e PURGE_TEST_MONGO_URI=mongodb://purge-test-mongo:27017/cellarion_purge_test \
 *     -v "<repo>/backend:/app" -w /app node:24-alpine \
 *     node node_modules/jest/bin/jest.js src/scripts/purge-user-bottles.mongo.test.js
 *   docker rm -f purge-test-mongo && docker network rm purge-test
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const mongoose = require('mongoose');

const AuditLog = require('../models/AuditLog');
const Bottle = require('../models/Bottle');
const BottleImage = require('../models/BottleImage');
const Cellar = require('../models/Cellar');
const DeletedBottle = require('../models/DeletedBottle');
const JournalEntry = require('../models/JournalEntry');
const Rack = require('../models/Rack');
const User = require('../models/User');
const WineDefinition = require('../models/WineDefinition');
const WineRequest = require('../models/WineRequest');
const WineVintageProfile = require('../models/WineVintageProfile');

const URI = process.env.PURGE_TEST_MONGO_URI;
const UPLOADS = '/app/uploads';
const SCRIPT = path.join(__dirname, 'purge-user-bottles.js');
const run = promisify(execFile);

const describeWithMongo = URI ? describe : describe.skip;
if (!URI) {
  // eslint-disable-next-line no-console
  console.warn('scripts/purge-user-bottles.mongo.test.js skipped: set PURGE_TEST_MONGO_URI to a cellarion_purge_test* database to run it');
}

function assertTestDb() {
  const name = mongoose.connection.db.databaseName;
  if (!name.startsWith('cellarion_purge_test')) {
    throw new Error(`refusing to drop "${name}": the database name must start with cellarion_purge_test`);
  }
}

const oid = () => new mongoose.Types.ObjectId();
const raw = (Model, docs) => Model.collection.insertMany(docs);

/** Write a file under the uploads root; `rel` is the part after /api/uploads/. */
function writeUpload(rel) {
  const file = path.join(UPLOADS, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'x');
}

/** Every upload file whose name starts with `tag`, relative to the uploads root. */
function uploadsOf(tag) {
  const out = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.startsWith(tag)) out.push(path.relative(UPLOADS, full).split(path.sep).join('/'));
    }
  };
  walk(UPLOADS);
  return out.sort();
}

/** The same, with the tag taken out of the names. */
const filesOf = (tag) => uploadsOf(tag).map((rel) => rel.replace(`/${tag}`, '/'));

/**
 * One account with everything a bottle delete touches: a racked bottle with
 * its own photo (original, processed and a thumbnail) and a photo approved
 * as public; a consumed bottle holding the wine's chosen picture and an own
 * photo whose processed file is shared, by import dedup, with that public
 * photo; two bottles (active and on order) waiting on one import request; a
 * bottle in "Recently deleted" with an own and a since-published photo; a
 * tasting note naming a bottle.
 */
async function seedAccount(tag, wineId) {
  const ids = {
    user: oid(), cellar: oid(), rack: oid(), request: oid(), note: oid(),
    b1: oid(), b2: oid(), b3: oid(), b4: oid(), trashed: oid(), trashRow: oid(),
    own: oid(), published: oid(), picture: oid(), dedup: oid(), trashOwn: oid(), trashPublished: oid(),
  };
  const url = (rel) => `/api/uploads/${rel.replace(/([^/]+)$/, `${tag}$1`)}`;
  const now = new Date();

  await raw(User, [{ _id: ids.user, username: `purge${tag}`, email: `purge-${tag}@example.test`, roles: ['user'] }]);
  await raw(Cellar, [{ _id: ids.cellar, user: ids.user, name: 'Test cellar' }]);
  await raw(Bottle, [
    { _id: ids.b1, user: ids.user, cellar: ids.cellar, wineDefinition: wineId, vintage: '2015', status: 'active' },
    { _id: ids.b2, user: ids.user, cellar: ids.cellar, wineDefinition: wineId, vintage: '2015', status: 'drank' },
    { _id: ids.b3, user: ids.user, cellar: ids.cellar, pendingWineRequest: ids.request, vintage: '2019', status: 'active' },
    { _id: ids.b4, user: ids.user, cellar: ids.cellar, pendingWineRequest: ids.request, vintage: '2019', status: 'ordered' },
  ]);
  await raw(Rack, [{ _id: ids.rack, cellar: ids.cellar, user: ids.user, name: 'Rack', slots: [{ position: 1, bottle: ids.b1 }] }]);
  await raw(WineRequest, [{ _id: ids.request, user: ids.user, wineName: 'Imported wine', status: 'pending' }]);
  await raw(BottleImage, [
    { _id: ids.own, bottle: ids.b1, uploadedBy: ids.user, kind: 'bottle', status: 'pending', visibility: 'private',
      originalUrl: url('originals/own.jpg'), processedUrl: url('processed/own.webp') },
    { _id: ids.published, bottle: ids.b1, wineDefinition: wineId, uploadedBy: ids.user, kind: 'bottle',
      status: 'approved', visibility: 'public', originalUrl: null, processedUrl: url('processed/shared.webp') },
    { _id: ids.picture, bottle: ids.b2, wineDefinition: wineId, uploadedBy: ids.user, kind: 'bottle',
      status: 'approved', visibility: 'private', assignedToWine: true, originalUrl: null, processedUrl: url('processed/picture.webp') },
    { _id: ids.dedup, bottle: ids.b2, uploadedBy: ids.user, kind: 'bottle', status: 'approved', visibility: 'private',
      originalUrl: url('originals/dedup.jpg'), processedUrl: url('processed/shared.webp') },
    { _id: ids.trashOwn, bottle: ids.trashed, uploadedBy: ids.user, kind: 'bottle', status: 'pending', visibility: 'private',
      originalUrl: null, processedUrl: url('processed/trash.webp') },
    { _id: ids.trashPublished, bottle: ids.trashed, wineDefinition: wineId, uploadedBy: ids.user, kind: 'bottle',
      status: 'approved', visibility: 'public', originalUrl: null, processedUrl: url('processed/trashpub.webp') },
  ]);
  await raw(DeletedBottle, [{
    _id: ids.trashRow, user: ids.user, cellar: ids.cellar, deletedBy: ids.user, bottleId: ids.trashed,
    wineDefinition: wineId, batchId: oid(), snapshot: { bottle: { _id: ids.trashed } },
    deletedAt: now, purgeAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
  }]);
  await raw(JournalEntry, [{ _id: ids.note, user: ids.user, pairings: [{ bottle: ids.b1, wine: wineId, vintage: '2015' }] }]);

  for (const rel of ['originals/own.jpg', 'processed/own.webp', 'thumbs/processed/own.webp.webp',
    'processed/shared.webp', 'thumbs/processed/shared.webp.webp', 'processed/picture.webp',
    'thumbs/processed/picture.webp.webp', 'originals/dedup.jpg', 'processed/trash.webp', 'processed/trashpub.webp']) {
    writeUpload(rel.replace(/([^/]+)$/, `${tag}$1`));
  }
  const imageIds = [ids.own, ids.published, ids.picture, ids.dedup, ids.trashOwn, ids.trashPublished];
  return { tag, ids, imageIds, email: `purge-${tag}@example.test` };
}

/** What is left of an account, in the seed's own names. */
async function stateOf(acc) {
  const names = new Map(Object.entries(acc.ids).map(([k, v]) => [String(v), k]));
  const name = (id) => (id == null ? null : names.get(String(id)) || 'other');
  const all = (Model, filter) => Model.collection.find(filter).toArray();
  const images = await all(BottleImage, { _id: { $in: acc.imageIds } });
  return {
    bottles: (await all(Bottle, { user: acc.ids.user })).map((b) => name(b._id)).sort(),
    rackSlots: (await all(Rack, { _id: acc.ids.rack })).flatMap((r) => r.slots.map((s) => name(s.bottle))),
    images: Object.fromEntries(images.map((i) => [name(i._id), name(i.bottle)])),
    requests: (await all(WineRequest, { _id: acc.ids.request })).map((r) => r.status),
    trash: (await all(DeletedBottle, { user: acc.ids.user })).map((r) => name(r.bottleId)),
    notes: (await all(JournalEntry, { user: acc.ids.user })).map((j) => name(j.pairings[0].bottle)),
    files: filesOf(acc.tag),
  };
}

/** Every document in the database, and every upload file. */
async function everything() {
  const db = mongoose.connection.db;
  const out = {};
  for (const { name } of await db.listCollections().toArray()) {
    out[name] = JSON.stringify(await db.collection(name).find().sort({ _id: 1 }).toArray());
  }
  out.files = uploadsOf('');
  return out;
}

const purge = (email, ...flags) => run(process.execPath, [SCRIPT, '--user', email, ...flags], {
  env: { ...process.env, MONGO_URI: URI },
  timeout: 100000,
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 500));

describeWithMongo('purge-user-bottles on a real database', () => {
  let wineId;
  let script;
  let app;
  let bystander;

  beforeAll(async () => {
    try {
      fs.mkdirSync(UPLOADS, { recursive: true });
      fs.accessSync(UPLOADS, fs.constants.W_OK);
    } catch {
      throw new Error(`${UPLOADS} must be writable: run this suite in a container with the backend at /app`);
    }
    await mongoose.connect(URI);
    assertTestDb();
    await mongoose.connection.dropDatabase();

    wineId = oid();
    await raw(WineDefinition, [{ _id: wineId, name: 'Test Wine', producer: 'Test Producer' }]);
    await raw(WineVintageProfile, [{ wineDefinition: wineId, vintage: '2015', status: 'reviewed' }]);

    // Someone else's bottle and photo of the same wine, which no purge may touch.
    bystander = { user: oid(), cellar: oid(), bottle: oid(), photo: oid() };
    await raw(User, [{ _id: bystander.user, username: 'bystander', email: 'bystander@example.test', roles: ['user'] }]);
    await raw(Cellar, [{ _id: bystander.cellar, user: bystander.user, name: 'Other cellar' }]);
    await raw(Bottle, [{ _id: bystander.bottle, user: bystander.user, cellar: bystander.cellar, wineDefinition: wineId, vintage: '2015', status: 'active' }]);
    await raw(BottleImage, [{ _id: bystander.photo, bottle: bystander.bottle, uploadedBy: bystander.user, kind: 'bottle',
      status: 'pending', visibility: 'private', originalUrl: null, processedUrl: '/api/uploads/processed/bystander.webp' }]);
    writeUpload('processed/bystander.webp');

    script = await seedAccount('scr', wineId);
    app = await seedAccount('app', wineId);
  }, 120000);

  afterAll(async () => {
    if (mongoose.connection.readyState === 1) {
      await settle();
      assertTestDb();
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
    for (const tag of ['scr', 'app', 'bystander']) {
      for (const rel of uploadsOf(tag)) fs.rmSync(path.join(UPLOADS, rel), { force: true });
    }
  });

  test('a dry run reports and changes nothing', async () => {
    const before = await everything();
    const { stdout } = await purge(script.email);
    expect(stdout).toMatch(/Bottles: 4 across 1 cellar/);
    expect(stdout).toMatch(/DRY RUN/);
    expect(await everything()).toEqual(before);
  }, 120000);

  test('--confirm leaves exactly what the app\'s own delete paths leave', async () => {
    const bystanderBefore = JSON.stringify(await Promise.all([
      Bottle.collection.findOne({ _id: bystander.bottle }),
      BottleImage.collection.findOne({ _id: bystander.photo }),
    ]));

    // The app: DELETE /api/bottles/:id for every bottle, then the trash purge.
    const { removeBottleCascade } = require('../services/bottleOps');
    const { purgeTrashRows } = require('../services/bottleTrash');
    for (const bottle of await Bottle.find({ user: app.ids.user })) {
      await removeBottleCascade(bottle, null, 'bottle.delete', { anyStatus: true, auditDetail: {} });
    }
    await purgeTrashRows({ user: app.ids.user });

    // The script.
    await purge(script.email, '--confirm');

    const expected = {
      bottles: [],
      rackSlots: [],
      // Registry photos stay, detached; the own photos are gone.
      images: { published: null, picture: null, trashPublished: null },
      requests: [],
      trash: [],
      notes: ['b1'],
      // The shared file stays for the public photo; the own files and the
      // own photo's thumbnail are gone.
      files: [
        'processed/picture.webp',
        'processed/shared.webp',
        'processed/trashpub.webp',
        'thumbs/processed/picture.webp.webp',
        'thumbs/processed/shared.webp.webp',
      ],
    };
    expect(await stateOf(app)).toEqual(expected);
    expect(await stateOf(script)).toEqual(expected);

    // The shared registry rows and the other member's data are untouched.
    expect(await WineDefinition.collection.countDocuments({ _id: wineId })).toBe(1);
    expect(await WineVintageProfile.collection.countDocuments({ wineDefinition: wineId })).toBe(1);
    expect(JSON.stringify(await Promise.all([
      Bottle.collection.findOne({ _id: bystander.bottle }),
      BottleImage.collection.findOne({ _id: bystander.photo }),
    ]))).toBe(bystanderBefore);
    expect(uploadsOf('bystander')).toEqual(['processed/bystander.webp']);
  }, 120000);

  test('--confirm audits every bottle and the emptied trash', async () => {
    const bottleIds = ['b1', 'b2', 'b3', 'b4'].map((k) => script.ids[k]);
    const rows = await AuditLog.collection.find({ action: 'bottle.delete', 'resource.id': { $in: bottleIds } }).toArray();
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.actor.role).toBe('system');
      expect(row.detail).toEqual({ via: 'purge-user-bottles' });
    }
    const trash = await AuditLog.collection.find({ action: 'bottle.trash_purge', 'resource.id': script.ids.user }).toArray();
    expect(trash).toHaveLength(1);
    expect(trash[0].detail).toEqual({ bottles: 1, via: 'purge-user-bottles' });
  });
});
