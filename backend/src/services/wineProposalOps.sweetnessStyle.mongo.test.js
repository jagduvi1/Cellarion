/**
 * A sweetness style from filing to the wine, on REAL documents in a REAL
 * MongoDB (services/wineProposalOps, services/wineProposalDecisionOps).
 *
 * WHY THIS TEST EXISTS:
 * The style is the one correction a member's own filing applies on a server
 * that reviews contributions, and only when it fills a blank: a second
 * opinion on a recorded style must wait for a curator, and a filing must
 * never replace one by itself, not even when the wine changed between the
 * filing and its apply. The wine's style is select: false, so every step
 * that judges or writes it has to ask for it; a step that forgets reads "no
 * style" and overwrites. Mocked models cannot show a missing select, a
 * subdocument that does not save, or a claim that is not reverted, which is
 * why this runs on MongoDB.
 *
 * Needs CONTRACT_MONGO_URI (CI provides one); it uses its own database,
 * `cellarion_contract_styleprop`, dropped before and after. Skipped without it.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'style-proposals-'.repeat(4);

// What an applied correction sets off beyond the wine itself: none of it is
// under test, and none of it may reach a network.
jest.mock('meilisearch', () => ({ Meilisearch: class { index() { return {}; } } }));
jest.mock('./search', () => ({ indexWine: jest.fn() }));
jest.mock('./indexNow', () => ({ submitUrls: jest.fn() }));
jest.mock('./embeddingJob', () => ({ reembedActiveVintages: jest.fn().mockResolvedValue(undefined) }));
jest.mock('./enrichmentJob', () => ({ profileInputsSnapshot: jest.fn(() => 'same'), reenrichAfterRecordEdit: jest.fn() }));
jest.mock('./notifications', () => ({ createNotification: jest.fn().mockResolvedValue(undefined) }));
jest.mock('./audit', () => ({ logAudit: jest.fn(), logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn() } }));

const mongoose = require('mongoose');
const sweetness = require('./sweetnessOps');
const ops = require('./wineProposalOps');
const { approveProposal } = require('./wineProposalDecisionOps');
const WineDefinition = require('../models/WineDefinition');
const WineCorrectionProposal = require('../models/WineCorrectionProposal');
const SweetnessTerm = require('../models/SweetnessTerm');
const User = require('../models/User');

const BASE_URI = process.env.CONTRACT_MONGO_URI;
const URI = BASE_URI ? (() => { const u = new URL(BASE_URI); u.pathname = '/cellarion_contract_styleprop'; return u.toString(); })() : null;
const describeWithMongo = URI ? describe : describe.skip;
if (!URI) console.warn('services/wineProposalOps.sweetnessStyle.mongo.test.js skipped: set CONTRACT_MONGO_URI to run it');

const oid = () => new mongoose.Types.ObjectId();
const TRADE_URL = 'https://merchant.example/riesling-kabinett';
const CRITIC_URL = 'https://critic.example/notes/riesling-kabinett';
const REASON = 'The merchant page calls this cuvée feinherb.';

describeWithMongo('a sweetness style from filing to the wine (real MongoDB)', () => {
  const COUNTRY = oid();
  let alice; let bob; let admin; let term;

  // A proven contributor by default: the daily budget is not what most of
  // these cases are about.
  const member = async (username, tier = 'ambassador') => {
    const _id = oid();
    await User.collection.insertOne({ _id, username, email: `${username}@example.test`, roles: ['user'], contribution: { tier } });
    return _id;
  };
  // A member of their own for a case that must not share a budget: a
  // curator's approval moves the earner's tier, and the daily budget with it.
  const fresh = () => member(`member-${oid()}`);
  const wine = (fields = {}) => new WineDefinition({
    name: 'Riesling Kabinett', producer: `Weingut ${oid()}`, type: 'white', country: COUNTRY, createdBy: oid(), normalizedKey: `raw:${oid()}`, ...fields,
  }).save();
  // The wine as stored; a wine without a style has no key at all, read as null.
  const stored = async (id) => {
    const w = await WineDefinition.findById(id).select('+sweetnessStyle').lean();
    return { ...w, sweetnessStyle: w.sweetnessStyle ?? null };
  };
  const file = (userId, wineId, fields, opts = {}) => ops.createFieldCorrection(
    userId, { wineId: String(wineId), fields, reason: REASON, evidenceUrl: opts.evidenceUrl }, { via: opts.via || 'web' },
  );
  const style = (termName, source = 'trade', url = TRADE_URL) => ({ sweetnessStyle: { term: termName, source, url } });
  const asUser = (id, roles = ['user']) => ({ user: { id: String(id), roles } });

  beforeAll(async () => {
    await mongoose.connect(URI);
    if (!mongoose.connection.db.databaseName.startsWith('cellarion_contract')) throw new Error('refusing to use a database not named cellarion_contract*');
    await mongoose.connection.db.dropDatabase();
    await sweetness.ensureSweetnessSeed();
    sweetness.primeSweetnessCache(null);
    await WineCorrectionProposal.init();
    term = (name, scale = 'still') => SweetnessTerm.findOne({ name, scale }).lean();
    alice = await member('alice');
    bob = await member('bob');
    admin = oid();
    await User.collection.insertOne({ _id: admin, username: 'curator', email: 'curator@example.test', roles: ['user', 'admin'] });
  }, 60000);

  afterAll(async () => {
    await mongoose.connection.db.dropDatabase();
    await mongoose.disconnect();
  }, 60000);

  test('a member\'s style on a wine that has none is on the wine at once, and the filing is kept as decided by them', async () => {
    const w = await wine();
    const res = await file(alice, w._id, style('Feinherb'));
    expect(res).toMatchObject({ ok: true, applied: true, appliedBecause: 'sweetness_style' });

    const feinherb = await term('feinherb');
    expect((await stored(w._id)).sweetnessStyle).toEqual({ term: feinherb._id, source: 'trade', url: TRADE_URL });
    const row = await WineCorrectionProposal.findById(res.proposal._id).lean();
    expect(row).toMatchObject({ status: 'approved', appliedNote: 'Applied: sweetness style', reason: REASON });
    expect(String(row.decidedBy)).toBe(String(alice));
    // The table's spelling is what was filed, and the snapshot says the wine had none.
    expect(row.proposedFields.sweetnessStyle).toEqual({ term: 'feinherb', source: 'trade', url: TRADE_URL });
    expect(row.currentSnapshot.sweetnessStyle).toBeNull();
  });

  test('the filing\'s evidence link is the page when the style names none', async () => {
    const w = await wine();
    const res = await file(alice, w._id, { sweetnessStyle: { term: 'feinherb', source: 'trade' } }, { evidenceUrl: CRITIC_URL });
    expect(res.applied).toBe(true);
    expect((await stored(w._id)).sweetnessStyle.url).toBe(CRITIC_URL);
  });

  test('a second opinion waits for a curator, whose approval replaces the recorded style', async () => {
    const w = await wine();
    await file(alice, w._id, style('feinherb'));
    const second = await file(bob, w._id, style('fruchtsüß', 'trade', CRITIC_URL));
    expect(second.ok).toBe(true);
    expect(second.applied).toBeFalsy();
    const pending = await WineCorrectionProposal.findById(second.proposal._id).lean();
    expect(pending.status).toBe('pending');
    expect(pending.currentSnapshot.sweetnessStyle).toBe('feinherb (trade)');
    expect((await term('feinherb'))._id).toEqual((await stored(w._id)).sweetnessStyle.term);

    const outcome = await approveProposal(second.proposal._id, asUser(admin, ['user', 'admin']));
    expect(outcome.status).toBe(200);
    const after = (await stored(w._id)).sweetnessStyle;
    expect(after).toEqual({ term: (await term('fruchtsüß'))._id, source: 'trade', url: CRITIC_URL });
  });

  test('a filing never replaces a recorded style by itself, even when the wine changed before its apply', async () => {
    const w = await wine();
    // Filed over the Bridge, so it waits although the wine has no style yet.
    const relayed = await file(alice, w._id, style('feinherb'), { via: 'bridge' });
    expect(relayed.applied).toBeFalsy();
    // Meanwhile the wine gets a style from an equal source.
    const fruchtsuess = await term('fruchtsüß');
    await WineDefinition.updateOne({ _id: w._id }, { $set: { sweetnessStyle: { term: fruchtsuess._id, source: 'trade', url: CRITIC_URL } } });

    const outcome = await approveProposal(relayed.proposal._id, asUser(alice));
    expect(outcome).toMatchObject({ status: 409, body: { code: 'sweetness_style_needs_review' } });
    expect((await stored(w._id)).sweetnessStyle.term).toEqual(fruchtsuess._id);
    expect((await WineCorrectionProposal.findById(relayed.proposal._id).lean()).status).toBe('pending');
  });

  test('a field amended into the row before the apply claims it keeps the whole row waiting', async () => {
    const w = await wine();
    const relayed = await file(await fresh(), w._id, style('feinherb'), { via: 'bridge' });
    // What a second request of the same member would do in between: a producer rides in.
    await WineCorrectionProposal.updateOne({ _id: relayed.proposal._id }, { $set: { 'proposedFields.producer': 'Weingut Anders' } });
    const producerBefore = (await stored(w._id)).producer;

    const row = await WineCorrectionProposal.findById(relayed.proposal._id).lean();
    const outcome = await approveProposal(relayed.proposal._id, asUser(row.proposer), { onlyFields: ['sweetnessStyle'] });
    expect(outcome).toMatchObject({ status: 409, body: { code: 'proposal_changed' } });
    const after = await stored(w._id);
    expect(after.producer).toBe(producerBefore);
    expect(after.sweetnessStyle).toBeNull();
    expect((await WineCorrectionProposal.findById(relayed.proposal._id).lean()).status).toBe('pending');

    // The same row with the style alone is taken.
    await WineCorrectionProposal.updateOne({ _id: relayed.proposal._id }, { $unset: { 'proposedFields.producer': '' } });
    expect((await approveProposal(relayed.proposal._id, asUser(row.proposer), { onlyFields: ['sweetnessStyle'] })).status).toBe(200);
    expect((await stored(w._id)).sweetnessStyle.source).toBe('trade');
  });

  test('a style filed with another field waits with it, and applies with it on approval', async () => {
    const w = await wine({ appellation: '' });
    const res = await file(alice, w._id, { appellation: 'Mosel', ...style('feinherb') });
    expect(res.ok).toBe(true);
    expect(res.applied).toBeFalsy();
    expect((await stored(w._id)).sweetnessStyle).toBeNull();

    const outcome = await approveProposal(res.proposal._id, asUser(admin, ['user', 'admin']));
    expect(outcome.status).toBe(200);
    expect(outcome.body.appliedNote).toBe('Applied: appellation, sweetness style');
    const after = await stored(w._id);
    expect(after.appellation).toBe('Mosel');
    expect(after.sweetnessStyle.source).toBe('trade');
  });

  test('a style the label\'s own term contradicts is refused at filing, and nothing is filed', async () => {
    const w = await wine({ labelSweetness: (await term('trocken'))._id });
    const before = await WineCorrectionProposal.countDocuments({ wineDefinition: w._id });
    const res = await file(await fresh(), w._id, style('feinherb'));
    expect(res).toMatchObject({ ok: false, code: 'invalid' });
    expect(res.message).toMatch(/the label states "trocken"/);
    expect(await WineCorrectionProposal.countDocuments({ wineDefinition: w._id })).toBe(before);
  });

  test('a term with a legal definition is refused from the trade, and a term of the other scale is refused', async () => {
    const w = await wine();
    const who = await fresh();
    expect(await file(who, w._id, style('halbtrocken', 'trade'))).toMatchObject({ ok: false, code: 'invalid' });
    expect(await file(who, w._id, style('Extra Brut', 'producer'))).toMatchObject({ ok: false, code: 'invalid' });
    expect((await stored(w._id)).sweetnessStyle).toBeNull();
  });

  test('a style that applies at once still spends the daily budget: a new member\'s fourth that day is refused', async () => {
    const newcomer = await member('carol', 'newcomer');
    for (let i = 0; i < 3; i++) {
      const w = await wine();
      expect(await file(newcomer, w._id, style('feinherb'))).toMatchObject({ ok: true, applied: true });
    }
    const fourth = await wine();
    expect(await file(newcomer, fourth._id, style('feinherb'))).toMatchObject({ ok: false, code: 'limit' });
    expect((await stored(fourth._id)).sweetnessStyle).toBeNull();
  });

  test('amending one\'s own waiting suggestion with a style replaces term, source and link together', async () => {
    const w = await wine({ appellation: '' });
    const who = await fresh();
    const first = await file(who, w._id, { appellation: 'Mosel', ...style('feinherb') });
    const again = await file(who, w._id, style('fruchtsüß', 'producer', CRITIC_URL));
    expect(again).toMatchObject({ ok: true, amended: true });
    expect(again.applied).toBeFalsy();
    const row = await WineCorrectionProposal.findById(first.proposal._id).lean();
    expect(row.proposedFields).toEqual({ appellation: 'Mosel', sweetnessStyle: { term: 'fruchtsüß', source: 'producer', url: CRITIC_URL } });
  });
});
