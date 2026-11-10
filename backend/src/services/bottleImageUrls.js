// The image fields of a bottle list: which picture each card shows.
//
// One function for the cellar page, the cross-cellar list, a vintage page,
// the on-order list, GET /api/bottles, the offline snapshot and the
// integration inventory, so a card shows the same picture wherever the bottle
// is listed. routes/cellars.js re-exports it for the routes that reach it
// through that router.

const Bottle = require('../models/Bottle');
const BottleImage = require('../models/BottleImage');
const { photoVintage, vintageKey } = require('../utils/imageVintage');
const { findVintageOfficials } = require('./vintageImages');

/**
 * Attach the per-bottle image fields a card reads: the viewer's chosen
 * default image, their own photos (also the not-yet-approved ones), the
 * vintage's official photo with its credit, and their photo of another
 * vintage as the last resort. `bottles` are lean; returns a new array with
 * pendingImageUrl, defaultImageUrl, vintageImageUrl, vintageImageCredit and
 * otherVintageImageUrl on each. Callers: the list routes in routes/cellars.js
 * and routes/bottles.js, routes/offline.js and routes/inventory.js.
 */
async function attachBottleImageUrls(bottles, userId) {
  if (!bottles.length) return bottles;
  const bottleIds = bottles.map(b => b._id);

  // Matched by bottle OR by wine, mirroring the single-bottle route. A photo
  // taken while adding five bottles of the same wine is linked to exactly one
  // of them, so matching on bottle alone would leave the other four blank in
  // every list, while the bottle page, which matches on wineDefinition, shows
  // the photo on all five: one bottle, two answers depending on the page.
  const wineIdOf = (b) => b.wineDefinition && (b.wineDefinition._id || b.wineDefinition);
  const wineIds = [...new Set(bottles.map(wineIdOf).filter(Boolean).map(String))];

  // Sibling bottles: the viewer's OTHER bottles of the same wines, whether or
  // not they are on this page. A photo uploaded while the bottle still waited
  // for its wine request carries no wineDefinition at all, so the by-wine
  // arm never sees it — the photo's bottle is the only
  // way to learn its wine.
  const wineOfBottle = {};
  // …and each bottle's vintage, so a photo pinned to a sibling counts as a
  // photo of THAT bottle's vintage even before the row carries its own tag
  // (rows written before BottleImage.vintage existed, until the boot backfill).
  const vintageOfBottle = {};
  for (const b of bottles) {
    const w = wineIdOf(b);
    if (w) wineOfBottle[b._id.toString()] = w.toString();
    vintageOfBottle[b._id.toString()] = photoVintage(b.vintage);
  }
  if (wineIds.length) {
    try {
      const siblings = await Bottle.find({ user: userId, wineDefinition: { $in: wineIds } }).select('_id wineDefinition vintage').lean();
      for (const s of siblings) {
        if (s.wineDefinition) wineOfBottle[s._id.toString()] = s.wineDefinition.toString();
        vintageOfBottle[s._id.toString()] = photoVintage(s.vintage);
      }
    } catch (err) {
      // A photo nicety must never take the cellar list down.
      console.error('Sibling photo lookup failed:', err.message);
    }
  }
  const imageBottleIds = Object.keys(wineOfBottle).length ? Object.keys(wineOfBottle) : bottleIds.map(String);
  // A Set, not includes(): the inventory's include=consumed hands over a whole
  // drinking history, and a scan per bottle grew with the square of it.
  const listed = new Set(imageBottleIds);
  for (const id of bottleIds.map(String)) if (!listed.has(id)) { listed.add(id); imageBottleIds.push(id); }

  const pendingImages = await BottleImage.find({
    $or: [
      { bottle: { $in: imageBottleIds } },
      ...(wineIds.length ? [{ wineDefinition: { $in: wineIds } }] : []),
    ],
    uploadedBy: userId,
    // The uploader's OWN photos, pending OR approved. Approval must not drop
    // a photo out of this lookup, or the moment an admin approves it the card
    // goes blank unless the wine has a registry image — while the bottle page
    // gallery still lists it. Rejected stays out.
    status: { $in: ['uploaded', 'processing', 'processed', 'approved'] },
    // Never a label scan. The raw frame handed to
    // the AI scanner is kept ONLY as private curation evidence (models/
    // BottleImage.kind); it carries the wine it minted, sits at status
    // 'uploaded' with no processed file, and so would match the by-wine arm
    // above — the scanner's kitchen-table photo would become the card image of
    // every bottle of that wine. `$ne`, not `kind: 'bottle'`: rows older than the field
    // have no `kind` at all.
    kind: { $ne: 'label-scan' },
  }).sort({ createdAt: -1 }).lean();

  // Which picture a card shows — a new vintage without an image displays the
  // wine's image, so a card always shows an image when one exists. In order:
  //   1. the bottle's starred photo (defaultImageUrl, below)
  //   2. the viewer's own photo of THIS bottle — choosing a per-bottle photo
  //      must never appear to do nothing
  //   3. the viewer's own photo of the same vintage (a sibling bottle's)
  //   4. the vintage's official photo (vintageImageUrl)
  //   5. the wine's registry image (wineDefinition.image, on the client)
  //   6. the viewer's own photo of another vintage (otherVintageImageUrl) —
  //      only reached when the wine has no registry image, so a card with any
  //      photo of the wine is never blank
  // 2–3 go out as pendingImageUrl. A photo of the 2015 label never stands in
  // for the 2016 bottles while the wine has an image.
  const pendingByBottle = {};
  const pendingByWineVintage = {};
  const pendingByWine = {};
  for (const img of pendingImages) {
    const url = img.processedUrl || img.originalUrl;
    if (!url) continue;
    if (img.bottle && !pendingByBottle[img.bottle.toString()]) {
      pendingByBottle[img.bottle.toString()] = url;
    }
    // The wine the photo belongs to: its own reference, else its bottle's;
    // its vintage: its own tag, else its bottle's.
    const imgWine = (img.wineDefinition && img.wineDefinition.toString()) || (img.bottle && wineOfBottle[img.bottle.toString()]) || null;
    const imgVintage = photoVintage(img.vintage) || (img.bottle ? vintageOfBottle[img.bottle.toString()] : null) || null;
    if (imgWine && imgVintage && !pendingByWineVintage[vintageKey(imgWine, imgVintage)]) {
      pendingByWineVintage[vintageKey(imgWine, imgVintage)] = url;
    }
    if (imgWine && !pendingByWine[imgWine]) {
      pendingByWine[imgWine] = url;
    }
  }

  // The vintage official of each (wine, vintage) on this page: the photo of
  // that vintage an admin approved first (or chose), by anyone, with its
  // credit. One query for the page.
  let officials = new Map();
  const vintagesWanted = [...new Set(bottles.map(b => photoVintage(b.vintage)).filter(Boolean))];
  try {
    officials = await findVintageOfficials(wineIds, vintagesWanted);
  } catch (err) {
    // A photo nicety must never take the cellar list down.
    console.error('Vintage photo lookup failed:', err.message);
  }

  const defaultImageIds = bottles.filter(b => b.defaultImage).map(b => b.defaultImage);
  const defaultImages = defaultImageIds.length > 0
    ? await BottleImage.find({ _id: { $in: defaultImageIds } }).lean()
    : [];
  const defaultImageMap = {};
  for (const img of defaultImages) {
    defaultImageMap[img._id.toString()] = img.processedUrl || img.originalUrl;
  }

  return bottles.map(b => {
    const wineId = wineIdOf(b);
    const vintage = photoVintage(b.vintage);
    const vkey = wineId && vintage ? vintageKey(wineId.toString(), vintage) : null;
    const official = vkey ? officials.get(vkey) : null;
    const own = pendingByBottle[b._id.toString()] || (vkey ? pendingByWineVintage[vkey] : null) || null;
    return {
      ...b,
      pendingImageUrl: own,
      defaultImageUrl: b.defaultImage ? (defaultImageMap[b.defaultImage.toString()] || null) : null,
      vintageImageUrl: official ? official.url : null,
      vintageImageCredit: official ? official.credit : null,
      otherVintageImageUrl: !own && wineId ? (pendingByWine[wineId.toString()] || null) : null,
    };
  });
}

module.exports = { attachBottleImageUrls };
