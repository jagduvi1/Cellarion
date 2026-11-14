/**
 * A small registry in the state scripts/align-cru-appellations.js exists
 * for, written into the open (throwaway) database: a curated appellation
 * list that holds "Champagne Grand Cru" / "Champagne Premier Cru" and some of
 * the Côte d'Or grand crus under mixed spellings, and wines on every
 * spelling the script moves, leaves alone or reports. Producers and wine
 * names are invented. Used by align-cru-appellations.mongo.test.js.
 *
 * Wines are inserted raw, with the keys the rules BEFORE the alignment wrote
 * (the typed appellation in the last segment), so no model hook tidies them
 * on the way in.
 */
const mongoose = require('mongoose');
const Country = require('../models/Country');
const Region = require('../models/Region');
const Appellation = require('../models/Appellation');
const User = require('../models/User');
const Classification = require('../models/Classification');
const { seedClassifications, classificationString } = require('../services/classificationOps');
const { normalizeString, normalizeWineName, normalizeAppellation, normalizeAppellationKey, normalizeProducerKey, pendingProducerKey } = require('../utils/normalize');
const { profileInputsSnapshot } = require('../services/enrichmentJob');

const oid = () => new mongoose.Types.ObjectId();

/** The keys as they were written when the appellation segment was the typed value. */
const keysBefore = (name, producer, appellation) => ({
  normalizedKey: `${normalizeString(producer)}:${normalizeWineName(name)}:${normalizeString(appellation || '')}`,
  canonicalKey: `${normalizeProducerKey(producer) || normalizeString(producer)}:${normalizeWineName(name)}:${normalizeString(normalizeAppellation(appellation || '') || '')}`,
});

async function seedCruFixture() {
  const db = mongoose.connection.db;
  const admin = await User.create({ username: 'curator', email: 'curator@contract.test', password: 'Contract-Test-Passw0rd!', roles: ['user', 'admin'] });
  const member = await User.create({ username: 'member', email: 'member@contract.test', password: 'Contract-Test-Passw0rd!' });
  const france = await Country.create({ name: 'France', normalizedName: 'france', createdBy: admin._id });
  const italy = await Country.create({ name: 'Italy', normalizedName: 'italy', createdBy: admin._id });
  const burgundy = await Region.create({ name: 'Burgundy', normalizedName: 'burgundy', country: france._id, createdBy: admin._id });
  const champagne = await Region.create({ name: 'Champagne', normalizedName: 'champagne', country: france._id, createdBy: admin._id });
  await seedClassifications();
  const tier = async (name) => Classification.findOne({ name }).lean();
  const grandCru = await tier('Grand Cru');
  const premierCru = await tier('Premier Cru');
  const oldVines = await tier('Old Vines');

  // The curated list, as a registry that grew by hand holds it.
  const entry = (name, region, extra = {}) => ({ name, normalizedName: normalizeAppellationKey(name), country: france._id, region: region ? region._id : null, createdBy: admin._id, ...extra });
  for (const doc of [
    entry('Champagne', champagne), entry('Champagne Grand Cru', champagne), entry('Champagne Premier Cru', champagne),
    entry('Corton Grand Cru', burgundy), entry('Musigny Grand Cru', burgundy), entry('Bonnes Mares Grand Cru', burgundy),
    entry('Batard-Montrachet', burgundy), entry('Corton-Le Rognet Grand Cru', burgundy), entry('Chablis Grand Cru', burgundy),
    entry('Gevrey-Chambertin', burgundy), entry('Gevrey-Chambertin Premier Cru', burgundy), entry('Puligny-Montrachet', burgundy),
    entry('Grande Champagne', null),
  ]) await Appellation.create(doc);

  const ids = {};
  const wines = [];
  const wine = (key, producer, name, appellation, over = {}) => {
    const _id = oid();
    ids[key] = _id;
    const doc = {
      _id, name, producer, country: france._id, region: null, appellation, type: 'red', grapes: [],
      classification: null, classifications: [], createdBy: admin._id, createdAt: new Date(), updatedAt: new Date(),
      ...keysBefore(name, producer, appellation), ...over,
    };
    wines.push(doc);
    return doc;
  };
  const tiers = (...rows) => ({ classification: classificationString(rows), classifications: rows.map((r) => r._id) });

  // ── Burgundy ──────────────────────────────────────────────────────────────
  wine('cortonBare', 'Domaine Albrand', 'Clos des Aubépines', 'Corton', { region: burgundy._id, ...tiers(grandCru) });
  wine('closVougeot', 'Domaine Bertholon', 'Cuvée Brume', 'Clos Vougeot Grand Cru', { region: burgundy._id });
  wine('echezeaux', 'Domaine Corbinet', 'Vieilles Vignes', 'Echézeaux Grand Cru', { region: burgundy._id, ...tiers(oldVines) });
  wine('bonnesMares', 'Domaine Delacourt', 'Cuvée Dentelle', 'Bonnes Mares Grand Cru', { region: burgundy._id });
  wine('laTache', 'Domaine Eymardin', 'Cuvée Écume', 'La Tâche', { region: burgundy._id });
  wine('batard', 'Domaine Fauchelot', 'Cuvée Falaise', 'Batard-Montrachet', { region: burgundy._id, type: 'white' });
  // A real twin: the same wine once as "Corton", once as "Corton Grand Cru".
  wine('twinBare', 'Domaine Girodet', 'Cuvée Givre', 'Corton', { region: burgundy._id });
  wine('twinCanonical', 'Domaine Girodet', 'Cuvée Givre', 'Corton Grand Cru', { region: burgundy._id });
  // Left alone: a climat entry of its own, another region's grand cru, a premier cru, a canonical spelling.
  wine('rognet', 'Domaine Hautval', 'Cuvée Horizon', 'Corton-Le Rognet Grand Cru', { region: burgundy._id });
  wine('chablis', 'Domaine Isnardy', 'Cuvée Ivoire', 'Chablis Grand Cru', { region: burgundy._id, type: 'white' });
  wine('gevreyPremier', 'Domaine Jourdel', 'Cuvée Jardin', 'Gevrey-Chambertin Premier Cru', { region: burgundy._id, ...tiers(premierCru) });
  wine('musignyCanonical', 'Domaine Kerlanec', 'Cuvée Kiosque', 'Musigny Grand Cru', { region: burgundy._id });
  // A pending row keeps its per-creator key namespace (a private draft's
  // `draft~` key has its last segment replaced the same way).
  wine('pendingMusigny', '', 'Cuvée Lumière', 'Musigny', {
    pendingIdentity: true, createdBy: member._id,
    normalizedKey: `${pendingProducerKey(member._id)}:${normalizeWineName('Cuvée Lumière')}:musigny`,
    canonicalKey: `:${normalizeWineName('Cuvée Lumière')}:musigny`,
  });
  // A producer typed exactly as a vineyard's name: now an appellation spelling too.
  wine('producerIsVineyard', 'Musigny', 'Cuvée Hameau', 'Chambolle-Musigny', { region: burgundy._id });
  // Not a wine of France: a person looks at it.
  wine('italianCorton', 'Cantina Marchaisy', 'Riserva Matinale', 'Corton', { country: italy._id });
  // A profile generated from the record as it stands moves along; a stale one does not.
  const inSync = wine('profileInSync', 'Domaine Noirotte', 'Cuvée Nuage', 'Richebourg', { region: burgundy._id });
  inSync.aiProfile = { description: 'An invented profile.', inputsSnapshot: profileInputsSnapshot(inSync) };
  const stale = wine('profileStale', 'Domaine Orsandre', 'Cuvée Orage', 'Richebourg', { region: burgundy._id });
  stale.aiProfile = { description: 'An invented profile.', inputsSnapshot: profileInputsSnapshot({ ...stale, name: 'Another name' }) };

  // ── Champagne ─────────────────────────────────────────────────────────────
  const fizz = { region: champagne._id, type: 'sparkling' };
  wine('grandCru', 'Maison Pelissac', 'Cuvée Prairie', 'Champagne Grand Cru', fizz);
  wine('premierCruWithTier', 'Maison Quenardy', 'Cuvée Quartz', 'Champagne Premier Cru', { ...fizz, ...tiers(oldVines) });
  wine('premierCruStated', 'Maison Roussange', 'Cuvée Rivage', 'Champagne 1er Cru', { ...fizz, ...tiers(premierCru) });
  wine('grandCruFreeText', 'Maison Sauvagny', 'Cuvée Sillage', 'champagne grand cru', { ...fizz, classification: 'Vieilles Vignes' });
  // The label sweetness suffix rides on the key and stays there.
  const termed = wine('grandCruTermed', 'Maison Taillandes', 'Cuvée Tonnerre', 'Champagne Grand Cru', fizz);
  termed.normalizedKey += '#sw=brut';
  termed.canonicalKey += '#sw=brut';
  // A real twin: once as "Champagne Grand Cru", once as "Champagne".
  wine('twinCru', 'Maison Urbanet', 'Cuvée Ultime', 'Champagne Grand Cru', fizz);
  wine('twinChampagne', 'Maison Urbanet', 'Cuvée Ultime', 'Champagne', { ...fizz, ...tiers(grandCru) });
  // Left alone: a named village, Cognac, the plain appellation, a canary.
  wine('bouzy', 'Maison Vasselot', 'Cuvée Voilure', 'Champagne Grand Cru (Bouzy)', fizz);
  wine('cognac', 'Maison Wuillemet', 'XO', 'Grande Champagne', { type: 'white' });
  wine('fineChampagne', 'Maison Xanthier', 'VSOP', 'Fine Champagne', { type: 'white' });
  wine('plainChampagne', 'Maison Yvernaud', 'Cuvée Zénith', 'Champagne', fizz);
  wine('canary', 'Maison Zellerin', 'Cuvée Alizé', 'Champagne Grand Cru', { ...fizz, canary: true });

  await db.collection('winedefinitions').insertMany(wines);

  // Bottles on the twins, so the report can say how many each holds.
  const cellar = oid();
  const bottle = (wineDefinition) => ({ _id: oid(), wineDefinition, user: member._id, cellar, vintage: '2015', status: 'active', createdAt: new Date() });
  await db.collection('bottles').insertMany([
    bottle(ids.twinCru), bottle(ids.twinCru), bottle(ids.twinChampagne), bottle(ids.twinBare),
  ]);

  return { ids, admin, member, france, italy, burgundy, champagne, tiers: { grandCru, premierCru, oldVines } };
}

module.exports = { seedCruFixture };
