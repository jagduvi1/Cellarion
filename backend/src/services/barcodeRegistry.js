// Barcodes on the registry wine.
//
// A retail barcode (GTIN) names one product in one bottle size, and producers
// usually keep it from one vintage to the next, so it belongs on the
// vintage-free wine (WineDefinition.barcodes). There it outlives the bottles
// that taught it, and a catalogue can add codes no member has scanned yet.
//
// Members teach it: a bottle added (or edited) with a barcode is evidence that
// the code belongs to that bottle's wine. Evidence is counted per wine as
// DISTINCT OWNERS, so one member's twelve bottles are one vote; who they are
// is never stored. One barcode belongs to one wine (a unique index): the
// public wine most members' bottles carry it on. A code moves to another wine
// only when more members' bottles carry it there than ever confirmed it where
// it is; a catalogue's code is never moved by members. A code only one
// member taught, whose bottles no longer carry it (cleared, corrected,
// deleted), was most likely a mistake and is withdrawn. A pending or draft
// wine is not registry content yet, so nothing is attached to it until it is
// published (models/WineDefinition.js post-save teaches it then).
//
// Bottles keep their own barcode (the member's data, in their export), and
// services/barcodeLookup.js still falls back to them for a code the registry
// does not hold.

const Bottle = require('../models/Bottle');
const User = require('../models/User');
const WineDefinition = require('../models/WineDefinition');
const { logAudit, logger } = require('./audit');

const MEMBERS = 'members';

/** Demo accounts are thrown away within hours: their bottles teach nothing. */
const demoUserIds = () => User.distinct('_id', { isDemo: true });

/** Member evidence for one code: [{ wine, owners, last, bottleSize }], most owners first. */
async function evidenceFor(code, demoIds) {
  const excluded = demoIds || await demoUserIds();
  const rows = await Bottle.aggregate([
    // The $type makes the query match the bottles' partial barcode index
    // (models/Bottle.js); an equality alone does not, and scans every bottle.
    { $match: { barcode: { $eq: code, $type: 'string' }, user: { $nin: excluded } } },
    { $group: { _id: { wine: '$wineDefinition', user: '$user' }, last: { $max: '$createdAt' }, sizes: { $addToSet: '$bottleSize' } } },
    { $group: { _id: '$_id.wine', owners: { $sum: 1 }, last: { $max: '$last' }, sizes: { $push: '$sizes' } } },
  ]);
  return rows
    .filter((r) => r._id)
    .map((r) => {
      const sizes = [...new Set(r.sizes.flat().filter(Boolean))];
      return { wine: String(r._id), owners: r.owners, last: r.last, bottleSize: sizes.length === 1 ? sizes[0] : null };
    })
    .sort((a, b) => (b.owners - a.owners) || (b.last - a.last));
}

// A userless audit row: the registry records what happened to a code, never
// whose bottle taught it.
const audit = (action, wineId, detail, options) => {
  if (options.audit === false) return;
  logAudit(null, action, { type: 'wine', id: wineId }, detail);
};

/** Takes a member-learned code off a wine; a catalogue's entry is never touched. */
const pullMemberCode = (wineId, code) => WineDefinition.updateOne(
  { _id: wineId }, { $pull: { barcodes: { code, source: MEMBERS } } },
);

/**
 * Brings the registry's record of one barcode in line with members' bottles:
 * attaches it to the public wine most members' bottles carry it on, updates
 * its owner count, moves a member-learned code to a wine with MORE owners, or
 * withdraws a one-member code no bottle carries any more.
 * Callers: learnBarcodeSoon / learnBarcodesSoon (bottle add, edit, delete,
 * restore, change wine, a restored cellar, a wine leaving the pending state)
 * and the one-time backfill at boot.
 * Returns { action: 'added' | 'updated' | 'moved' | 'withdrawn' | 'kept' | 'none' | 'catalogue' }.
 */
async function learnBarcode(code, options = {}) {
  if (!code) return { action: 'none' };
  const evidence = await evidenceFor(code, options.demoIds);
  const publicIds = new Set((await WineDefinition.find({
    _id: { $in: evidence.map((e) => e.wine) }, pendingIdentity: { $ne: true },
  }).select('_id').lean()).map((w) => String(w._id)));
  const candidates = evidence.filter((e) => publicIds.has(e.wine));
  const holder = await WineDefinition.findOne({ 'barcodes.code': code }).select('+barcodes').lean();
  const entry = holder && holder.barcodes.find((b) => b.code === code);

  if (entry && entry.source !== MEMBERS) return { action: 'catalogue' };
  const holderLive = holder ? ((evidence.find((e) => e.wine === String(holder._id)) || {}).owners || 0) : 0;
  const withdrawable = Boolean(holder) && holderLive === 0 && (entry.owners || 0) <= 1;
  const winner = candidates[0];

  if (!winner) {
    if (!withdrawable) return { action: holder ? 'kept' : 'none' };
    await pullMemberCode(holder._id, code);
    audit('registry.barcode.withdraw', holder._id, { code }, options);
    return { action: 'withdrawn' };
  }

  if (holder && String(holder._id) === winner.wine) {
    await WineDefinition.updateOne(
      { _id: holder._id, 'barcodes.code': code },
      { $set: { 'barcodes.$.owners': winner.owners, ...(winner.bottleSize ? { 'barcodes.$.bottleSize': winner.bottleSize } : {}) } },
    );
    return { action: 'updated' };
  }
  if (holder) {
    // Stays where it is unless more members' bottles say otherwise than ever
    // confirmed it there: bottles that are gone still counted when they were here.
    const holderWeight = withdrawable ? 0 : Math.max(holderLive, entry.owners || 0);
    if (winner.owners <= holderWeight) return { action: 'kept' };
    await pullMemberCode(holder._id, code);
  }
  const fresh = { code, bottleSize: winner.bottleSize, source: MEMBERS, owners: winner.owners, addedAt: new Date() };
  let attached = false;
  try {
    const r = await WineDefinition.updateOne({ _id: winner.wine, 'barcodes.code': { $ne: code } }, { $push: { barcodes: fresh } });
    attached = r.modifiedCount === 1;
  } catch (err) {
    // Another request attached the code first (the unique index): theirs stands.
    if (!(err && err.code === 11000)) {
      if (holder) await putBack(holder._id, entry);
      throw err;
    }
  }
  if (!attached) {
    // The winner is gone (merged or deleted meanwhile) or someone else holds
    // the code now: the code goes back where it was, if it was anywhere.
    if (holder) await putBack(holder._id, entry);
    return { action: 'kept' };
  }
  audit(holder ? 'registry.barcode.move' : 'registry.barcode.add', winner.wine,
    { code, owners: winner.owners, ...(holder ? { from: String(holder._id) } : {}) }, options);
  return { action: holder ? 'moved' : 'added' };
}

/** Puts a code back on a wine after a failed move, unless another wine took it meanwhile. */
async function putBack(wineId, entry) {
  try {
    await WineDefinition.updateOne({ _id: wineId, 'barcodes.code': { $ne: entry.code } }, { $push: { barcodes: entry } });
  } catch (err) {
    if (!(err && err.code === 11000)) logger.warn({ err: err.message, code: entry.code, wine: String(wineId) }, 'barcode registry: could not put a code back');
  }
}

const learnLogged = (code, context, options) => learnBarcode(code, options)
  .catch((err) => logger.warn({ err: err.message, code, ...context }, 'barcode registry: could not learn a barcode'));

// Codes being learned right now → whether another save asked again meanwhile.
// A bulk edit saves a case of twelve one by one: that is one run plus at most
// one more (which sees every bottle), not twelve.
const inFlight = new Map();

/**
 * learnBarcode in the background: a bottle save never waits for the registry,
 * and a failure is logged, not thrown. Caller: services/bottleOps.js (add,
 * edit, delete, restore, change wine; a bulk edit saves each bottle through
 * the same edit).
 */
function learnBarcodeSoon(code, context) {
  if (!code) return;
  if (inFlight.has(code)) { inFlight.set(code, true); return; }
  inFlight.set(code, false);
  const run = () => learnLogged(code, context).then(() => {
    if (inFlight.get(code)) { inFlight.set(code, false); return run(); }
    inFlight.delete(code);
    return undefined;
  });
  run();
}

/**
 * learnBarcode for many codes, one after another in the background, so a
 * restored cellar of hundreds of bottles is not hundreds of queries at once.
 * Callers: services/cellarImport.js (importCellar) and learnWineBarcodesSoon.
 */
function learnBarcodesSoon(codes, context) {
  const list = [...new Set((codes || []).filter(Boolean))];
  if (!list.length) return;
  (async () => { for (const code of list) await learnLogged(code, context); })();
}

/**
 * Teaches every code on one wine's bottles, in the background: a wine that
 * has just become registry content (published, its identity completed) or a
 * merge's keeper. Callers: models/WineDefinition.js (post-save, on promotion)
 * and services/wineMergeOps.reassignWineRefs.
 */
function learnWineBarcodesSoon(wineId, context) {
  // Never throws, also not synchronously: it runs inside a wine's save hook.
  Promise.resolve()
    .then(() => Bottle.distinct('barcode', { wineDefinition: wineId, barcode: { $type: 'string' } }))
    .then((codes) => learnBarcodesSoon(codes, { wine: String(wineId), ...context }))
    .catch((err) => logger.warn({ err: err.message, wine: String(wineId), ...context }, 'barcode registry: could not read a wine\'s barcodes'));
}

/**
 * Moves a merged-away wine's barcodes onto the keeper, one code at a time (one
 * place for both merge routes: services/wineMergeOps.reassignWineRefs). Each
 * code leaves the source before it joins the keeper (one wine per code, a
 * unique index); a code the keeper already holds stays as the keeper has it,
 * a code another wine took meanwhile stays there, and a code that cannot be
 * written is put back on the source, so a merge run again picks it up.
 * Returns the number of codes the keeper received.
 */
async function moveBarcodes(sourceId, keeperId) {
  const source = await WineDefinition.findById(sourceId).select('+barcodes').lean();
  let moved = 0;
  for (const entry of (source && source.barcodes) || []) {
    await WineDefinition.updateOne({ _id: sourceId }, { $pull: { barcodes: { code: entry.code } } });
    try {
      const r = await WineDefinition.updateOne({ _id: keeperId, 'barcodes.code': { $ne: entry.code } }, { $push: { barcodes: entry } });
      moved += r.modifiedCount;
    } catch (err) {
      if (err && err.code === 11000) continue;
      await putBack(sourceId, entry);
      throw err;
    }
  }
  // A wine without codes carries no barcodes field, as before it had any.
  await WineDefinition.updateOne({ _id: sourceId, barcodes: { $size: 0 } }, { $unset: { barcodes: 1 } });
  return moved;
}

/**
 * Teaches the registry every barcode members' bottles carry. Idempotent; a
 * code that fails is counted and left to the next bottle event, so one bad
 * code never makes every boot start over. Called once at boot (server.js,
 * marker migration.barcodesOnWine). Returns the count per action.
 */
async function backfillBarcodes() {
  const codes = await Bottle.distinct('barcode', { barcode: { $type: 'string' } });
  const demoIds = await demoUserIds();
  const counts = {};
  for (const code of codes) {
    let action = 'failed';
    try {
      ({ action } = await learnBarcode(code, { demoIds, audit: false }));
    } catch (err) {
      logger.warn({ err: err.message, code }, 'barcode registry: backfill could not learn a barcode');
    }
    counts[action] = (counts[action] || 0) + 1;
  }
  return { codes: codes.length, ...counts };
}

module.exports = { learnBarcode, learnBarcodeSoon, learnBarcodesSoon, learnWineBarcodesSoon, moveBarcodes, backfillBarcodes, MEMBERS };
