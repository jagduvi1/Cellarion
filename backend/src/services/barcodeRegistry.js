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
// only when more members' bottles carry it there; a catalogue's code is never
// moved by members. A pending or draft wine is not registry content yet, so
// nothing is attached to it.
//
// Bottles keep their own barcode (the member's data, in their export), and
// services/barcodeLookup.js still falls back to them for a code the registry
// does not hold.

const Bottle = require('../models/Bottle');
const User = require('../models/User');
const WineDefinition = require('../models/WineDefinition');
const { logger } = require('./audit');

const MEMBERS = 'members';

/** Member evidence for one code: [{ wine, owners, last, bottleSize }], most owners first. */
async function evidenceFor(code) {
  // Demo accounts are thrown away within hours: their bottles teach nothing.
  const demoIds = await User.distinct('_id', { isDemo: true });
  const rows = await Bottle.aggregate([
    { $match: { barcode: code, user: { $nin: demoIds } } },
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

/**
 * Brings the registry's record of one barcode in line with members' bottles:
 * attaches it to the public wine most members' bottles carry it on, updates
 * its owner count, or moves a member-learned code to a wine with MORE owners.
 * Callers: learnBarcodeSoon / learnBarcodesSoon (bottle add, edit, change wine,
 * a restored cellar) and the one-time backfill at boot.
 * Returns { action: 'added' | 'updated' | 'moved' | 'kept' | 'none' | 'catalogue' }.
 */
async function learnBarcode(code) {
  if (!code) return { action: 'none' };
  const evidence = await evidenceFor(code);
  const publicIds = new Set((await WineDefinition.find({
    _id: { $in: evidence.map((e) => e.wine) }, pendingIdentity: { $ne: true },
  }).select('_id').lean()).map((w) => String(w._id)));
  const candidates = evidence.filter((e) => publicIds.has(e.wine));
  const holder = await WineDefinition.findOne({ 'barcodes.code': code }).select('+barcodes').lean();
  const entry = holder && holder.barcodes.find((b) => b.code === code);

  if (entry && entry.source !== MEMBERS) return { action: 'catalogue' };
  const winner = candidates[0];
  if (!winner) return { action: holder ? 'kept' : 'none' };

  if (holder && String(holder._id) === winner.wine) {
    await WineDefinition.updateOne(
      { _id: holder._id, 'barcodes.code': code },
      { $set: { 'barcodes.$.owners': winner.owners, ...(winner.bottleSize ? { 'barcodes.$.bottleSize': winner.bottleSize } : {}) } },
    );
    return { action: 'updated' };
  }
  if (holder) {
    // Stays with the wine it is on unless more members' bottles say otherwise.
    const holderEvidence = evidence.find((e) => e.wine === String(holder._id));
    if (winner.owners <= (holderEvidence ? holderEvidence.owners : 0)) return { action: 'kept' };
    await WineDefinition.updateOne({ _id: holder._id }, { $pull: { barcodes: { code } } });
  }
  try {
    await WineDefinition.updateOne(
      { _id: winner.wine, 'barcodes.code': { $ne: code } },
      { $push: { barcodes: { code, bottleSize: winner.bottleSize, source: MEMBERS, owners: winner.owners, addedAt: new Date() } } },
    );
  } catch (err) {
    // Another request attached the code first (the unique index): theirs stands.
    if (err && err.code === 11000) return { action: 'kept' };
    throw err;
  }
  return { action: holder ? 'moved' : 'added' };
}

const learnLogged = (code, context) => learnBarcode(code)
  .catch((err) => logger.warn({ err: err.message, code, ...context }, 'barcode registry: could not learn a barcode'));

// Codes being learned right now → whether another save asked again meanwhile.
// A bulk edit saves a case of twelve one by one: that is one run plus at most
// one more (which sees every bottle), not twelve.
const inFlight = new Map();

/**
 * learnBarcode in the background: a bottle save never waits for the registry,
 * and a failure is logged, not thrown. Caller: services/bottleOps.js (add,
 * edit, change wine; a bulk edit saves each bottle through the same edit).
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
 * Caller: services/cellarImport.js (importCellar).
 */
function learnBarcodesSoon(codes, context) {
  const list = [...new Set((codes || []).filter(Boolean))];
  if (!list.length) return;
  (async () => { for (const code of list) await learnLogged(code, context); })();
}

/**
 * Moves a merged-away wine's barcodes onto the keeper (one place for both
 * merge routes: services/wineMergeOps.reassignWineRefs). A code the keeper
 * already holds stays as the keeper has it.
 */
async function moveBarcodes(sourceId, keeperId) {
  const source = await WineDefinition.findById(sourceId).select('+barcodes').lean();
  const entries = (source && source.barcodes) || [];
  if (!entries.length) return 0;
  // Off the source first: one wine per code is enforced by a unique index.
  await WineDefinition.updateOne({ _id: sourceId }, { $unset: { barcodes: 1 } });
  const keeper = await WineDefinition.findById(keeperId).select('+barcodes').lean();
  const held = new Set(((keeper && keeper.barcodes) || []).map((b) => b.code));
  const moving = entries.filter((b) => !held.has(b.code));
  if (moving.length) await WineDefinition.updateOne({ _id: keeperId }, { $push: { barcodes: { $each: moving } } });
  return moving.length;
}

/**
 * Teaches the registry every barcode members' bottles carry. Idempotent.
 * Called once at boot (server.js, marker migration.barcodesOnWine).
 * Returns the count per action.
 */
async function backfillBarcodes() {
  const codes = await Bottle.distinct('barcode', { barcode: { $type: 'string' } });
  const counts = {};
  for (const code of codes) {
    const { action } = await learnBarcode(code);
    counts[action] = (counts[action] || 0) + 1;
  }
  return { codes: codes.length, ...counts };
}

module.exports = { learnBarcode, learnBarcodeSoon, learnBarcodesSoon, moveBarcodes, backfillBarcodes, MEMBERS };
