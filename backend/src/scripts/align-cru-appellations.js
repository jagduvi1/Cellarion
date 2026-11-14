/**
 * align-cru-appellations.js
 *
 * One stored form for two families of appellation that the registry held two
 * ways, so one wine could carry two identity keys and the duplicate guard did
 * not see the twin (docs/wine-fields.md):
 *
 *   Champagne. Premier Cru and Grand Cru rate the village, not the
 *   appellation: the appellation is "Champagne" and the cru is a
 *   classification. The write paths now store it that way
 *   (utils/champagneCru, the WineDefinition pre-validate hook, every key
 *   builder); this moves the existing rows and takes "Champagne Grand Cru"
 *   and "Champagne Premier Cru" off the curated appellation list.
 *
 *   The Côte d'Or grand-cru vineyards. Each is an appellation in its own
 *   right, stored as "<Vineyard> Grand Cru", the form the label prints (like
 *   "Chablis Grand Cru"). The bare register name ("Corton") and the known
 *   variants ("Clos Vougeot") are accepted spellings: synonyms on one curated
 *   doc per vineyard, which the write-time resolver
 *   (services/appellationResolve) already follows. This creates or respells
 *   those 32 docs and respells the wines stored under another spelling.
 *
 * What it does, in this order:
 *   1. The curated list: one doc per vineyard, named "<Vineyard> Grand Cru",
 *      with its synonyms. An entry that names the same vineyard under another
 *      spelling is respelled; a second entry for one vineyard is folded into
 *      the first. A synonym another list entry already answers to is not
 *      added, and is listed for a person.
 *   2. Burgundy wines (France) whose appellation resolves to one of the 32
 *      but is not its canonical spelling get the canonical spelling. Their
 *      classification is not touched.
 *   3. Champagne wines on "Champagne Grand Cru", "Champagne Premier Cru" or
 *      "Champagne 1er Cru" get "Champagne", and the cru joins their tiers
 *      through the classification write rule
 *      (services/classificationOps moveChampagneCru).
 *   4. "Champagne Grand Cru" and "Champagne Premier Cru" leave the curated
 *      list once no wine is left on them.
 *
 * The appellation is the last segment of both keys. Each key gets that segment
 * replaced and keeps everything else byte for byte: the producer or the
 * `pending~<creator>` / `draft~<creator>` namespace, the name, the label
 * sweetness suffix. A key that ends in neither the old nor the new segment
 * (written by an older rule) is left as it is. normalizedKey is UNIQUE: a row
 * whose new key another wine already holds is a real twin. It is NOT written;
 * the pair is listed under "merge candidates". This script never merges and
 * never deletes a wine.
 *
 * A value that names a village beside the cru ("Champagne Grand Cru (Bouzy)")
 * is listed under "needs a person" and left as typed. So is a producer typed
 * exactly as a vineyard's name: the name is now an appellation spelling, and
 * the cross-field rule that reads a place in the producer box
 * (utils/crossFieldChecks, producer-is-appellation) will name it.
 *
 * The AI profile reads the appellation and the classification: a row whose
 * profile was in sync gets its snapshot moved along, so the move queues no
 * paid regeneration (the rule of clear-method-appellations.js). On --apply
 * each row is re-indexed in Meili; run the admin embedding job afterwards
 * (the appellation feeds the embed text).
 *
 * Dry-run by default. On --apply: appends each row's old values to an NDJSON
 * backup before writing it (scripts/lib/backupLog: --backup-dir=<dir> or
 * SCRIPT_BACKUP_DIR, default the OS temp dir). A second --apply run changes
 * nothing.
 *
 * Usage:
 *   node src/scripts/align-cru-appellations.js            # dry run
 *   node src/scripts/align-cru-appellations.js --apply    # execute
 */

require('dotenv').config();
const mongoose = require('mongoose');
const WineDefinition = require('../models/WineDefinition');
const Appellation = require('../models/Appellation');
const Country = require('../models/Country');
const Region = require('../models/Region');
const Bottle = require('../models/Bottle');
const User = require('../models/User');
const { normalizeString, normalizeAppellation, normalizeAppellationKey, stripSweetnessKeySegment } = require('../utils/normalize');
const { CHAMPAGNE, champagneCruOf } = require('../utils/champagneCru');
const { candidateKeys } = require('../services/appellationResolve');
const { moveChampagneCru } = require('../services/classificationOps');
const { profileInputsSnapshot } = require('../services/enrichmentJob');
const searchService = require('../services/search');
const { initSearch } = require('./lib/scriptSearch');
const { createBackupLog } = require('./lib/backupLog');

// The 32 grand-cru appellations of the Côte d'Or, as the INAO register names
// them, with the spellings labels and imports use that the appellation key's
// fold does not already cover (it folds case, accents and hyphens: "Echezeaux"
// and "Bonnes Mares" need no entry). The bare name is always a synonym.
const VINEYARDS = [
  { name: 'Chambertin', area: 'nuits' },
  { name: 'Chambertin-Clos de Bèze', area: 'nuits', variants: ['Clos de Bèze'] },
  { name: 'Chapelle-Chambertin', area: 'nuits' },
  { name: 'Charmes-Chambertin', area: 'nuits' },
  { name: 'Griotte-Chambertin', area: 'nuits' },
  { name: 'Latricières-Chambertin', area: 'nuits' },
  { name: 'Mazis-Chambertin', area: 'nuits', variants: ['Mazy-Chambertin'] },
  { name: 'Mazoyères-Chambertin', area: 'nuits' },
  { name: 'Ruchottes-Chambertin', area: 'nuits' },
  { name: 'Clos de la Roche', area: 'nuits' },
  { name: 'Clos Saint-Denis', area: 'nuits', variants: ['Clos St-Denis'] },
  { name: 'Clos des Lambrays', area: 'nuits' },
  { name: 'Clos de Tart', area: 'nuits' },
  { name: 'Bonnes-Mares', area: 'nuits' },
  { name: 'Musigny', area: 'nuits', variants: ['Le Musigny'] },
  { name: 'Clos de Vougeot', area: 'nuits', variants: ['Clos Vougeot'] },
  { name: 'Échezeaux', area: 'nuits' },
  { name: 'Grands-Échezeaux', area: 'nuits' },
  { name: 'Richebourg', area: 'nuits' },
  { name: 'Romanée-Conti', area: 'nuits' },
  { name: 'La Romanée', area: 'nuits' },
  { name: 'La Tâche', area: 'nuits' },
  { name: 'Romanée-Saint-Vivant', area: 'nuits', variants: ['Romanée-St-Vivant'] },
  { name: 'La Grande Rue', area: 'nuits' },
  { name: 'Corton', area: 'beaune' },
  { name: 'Corton-Charlemagne', area: 'beaune' },
  { name: 'Charlemagne', area: 'beaune' },
  { name: 'Montrachet', area: 'beaune', variants: ['Le Montrachet'] },
  { name: 'Bâtard-Montrachet', area: 'beaune' },
  { name: 'Chevalier-Montrachet', area: 'beaune' },
  { name: 'Bienvenues-Bâtard-Montrachet', area: 'beaune' },
  { name: 'Criots-Bâtard-Montrachet', area: 'beaune' },
];

// A village appellation of each half of the Côte d'Or: where the list has no
// grand-cru entry yet to take the region from, a new one sits where these do.
const VILLAGES = { nuits: ['Gevrey-Chambertin', 'Vosne-Romanée', 'Chambolle-Musigny'], beaune: ['Puligny-Montrachet', 'Aloxe-Corton', 'Chassagne-Montrachet'] };

const GRAND_CRU = 'Grand Cru';
const canonicalName = (v) => `${v.name} ${GRAND_CRU}`;

/**
 * The spellings one vineyard's doc answers to besides its own name: the bare
 * register name, each variant, and each variant with "Grand Cru". A spelling
 * whose key is the doc's own key, or repeats an earlier one, is left out.
 */
function synonymsFor(v) {
  const own = normalizeAppellationKey(canonicalName(v));
  const seen = new Set([own]);
  const out = [];
  for (const s of [v.name, ...(v.variants || []).flatMap((x) => [x, `${x} ${GRAND_CRU}`])]) {
    const key = normalizeAppellationKey(s);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

/**
 * `key` with its appellation segment replaced, every other byte kept (the
 * namespace, the name, the label sweetness suffix). The key unchanged when it
 * already ends in `to`; null when it ends in neither (an older rule wrote it,
 * and it is left as it is).
 */
function withAppellationSegment(key, from, to) {
  if (typeof key !== 'string' || !key) return null;
  const bare = stripSweetnessKeySegment(key);
  const cut = bare.lastIndexOf(':');
  if (cut < 0) return null;
  const segment = bare.slice(cut + 1);
  if (segment === to) return key;
  if (segment !== from) return null;
  return `${bare.slice(0, cut + 1)}${to}${key.slice(bare.length)}`;
}

/**
 * The $set that moves one wine to `appellation` (and, for a Champagne move,
 * to the tiers in `classification`): the field, both keys' last segment, and
 * an in-sync profile snapshot. `keysLeft` names a key that ends in neither
 * segment. Pure, so the test pins the decision without a DB.
 */
function planWineMove(row, { appellation, classification }) {
  const $set = { appellation, updatedAt: new Date() };
  const after = { ...row, appellation };
  if (classification) {
    $set.classification = classification.classification;
    $set.classifications = classification.classifications;
    after.classification = classification.classification;
  }
  const keysLeft = [];
  const normalizedKey = withAppellationSegment(row.normalizedKey, normalizeString(row.appellation), normalizeString(appellation));
  if (normalizedKey === null) keysLeft.push('normalizedKey');
  else if (normalizedKey !== row.normalizedKey) $set.normalizedKey = normalizedKey;
  const canonicalKey = withAppellationSegment(
    row.canonicalKey,
    normalizeString(normalizeAppellation(row.appellation) || ''),
    normalizeString(normalizeAppellation(appellation) || ''),
  );
  if (canonicalKey === null) keysLeft.push('canonicalKey');
  else if (canonicalKey !== row.canonicalKey) $set.canonicalKey = canonicalKey;
  const stored = row.aiProfile && row.aiProfile.inputsSnapshot;
  if (stored && stored === profileInputsSnapshot(row)) $set['aiProfile.inputsSnapshot'] = profileInputsSnapshot(after);
  return { $set, keysLeft };
}

// A Champagne value that states a cru and something more: a village in
// brackets, a dosage, the words the other way round.
const CRU_WORDS = /(^|[^\p{L}\p{N}])(grand|premier|1er)\s+cru(?=$|[^\p{L}\p{N}])/iu;
const looksLikeChampagneCru = (appellation) =>
  /(^|[^\p{L}])champagne(?=$|[^\p{L}])/iu.test(appellation) && CRU_WORDS.test(appellation)
  // Cognac's crus are other appellations.
  && !/(grande|petite|fine)\s+champagne/i.test(appellation);

const idOf = (v) => String((v && v._id) || v || '');
const label = (w) => `${w.producer || '(no producer)'} "${w.name}"`;

/** Every curated appellation with its keys, computed here: a stored key from an older fold is not trusted. */
async function loadList() {
  const docs = await Appellation.find({}).select('name country region synonyms createdBy').lean();
  return docs.map((d) => ({
    ...d,
    key: normalizeAppellationKey(d.name),
    synonymKeys: (d.synonyms || []).map(normalizeAppellationKey).filter(Boolean),
  }));
}

/** The region the list's own entries of this half carry, else that of its village appellations, else Burgundy. */
function regionFor(area, list, familyIds, franceId, burgundyId) {
  const tally = (docs) => {
    const counts = new Map();
    for (const d of docs) if (d.region) counts.set(idOf(d.region), (counts.get(idOf(d.region)) || 0) + 1);
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    return top ? top[0] : null;
  };
  const family = list.filter((d) => familyIds.get(idOf(d._id)) === area);
  const villageKeys = new Set(VILLAGES[area].map(normalizeAppellationKey));
  const villages = list.filter((d) => idOf(d.country) === idOf(franceId) && villageKeys.has(d.key));
  const any = list.filter((d) => familyIds.has(idOf(d._id)));
  return tally(family) || tally(villages) || tally(any) || (burgundyId ? idOf(burgundyId) : null);
}

/**
 * Step 1, planned: for each vineyard the doc to create or change, and the
 * map from every accepted key to the canonical spelling. Nothing is written.
 */
function planList(list, franceId, burgundyId) {
  const plans = [];
  const needsAPerson = [];
  const familyIds = new Map(); // doc id → area, for the region vote
  const matches = VINEYARDS.map((v) => {
    const keys = new Set([normalizeAppellationKey(canonicalName(v)), ...synonymsFor(v).map(normalizeAppellationKey)]);
    const own = list.filter((d) => idOf(d.country) === idOf(franceId) && keys.has(d.key));
    for (const d of own) familyIds.set(idOf(d._id), v.area);
    return own;
  });
  const accepted = new Map(); // key → canonical spelling
  VINEYARDS.forEach((v, i) => {
    const name = canonicalName(v);
    const key = normalizeAppellationKey(name);
    const own = matches[i];
    const ownIds = new Set(own.map((d) => idOf(d._id)));
    // The entry that already has the canonical key stays; else the first.
    const keep = own.find((d) => d.key === key) || own[0] || null;
    const fold = own.filter((d) => d !== keep);
    const wanted = [];
    for (const s of [...synonymsFor(v), ...own.flatMap((d) => [d === keep ? null : d.name, ...(d.synonyms || [])]).filter(Boolean)]) {
      const sKey = normalizeAppellationKey(s);
      if (!sKey || sKey === key || wanted.some((w) => normalizeAppellationKey(w) === sKey)) continue;
      const holder = list.find((d) => !ownIds.has(idOf(d._id)) && (d.key === sKey || d.synonymKeys.includes(sKey)));
      if (holder) {
        needsAPerson.push({ kind: 'synonym', text: `"${s}" is not added as a spelling of "${name}": the list entry "${holder.name}" already answers to it` });
        continue;
      }
      wanted.push(s);
    }
    const clash = list.find((d) => !ownIds.has(idOf(d._id)) && (d.key === key || d.synonymKeys.includes(key)));
    if (clash) needsAPerson.push({ kind: 'name', text: `"${name}" shares its key with the list entry "${clash.name}": the resolver adopts neither spelling until one of them goes` });
    accepted.set(key, name);
    for (const s of wanted) accepted.set(normalizeAppellationKey(s), name);
    const have = keep ? (keep.synonyms || []) : [];
    const sameSynonyms = have.length === wanted.length && wanted.every((s) => have.includes(s));
    plans.push({
      vineyard: v, name, key, keep, fold, synonyms: wanted,
      create: !keep,
      rename: !!keep && keep.name !== name,
      synonymsChange: !!keep && !sameSynonyms,
      region: keep ? null : regionFor(v.area, list, familyIds, franceId, burgundyId),
    });
  });
  return { plans, accepted, needsAPerson, familyIds };
}

/** The canonical spelling a stored appellation resolves to among the 32, the way the resolver reads it; null when it is another entry's or nobody's. */
function resolveAmongVineyards(appellation, accepted, others) {
  const key = normalizeAppellationKey(normalizeAppellation(appellation) || appellation);
  if (!key) return null;
  for (const k of candidateKeys(key)) {
    if (accepted.has(k)) return accepted.get(k);
    if (others.has(k)) return null; // another curated entry answers first
  }
  return null;
}

async function bottleCount(wineId) {
  return Bottle.countDocuments({ wineDefinition: wineId });
}

// What planWineMove and profileInputsSnapshot read, and what the report shows.
const WINE_FIELDS = 'name producer country region appellation classification classifications type grapes normalizedKey canonicalKey aiProfile.inputsSnapshot';

/**
 * The whole run against the open connection. `apply` false writes nothing.
 * Returns the report the CLI prints: { list, burgundy, champagne,
 * mergeCandidates, needsAPerson, changes }. Callers: the CLI below and the
 * suite that runs it on a real MongoDB.
 */
async function alignCruAppellations({ apply = false, log = console.log, searchOk = false, backup = { append() {} } } = {}) {
  const tag = apply ? '✔' : '[dry]';
  const report = {
    apply,
    list: { created: [], respelled: [], synonyms: [], folded: [], removed: [], kept: [] },
    burgundy: [], champagne: [], mergeCandidates: [], needsAPerson: [], changes: 0,
  };
  const claimed = new Map(); // a key a row of this run moves to → that row

  const france = await Country.findOne({ normalizedName: 'france' }).select('_id').lean();
  const burgundy = france
    ? await Region.findOne({ country: france._id, $or: [{ normalizedName: { $in: ['burgundy', 'bourgogne'] } }, { normalizedSynonyms: { $in: ['burgundy', 'bourgogne'] } }] }).select('_id').lean()
    : null;
  const list = await loadList();

  // ── 1. The curated list ────────────────────────────────────────────────────
  log('Curated appellation list — the 32 grand-cru vineyards of the Côte d\'Or');
  let accepted = new Map();
  if (!france) {
    log('  France is not in the country list: no list entry is written and no Burgundy wine is respelled.');
  } else {
    const planned = planList(list, france._id, burgundy && burgundy._id);
    accepted = planned.accepted;
    report.needsAPerson.push(...planned.needsAPerson);
    const toWrite = planned.plans.filter((p) => p.create || p.rename || p.synonymsChange || p.fold.length);
    const regionIds = [...new Set(toWrite.filter((p) => p.create && p.region).map((p) => p.region))];
    const regionNames = new Map((await Region.find({ _id: { $in: regionIds } }).select('name').lean()).map((r) => [idOf(r._id), r.name]));
    let admin = null;
    if (apply && toWrite.some((p) => p.create)) {
      admin = await User.findOne({ roles: 'admin' }).select('_id').lean();
      if (!admin) throw new Error('no admin user found (a new list entry needs a createdBy)');
    }
    for (const p of toWrite) {
      for (const d of p.fold) {
        log(`${tag} "${d.name}" folded into "${p.name}" (one entry per vineyard; its spellings stay as synonyms)`);
        report.list.folded.push({ from: d.name, into: p.name });
        report.changes += 1;
        if (apply) {
          backup.append({ kind: 'appellation', removed: true, ...d });
          await Appellation.deleteOne({ _id: d._id });
        }
      }
      if (p.create) {
        log(`${tag} + "${p.name}"  region: ${p.region ? regionNames.get(p.region) || p.region : '(none found)'}  synonyms: ${p.synonyms.map((s) => `"${s}"`).join(', ')}`);
        report.list.created.push(p.name);
        report.changes += 1;
        if (apply) {
          await new Appellation({ name: p.name, normalizedName: p.key, country: france._id, region: p.region, synonyms: p.synonyms, createdBy: admin._id }).save();
        }
        continue;
      }
      if (p.rename) { log(`${tag} "${p.keep.name}"  →  "${p.name}"`); report.list.respelled.push({ from: p.keep.name, to: p.name }); }
      if (p.synonymsChange) { log(`${tag} "${p.name}"  synonyms: ${p.synonyms.map((s) => `"${s}"`).join(', ')}`); report.list.synonyms.push({ name: p.name, synonyms: p.synonyms }); }
      if (p.rename || p.synonymsChange) {
        report.changes += 1;
        if (apply) {
          backup.append({ kind: 'appellation', ...p.keep });
          const doc = await Appellation.findById(p.keep._id);
          doc.name = p.name;
          doc.normalizedName = p.key;
          doc.synonyms = p.synonyms;
          await doc.save();
        }
      }
    }
    if (!toWrite.length) log('  all 32 entries are in place.');
  }

  // Keys other curated entries answer to: the resolver adopts those first.
  const family = new Set([...accepted.keys()]);
  const others = new Set();
  for (const d of list) {
    for (const k of [d.key, ...d.synonymKeys]) if (k && !family.has(k)) others.add(k);
  }

  /** Write one planned move unless its new key is taken; returns whether the row moved. */
  const moveWine = async (w, target, familyName, line) => {
    const { $set, keysLeft } = planWineMove(w, target);
    const newKey = $set.normalizedKey;
    if (newKey) {
      const twin = (claimed.has(newKey) && idOf(claimed.get(newKey)._id) !== idOf(w._id) ? claimed.get(newKey) : null)
        || await WineDefinition.findOne({ normalizedKey: newKey, _id: { $ne: w._id } }).select('name producer appellation').lean();
      if (twin) {
        report.mergeCandidates.push({
          family: familyName, wouldBe: target.appellation,
          wine: { id: idOf(w._id), producer: w.producer || '', name: w.name, appellation: w.appellation, bottles: await bottleCount(w._id) },
          twin: { id: idOf(twin._id), producer: twin.producer || '', name: twin.name, appellation: twin.appellation || null, bottles: await bottleCount(twin._id) },
        });
        return false;
      }
      claimed.set(newKey, w);
    }
    log(`${tag} ${line}${keysLeft.length ? `  [${keysLeft.join(' and ')} left as written]` : ''}`);
    report.changes += 1;
    if (apply) {
      backup.append({
        kind: 'wine', _id: idOf(w._id), appellation: w.appellation, classification: w.classification || null,
        classifications: (w.classifications || []).map(idOf), normalizedKey: w.normalizedKey || null,
        canonicalKey: w.canonicalKey || null, inputsSnapshot: (w.aiProfile && w.aiProfile.inputsSnapshot) || null,
      });
      try {
        await WineDefinition.updateOne({ _id: w._id }, { $set });
      } catch (err) {
        if (err && err.code === 11000) {
          // A wine minted under the new key since the check above: a twin too.
          report.changes -= 1;
          report.mergeCandidates.push({
            family: familyName, wouldBe: target.appellation,
            wine: { id: idOf(w._id), producer: w.producer || '', name: w.name, appellation: w.appellation, bottles: await bottleCount(w._id) },
            twin: { id: null, producer: w.producer || '', name: w.name, appellation: target.appellation, bottles: null },
          });
          return false;
        }
        throw err;
      }
      if (searchOk) await searchService.indexWine(w._id);
    }
    return true;
  };

  // A producer typed exactly as one of the names that are now appellation
  // spellings: read with both folds, as the cross-field rule reads it.
  if (accepted.size) {
    const producers = await WineDefinition.aggregate([
      { $match: { producer: { $nin: [null, ''] }, canary: { $ne: true } } },
      { $group: { _id: '$producer', wines: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]);
    for (const p of producers) {
      const canonical = accepted.get(normalizeAppellationKey(p._id)) || accepted.get(normalizeString(p._id));
      if (canonical) {
        report.needsAPerson.push({ kind: 'producer', text: `the producer "${p._id}" (${p.wines} wine${p.wines === 1 ? '' : 's'}) is spelled like the appellation "${canonical}": the cross-field check "producer is an appellation" names it, and a new wine typed with this producer is filed for a curator. Clear the check on these wines if the estate carries the vineyard's name.` });
      }
    }
  }

  // ── 2. Burgundy wines ──────────────────────────────────────────────────────
  log('\nBurgundy wines — the appellation as "<Vineyard> Grand Cru"');
  if (france && accepted.size) {
    const wines = await WineDefinition.find({ appellation: { $nin: [null, ''] }, canary: { $ne: true } }).select(WINE_FIELDS).lean();
    for (const w of wines) {
      const canonical = resolveAmongVineyards(w.appellation, accepted, others);
      if (!canonical || canonical === w.appellation) continue;
      if (idOf(w.country) !== idOf(france._id)) {
        report.needsAPerson.push({ kind: 'country', text: `${label(w)} (${w._id}) carries "${w.appellation}" but is not a wine of France: left as typed` });
        continue;
      }
      if (await moveWine(w, { appellation: canonical }, 'burgundy', `${label(w)}:  "${w.appellation}"  →  "${canonical}"`)) {
        report.burgundy.push({ id: idOf(w._id), producer: w.producer || '', name: w.name, from: w.appellation, to: canonical });
      }
    }
  }
  if (!report.burgundy.length) log('  nothing to respell.');

  // ── 3. Champagne wines ─────────────────────────────────────────────────────
  log('\nChampagne wines — the appellation "Champagne", the cru as a classification');
  const champagneWines = await WineDefinition.find({ appellation: /champagne/i, canary: { $ne: true } }).select(WINE_FIELDS).lean();
  const stillOnCru = new Map(); // cru → wines that stay on a cru form (their new key is taken)
  for (const w of champagneWines) {
    const cleaned = normalizeAppellation(w.appellation) || w.appellation;
    const cru = champagneCruOf(cleaned);
    if (!cru) {
      if (looksLikeChampagneCru(w.appellation)) {
        report.needsAPerson.push({ kind: 'champagne', text: `${label(w)} (${w._id}): "${w.appellation}" names more than the cru: left as typed` });
      }
      continue;
    }
    const target = { appellation: cleaned, classification: w.classification || null, classifications: (w.classifications || []).slice(), country: w.country };
    await moveChampagneCru(target);
    const tiers = { classification: target.classification, classifications: target.classifications };
    const line = `${label(w)}:  "${w.appellation}"  →  "${CHAMPAGNE}", classification ${w.classification ? `"${w.classification}"` : '(none)'}  →  "${target.classification}"`;
    if (await moveWine(w, { appellation: CHAMPAGNE, classification: tiers }, 'champagne', line)) {
      report.champagne.push({ id: idOf(w._id), producer: w.producer || '', name: w.name, from: w.appellation, cru, classification: target.classification });
    } else {
      stillOnCru.set(cru, (stillOnCru.get(cru) || 0) + 1);
    }
  }
  if (!report.champagne.length) log('  nothing to move.');

  // ── 4. The Champagne cru entries leave the list ────────────────────────────
  log('\nCurated appellation list — the Champagne cru entries');
  const cruDocs = list.filter((d) => champagneCruOf(d.name));
  for (const d of cruDocs) {
    const left = stillOnCru.get(champagneCruOf(d.name)) || 0;
    if (left) {
      log(`  "${d.name}" stays: ${left} wine${left === 1 ? '' : 's'} still on it (merge candidates below). Run again after the merge.`);
      report.list.kept.push({ name: d.name, wines: left });
      continue;
    }
    log(`${tag} − "${d.name}"`);
    report.list.removed.push(d.name);
    report.changes += 1;
    if (apply) {
      backup.append({ kind: 'appellation', removed: true, ...d });
      await Appellation.deleteOne({ _id: d._id });
    }
  }
  if (!cruDocs.length) log('  none on the list.');
  for (const d of list) {
    const swallowed = (d.synonyms || []).filter((s) => champagneCruOf(s));
    if (swallowed.length && !champagneCruOf(d.name)) {
      report.needsAPerson.push({ kind: 'synonym', text: `the list entry "${d.name}" has the synonym ${swallowed.map((s) => `"${s}"`).join(', ')}: the resolver then drops the cru before it can become a classification. Remove the synonym.` });
    }
  }

  // ── The findings ───────────────────────────────────────────────────────────
  log(`\nMerge candidates — not written, the new key belongs to another wine (${report.mergeCandidates.length})`);
  for (const m of report.mergeCandidates) {
    log(`  ⚠ ${m.wine.producer} "${m.wine.name}"  ${m.wine.id} on "${m.wine.appellation}" (${m.wine.bottles} bottle${m.wine.bottles === 1 ? '' : 's'})`);
    log(`      would become "${m.wouldBe}", which is ${m.twin.id || 'a wine added during this run'}${m.twin.id ? ` ${m.twin.producer} "${m.twin.name}" on "${m.twin.appellation || '(none)'}" (${m.twin.bottles} bottle${m.twin.bottles === 1 ? '' : 's'})` : ''}`);
  }
  if (!report.mergeCandidates.length) log('  none.');
  log(`\nNeeds a person (${report.needsAPerson.length})`);
  for (const n of report.needsAPerson) log(`  ✋ ${n.text}`);
  if (!report.needsAPerson.length) log('  none.');

  const done = (n, did, would) => `${n} ${apply ? did : would}`;
  log(`\nSummary (${apply ? 'APPLIED' : 'DRY RUN'}):`);
  log(`  list: ${done(report.list.created.length, 'created', 'to create')}, ${done(report.list.respelled.length, 'respelled', 'to respell')}, ${done(report.list.synonyms.length, 'given synonyms', 'to give synonyms')}, ${done(report.list.folded.length, 'folded into another entry', 'to fold into another entry')}, ${done(report.list.removed.length, 'removed', 'to remove')}${report.list.kept.length ? `, ${report.list.kept.length} kept for now` : ''}`);
  log(`  Burgundy wines: ${done(report.burgundy.length, 'respelled', 'to respell')} (classification untouched)`);
  log(`  Champagne wines: ${done(report.champagne.length, 'moved', 'to move')} to "${CHAMPAGNE}" with the cru as a classification`);
  log(`  merge candidates: ${report.mergeCandidates.length}; needs a person: ${report.needsAPerson.length}`);
  return report;
}

async function run() {
  const apply = process.argv.includes('--apply');
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://mongo:27017/winecellar');
  console.log(`Connected. Mode: ${apply ? 'APPLY' : 'DRY RUN (pass --apply to execute)'}\n`);
  const searchOk = apply ? await initSearch({ label: 'align-cru-appellations' }) : false;
  const backup = createBackupLog('cru-appellations');
  const report = await alignCruAppellations({ apply, searchOk, backup });
  if (apply) backup.report();
  if (apply && (report.burgundy.length || report.champagne.length)) {
    console.log('Next: run the admin embedding job (the appellation feeds the embed text).');
  }
  await mongoose.disconnect();
}

if (require.main === module) {
  run().catch((err) => { console.error('Cru appellation alignment failed:', err); process.exit(1); });
}

module.exports = {
  VINEYARDS, canonicalName, synonymsFor, withAppellationSegment, planWineMove, planList,
  resolveAmongVineyards, looksLikeChampagneCru, alignCruAppellations,
};
