/**
 * The label sweetness write rule on REAL documents in a REAL MongoDB.
 *
 * WHY THIS TEST EXISTS:
 * The write tools load a wine's term the way the read shapes need it,
 * populated as 'name band scale regulated -_id' — without its id. The rule
 * must still know that row as the stored term: move it with a new type, not
 * read a name settled on it as a contradiction. A wine whose region is
 * stored as an id must still have its region's name read for the place
 * guard ("Arroyo Seco"). Plain objects in the unit tests stand in for these
 * shapes; only a real populate and a real region row show that they hold.
 *
 * Needs CONTRACT_MONGO_URI (CI provides one); it uses its own database,
 * `cellarion_contract_sweetwrite`, dropped before and after. Skipped without it.
 */
const mongoose = require('mongoose');
const constants = require('../config/constants');
const ops = require('./sweetnessOps');
const { assignSweetness } = require('./sweetnessWrite');
const WineDefinition = require('../models/WineDefinition');
const Region = require('../models/Region');
const SweetnessTerm = require('../models/SweetnessTerm');

const BASE_URI = process.env.CONTRACT_MONGO_URI;
const URI = BASE_URI ? (() => { const u = new URL(BASE_URI); u.pathname = '/cellarion_contract_sweetwrite'; return u.toString(); })() : null;
const describeWithMongo = URI ? describe : describe.skip;
if (!URI) console.warn('services/sweetnessWrite.mongo.test.js skipped: set CONTRACT_MONGO_URI to run it');

const oid = () => new mongoose.Types.ObjectId();
const API_POPULATE = { path: 'labelSweetness', select: 'name band scale regulated -_id' };

describeWithMongo('the label sweetness write rule on real documents (real MongoDB)', () => {
  const COUNTRY = oid();
  const REGION = oid();
  let term;

  beforeAll(async () => {
    await mongoose.connect(URI);
    if (!mongoose.connection.db.databaseName.startsWith('cellarion_contract')) throw new Error('refusing to use a database not named cellarion_contract*');
    await mongoose.connection.db.dropDatabase();
    await ops.ensureSweetnessSeed();
    ops.primeSweetnessCache(null);
    await Region.collection.insertOne({ _id: REGION, name: 'Arroyo Seco', normalizedName: 'arroyo seco', country: COUNTRY });
    term = async (name, scale) => SweetnessTerm.findOne({ name, scale }).lean();
  });

  afterAll(async () => {
    constants.SWEETNESS_EXTRACT_FROM_NAME = false;
    await mongoose.connection.db.dropDatabase();
    await mongoose.disconnect();
  });

  afterEach(() => { constants.SWEETNESS_EXTRACT_FROM_NAME = false; });

  const wine = async (fields) => new WineDefinition({
    producer: 'Weingut Beispiel', country: COUNTRY, createdBy: oid(), normalizedKey: `raw:${oid()}`, ...fields,
  }).save();

  test('a term populated without its id moves with a new type, and the document saves', async () => {
    const trocken = await term('trocken', 'still');
    const sekt = await term('Trocken', 'sparkling');
    const { _id } = await wine({ name: 'Riesling', type: 'white', labelSweetness: trocken._id });
    const doc = await WineDefinition.findById(_id).populate(API_POPULATE);
    expect(doc.labelSweetness._id).toBeUndefined();
    const r = await assignSweetness(doc, { type: 'sparkling' });
    expect(r).toMatchObject({ ok: true, changed: true, review: null });
    doc.type = 'sparkling';
    await doc.save();
    expect(String((await WineDefinition.findById(_id).lean()).labelSweetness)).toBe(String(sekt._id));
  });

  test('a name settled on a term populated without its id is not a contradiction, strict included', async () => {
    constants.SWEETNESS_EXTRACT_FROM_NAME = true;
    const trocken = await term('trocken', 'still');
    const { _id } = await wine({ name: 'Riesling', type: 'white', labelSweetness: trocken._id });
    const doc = await WineDefinition.findById(_id).populate(API_POPULATE);
    expect(await assignSweetness(doc, { name: 'Riesling trocken', strict: true })).toMatchObject({ ok: true, name: 'Riesling', review: null });
    expect(await assignSweetness(doc, { labelSweetness: 'trocken' })).toMatchObject({ ok: true, review: null });
  });

  test('a region stored as an id is read by its name for the place guard', async () => {
    constants.SWEETNESS_EXTRACT_FROM_NAME = true;
    const { _id } = await wine({ name: 'Chardonnay', type: 'white', region: REGION });
    const doc = await WineDefinition.findById(_id);
    const r = await assignSweetness(doc, { name: 'Chardonnay Arroyo Seco' });
    expect(r).toMatchObject({ changed: false, ambiguous: { kind: 'place_word' }, review: { reason: 'name_ambiguous' } });
    expect(doc.labelSweetness).toBeNull();
  });
});
