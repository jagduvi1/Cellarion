/**
 * scripts/align-cru-appellations against a REAL MongoDB.
 *
 * WHY THIS TEST EXISTS:
 * The script rewrites the two keys a wine is found by. A dry run must write
 * nothing; --apply must do exactly the three moves (the curated list, the
 * Burgundy spellings, the Champagne crus) and leave everything else as it
 * was, down to the classification of a Burgundy wine it respells; a wine
 * whose new key another wine holds is a twin for a person to merge, reported
 * and never written; and a second run must find nothing to do. Only real
 * documents and the real unique index show that. The curated docs it leaves
 * behind are then read by the real resolver, which is what makes "Corton"
 * typed tomorrow land on "Corton Grand Cru".
 *
 * Needs CONTRACT_MONGO_URI (CI provides one); it uses its own database,
 * `cellarion_contract_cruscript`, dropped before and after. Skipped without it.
 */
process.env.MEILI_MASTER_KEY = process.env.MEILI_MASTER_KEY || 'cru-script-key-0123456789abcdef0';
process.env.MEILI_URL = 'http://127.0.0.1:1';

// The Meilisearch client is ESM-only (Jest cannot load it); nothing here searches.
jest.mock('meilisearch', () => ({
  Meilisearch: class {
    index() { return {}; }
    health() { return Promise.reject(new Error('no search in this test')); }
  },
}));

const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const mongoose = require('mongoose');
const { seedCruFixture } = require('./align-cru-appellations.fixtures');
const { alignCruAppellations, VINEYARDS, canonicalName } = require('./align-cru-appellations');
const { resolveCanonicalAppellation } = require('../services/appellationResolve');
const Appellation = require('../models/Appellation');
const { normalizeAppellationKey } = require('../utils/normalize');

const BASE_URI = process.env.CONTRACT_MONGO_URI;
const URI = BASE_URI ? (() => { const u = new URL(BASE_URI); u.pathname = '/cellarion_contract_cruscript'; return u.toString(); })() : null;
const describeWithMongo = URI ? describe : describe.skip;
if (!URI) console.warn('scripts/align-cru-appellations.mongo.test.js skipped: set CONTRACT_MONGO_URI to run it');
jest.setTimeout(60000);

const run = promisify(execFile);
const SCRIPT = path.join(__dirname, 'align-cru-appellations.js');

describeWithMongo('align-cru-appellations (real MongoDB)', () => {
  let fx; let db;
  const quiet = () => {};
  const dump = async () => JSON.stringify({
    wines: await db.collection('winedefinitions').find({}).sort({ _id: 1 }).toArray(),
    list: await db.collection('appellations').find({}).sort({ _id: 1 }).toArray(),
  });
  const wine = (key) => db.collection('winedefinitions').findOne({ _id: fx.ids[key] });
  const listNames = async () => (await Appellation.find({}).select('name').lean()).map((d) => d.name).sort();
  const ids = (rows) => rows.map(String);

  beforeAll(async () => {
    await mongoose.connect(URI);
    if (!mongoose.connection.db.databaseName.startsWith('cellarion_contract')) throw new Error('refusing to use a database not named cellarion_contract*');
    await mongoose.connection.db.dropDatabase();
    db = mongoose.connection.db;
    // The unique key the script must never trip over.
    await db.collection('winedefinitions').createIndex({ normalizedKey: 1 }, { unique: true });
    fx = await seedCruFixture();
  }, 120000);

  afterAll(async () => {
    await mongoose.connection.db.dropDatabase();
    await mongoose.disconnect();
  }, 60000);

  test('a dry run writes nothing and says what it would do', async () => {
    const before = await dump();
    const lines = [];
    const report = await alignCruAppellations({ apply: false, log: (l) => lines.push(l) });
    expect(await dump()).toBe(before);
    expect(report.apply).toBe(false);
    expect(report.list.created).toHaveLength(28);
    expect(report.list.respelled).toEqual(expect.arrayContaining([
      { from: 'Bonnes Mares Grand Cru', to: 'Bonnes-Mares Grand Cru' },
      { from: 'Batard-Montrachet', to: 'Bâtard-Montrachet Grand Cru' },
    ]));
    expect(report.list.removed).toEqual(['Champagne Premier Cru']);
    expect(report.list.kept).toEqual([{ name: 'Champagne Grand Cru', wines: 1 }]);
    expect(report.burgundy.map((w) => w.id).sort()).toEqual(ids([
      fx.ids.cortonBare, fx.ids.closVougeot, fx.ids.echezeaux, fx.ids.bonnesMares, fx.ids.laTache, fx.ids.batard,
      fx.ids.pendingMusigny, fx.ids.profileInSync, fx.ids.profileStale,
    ]).sort());
    expect(report.champagne.map((w) => w.id).sort()).toEqual(ids([
      fx.ids.grandCru, fx.ids.premierCruWithTier, fx.ids.premierCruStated, fx.ids.grandCruFreeText, fx.ids.grandCruTermed,
    ]).sort());
    expect(report.mergeCandidates).toHaveLength(2);
    expect(lines.join('\n')).toMatch(/Summary \(DRY RUN\)/);
  });

  test('the command line is a dry run unless --apply is passed', async () => {
    const before = await dump();
    const { stdout } = await run(process.execPath, [SCRIPT], { env: { ...process.env, MONGO_URI: URI }, timeout: 120000 });
    expect(stdout).toMatch(/Mode: DRY RUN/);
    expect(stdout).toMatch(/Merge candidates/);
    expect(await dump()).toBe(before);
  }, 180000);

  describe('--apply', () => {
    let report; let backupRows;

    beforeAll(async () => {
      backupRows = [];
      report = await alignCruAppellations({ apply: true, log: quiet, backup: { append: (row) => backupRows.push(row) } });
    }, 120000);

    test('the curated list holds one entry per vineyard, named "<Vineyard> Grand Cru", with its synonyms', async () => {
      const names = await listNames();
      for (const v of VINEYARDS) expect(names).toContain(canonicalName(v));
      expect(names).not.toContain('Bonnes Mares Grand Cru');
      expect(names).not.toContain('Batard-Montrachet');
      const corton = await Appellation.findOne({ name: 'Corton Grand Cru' }).lean();
      expect(corton.synonyms).toEqual(['Corton']);
      expect(corton.normalizedSynonyms).toEqual(['corton']);
      const vougeot = await Appellation.findOne({ name: 'Clos de Vougeot Grand Cru' }).lean();
      expect(vougeot.synonyms).toEqual(['Clos de Vougeot', 'Clos Vougeot', 'Clos Vougeot Grand Cru']);
      expect(String(vougeot.country)).toBe(String(fx.france._id));
      expect(String(vougeot.region)).toBe(String(fx.burgundy._id));
      const batard = await Appellation.findOne({ name: 'Bâtard-Montrachet Grand Cru' }).lean();
      expect(batard.normalizedName).toBe('batard montrachet grand cru');
      expect(batard.synonyms).toEqual(['Bâtard-Montrachet']);
      // Every other entry is as it was.
      for (const kept of ['Corton-Le Rognet Grand Cru', 'Chablis Grand Cru', 'Gevrey-Chambertin', 'Gevrey-Chambertin Premier Cru', 'Puligny-Montrachet', 'Grande Champagne', 'Champagne']) {
        expect(names).toContain(kept);
      }
    });

    test('Burgundy wines get the canonical spelling and both keys follow; the classification is untouched', async () => {
      const corton = await wine('cortonBare');
      expect(corton).toMatchObject({
        appellation: 'Corton Grand Cru', classification: 'Grand Cru',
        normalizedKey: 'domaine albrand:clos des aubepines:corton grand cru',
      });
      expect(corton.canonicalKey.endsWith(':corton grand cru')).toBe(true);
      expect(ids(corton.classifications)).toEqual([String(fx.tiers.grandCru._id)]);

      expect(await wine('closVougeot')).toMatchObject({ appellation: 'Clos de Vougeot Grand Cru', normalizedKey: 'domaine bertholon:cuvee brume:clos de vougeot grand cru' });
      // The fold already read this spelling as the canonical one: the keys do not move.
      const echezeaux = await wine('echezeaux');
      expect(echezeaux).toMatchObject({ appellation: 'Échezeaux Grand Cru', classification: 'Old Vines', normalizedKey: 'domaine corbinet:vieilles vignes:echezeaux grand cru' });
      expect(await wine('bonnesMares')).toMatchObject({ appellation: 'Bonnes-Mares Grand Cru', normalizedKey: 'domaine delacourt:cuvee dentelle:bonnesmares grand cru' });
      expect(await wine('laTache')).toMatchObject({ appellation: 'La Tâche Grand Cru', normalizedKey: 'domaine eymardin:cuvee ecume:la tache grand cru' });
      expect(await wine('batard')).toMatchObject({ appellation: 'Bâtard-Montrachet Grand Cru', classification: null });
      const pending = await wine('pendingMusigny');
      expect(pending).toMatchObject({ appellation: 'Musigny Grand Cru', pendingIdentity: true, normalizedKey: `pending~${fx.member._id}:cuvee lumiere:musigny grand cru`, canonicalKey: ':cuvee lumiere:musigny grand cru' });
    });

    test('what is not one of the 32, or is already canonical, is not touched', async () => {
      for (const [key, appellation] of [['rognet', 'Corton-Le Rognet Grand Cru'], ['chablis', 'Chablis Grand Cru'], ['gevreyPremier', 'Gevrey-Chambertin Premier Cru'], ['musignyCanonical', 'Musigny Grand Cru'], ['italianCorton', 'Corton']]) {
        const w = await wine(key);
        expect(w.appellation).toBe(appellation);
        expect(backupRows.some((r) => r._id === String(w._id))).toBe(false);
      }
      expect((await wine('gevreyPremier')).classification).toBe('Premier Cru');
      expect(report.needsAPerson.map((n) => n.text).join('\n')).toMatch(/Cantina Marchaisy "Riserva Matinale".*not a wine of France/);
      // A producer typed as a vineyard's name is named, and its wine is left alone.
      expect(report.needsAPerson.map((n) => n.text).join('\n')).toMatch(/the producer "Musigny" \(1 wine\) is spelled like the appellation "Musigny Grand Cru"/);
      expect(await wine('producerIsVineyard')).toMatchObject({ producer: 'Musigny', appellation: 'Chambolle-Musigny' });
    });

    test('Champagne wines are stored as Champagne, the cru added to the tiers they had', async () => {
      const grandCru = await wine('grandCru');
      expect(grandCru).toMatchObject({ appellation: 'Champagne', classification: 'Grand Cru', normalizedKey: 'maison pelissac:cuvee prairie:champagne' });
      expect(grandCru.canonicalKey.endsWith(':champagne')).toBe(true);
      expect(ids(grandCru.classifications)).toEqual([String(fx.tiers.grandCru._id)]);

      const withTier = await wine('premierCruWithTier');
      expect(withTier).toMatchObject({ appellation: 'Champagne', classification: 'Premier Cru, Old Vines' });
      expect(ids(withTier.classifications)).toEqual([String(fx.tiers.premierCru._id), String(fx.tiers.oldVines._id)]);

      const stated = await wine('premierCruStated');
      expect(stated).toMatchObject({ appellation: 'Champagne', classification: 'Premier Cru' });
      expect(ids(stated.classifications)).toEqual([String(fx.tiers.premierCru._id)]);

      const freeText = await wine('grandCruFreeText');
      expect(freeText).toMatchObject({ appellation: 'Champagne', classification: 'Grand Cru, Old Vines' });

      // The label sweetness suffix stays on both keys.
      const termed = await wine('grandCruTermed');
      expect(termed.normalizedKey).toBe('maison taillandes:cuvee tonnerre:champagne#sw=brut');
      expect(termed.canonicalKey.endsWith(':champagne#sw=brut')).toBe(true);
    });

    test('a named village, Cognac, the plain appellation and a canary are left as they were', async () => {
      for (const [key, appellation] of [['bouzy', 'Champagne Grand Cru (Bouzy)'], ['cognac', 'Grande Champagne'], ['fineChampagne', 'Fine Champagne'], ['plainChampagne', 'Champagne'], ['canary', 'Champagne Grand Cru']]) {
        const w = await wine(key);
        expect(w.appellation).toBe(appellation);
        expect(w.classification).toBeNull();
        expect(backupRows.some((r) => r._id === String(w._id))).toBe(false);
      }
      expect(report.needsAPerson.map((n) => n.text).join('\n')).toMatch(/Maison Vasselot "Cuvée Voilure".*"Champagne Grand Cru \(Bouzy\)"/);
    });

    test('a twin is reported with both rows and their bottles, and neither row is written', async () => {
      expect((await wine('twinCru')).appellation).toBe('Champagne Grand Cru');
      expect((await wine('twinBare')).appellation).toBe('Corton');
      expect((await wine('twinChampagne')).appellation).toBe('Champagne');
      const champagne = report.mergeCandidates.find((m) => m.family === 'champagne');
      expect(champagne).toEqual({
        family: 'champagne', wouldBe: 'Champagne',
        wine: { id: String(fx.ids.twinCru), producer: 'Maison Urbanet', name: 'Cuvée Ultime', appellation: 'Champagne Grand Cru', bottles: 2 },
        twin: { id: String(fx.ids.twinChampagne), producer: 'Maison Urbanet', name: 'Cuvée Ultime', appellation: 'Champagne', bottles: 1 },
      });
      const burgundy = report.mergeCandidates.find((m) => m.family === 'burgundy');
      expect(burgundy).toMatchObject({
        wouldBe: 'Corton Grand Cru',
        wine: { id: String(fx.ids.twinBare), appellation: 'Corton', bottles: 1 },
        twin: { id: String(fx.ids.twinCanonical), appellation: 'Corton Grand Cru', bottles: 0 },
      });
      expect(report.mergeCandidates).toHaveLength(2);
    });

    test('a cru entry leaves the list once no wine is on it, and stays while a twin is', async () => {
      const names = await listNames();
      expect(names).not.toContain('Champagne Premier Cru');
      expect(names).toContain('Champagne Grand Cru');
      expect(report.list.kept).toEqual([{ name: 'Champagne Grand Cru', wines: 1 }]);
    });

    test('a profile generated from the record moves along; a stale one stays stale', async () => {
      const { profileInputsSnapshot } = require('../services/enrichmentJob');
      const inSync = await wine('profileInSync');
      expect(inSync.appellation).toBe('Richebourg Grand Cru');
      expect(inSync.aiProfile.inputsSnapshot).toBe(profileInputsSnapshot(inSync));
      const stale = await wine('profileStale');
      expect(stale.appellation).toBe('Richebourg Grand Cru');
      expect(stale.aiProfile.inputsSnapshot).not.toBe(profileInputsSnapshot(stale));
    });

    test('every row it wrote was backed up first, with the values it had', async () => {
      const row = backupRows.find((r) => r._id === String(fx.ids.grandCru));
      expect(row).toMatchObject({ kind: 'wine', appellation: 'Champagne Grand Cru', classification: null, normalizedKey: 'maison pelissac:cuvee prairie:champagne grand cru' });
      expect(backupRows.filter((r) => r.kind === 'wine')).toHaveLength(report.burgundy.length + report.champagne.length);
      expect(backupRows.some((r) => r.kind === 'appellation' && r.removed && r.name === 'Champagne Premier Cru')).toBe(true);
    });

    test('the resolver now reads the bare name and the variants as the canonical spelling', async () => {
      for (const [typed, canonical] of [
        ['Corton', 'Corton Grand Cru'], ['corton grand cru', 'Corton Grand Cru'], ['Clos Vougeot', 'Clos de Vougeot Grand Cru'],
        ['Echezeaux', 'Échezeaux Grand Cru'], ['Bonnes Mares', 'Bonnes-Mares Grand Cru'], ['La Tache', 'La Tâche Grand Cru'],
        ['Le Montrachet', 'Montrachet Grand Cru'], ['Mazy-Chambertin Grand Cru', 'Mazis-Chambertin Grand Cru'],
      ]) {
        expect([typed, await resolveCanonicalAppellation(typed)]).toEqual([typed, canonical]);
      }
      for (const typed of ['Corton-Le Rognet Grand Cru', 'Chablis Grand Cru', 'Gevrey-Chambertin Premier Cru', 'Gevrey-Chambertin', 'Puligny-Montrachet', 'Grande Champagne']) {
        expect(await resolveCanonicalAppellation(typed)).toBe(typed);
      }
      // No two list entries answer to one key: the resolver adopts nothing where they would.
      const keys = new Map();
      for (const d of await Appellation.find({}).lean()) {
        for (const k of [normalizeAppellationKey(d.name), ...(d.normalizedSynonyms || [])]) {
          expect([k, keys.get(k) || d.name]).toEqual([k, d.name]);
          keys.set(k, d.name);
        }
      }
    });

    test('a second --apply run changes nothing', async () => {
      const before = await dump();
      const again = await alignCruAppellations({ apply: true, log: quiet, backup: { append: () => { throw new Error('nothing should be written'); } } });
      expect(again.changes).toBe(0);
      expect(again.burgundy).toEqual([]);
      expect(again.champagne).toEqual([]);
      expect(again.list).toMatchObject({ created: [], respelled: [], synonyms: [], folded: [], removed: [] });
      // The twins are still there for a person: findings, not changes.
      expect(again.mergeCandidates).toHaveLength(2);
      expect(await dump()).toBe(before);
    });

    test('once the Champagne twin is merged, the next run moves nothing else and takes the last cru entry off the list', async () => {
      await db.collection('winedefinitions').deleteOne({ _id: fx.ids.twinCru });
      const after = await alignCruAppellations({ apply: true, log: quiet });
      expect(after.list.removed).toEqual(['Champagne Grand Cru']);
      expect(after.champagne).toEqual([]);
      expect(await listNames()).not.toContain('Champagne Grand Cru');
    });
  });
});
