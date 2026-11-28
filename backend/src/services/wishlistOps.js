/**
 * Wishlist items — the ONE implementation behind REST POST/PUT/DELETE
 * /api/wishlist and the MCP tools add_to_wishlist / update_wishlist_item /
 * remove_from_wishlist (mcp/tools/personal.js).
 *
 * The caller resolves the wine first — REST through services/wineCommit, MCP
 * through mcp/mintWine — and calls parseNewItemFields BEFORE that: a refusal
 * of the item's own fields after a mint would leave the orphan registry row
 * mint-at-commit exists to prevent.
 *
 * Returns { error: { status, message, code?, existingId? } } | { item } like
 * pickListOps. `code` is set where the REST answer carries an error code;
 * `existingId` names the item a 409 duplicate collided with.
 */
const mongoose = require('mongoose');
const WishlistItem = require('../models/WishlistItem');
const { logAudit } = require('./audit');
const { errorBody } = require('../config/errorCodes');
const { normalizeShopUrl } = require('../utils/shopUrl');

const PRIORITIES = ['low', 'medium', 'high'];
const STATUSES = ['wanted', 'bought'];
const NOTES_MAX = 2000;
const VINTAGE_MAX = 20;

// What a wishlist response may say about a registry wine. Never createdBy,
// scanImage, normalizedKey or canonicalKey: a pending row's normalizedKey IS
// `pending~<creator-id>:…`, so a bare populate handed out another user's id.
const WINE_RESPONSE_SELECT =
  'name producer slug type colour appellation classification country region grapes image communityRating aiProfile lwin pendingIdentity';

const err = (status, message, extra = {}) => ({ error: { status, message, ...extra } });
// REST answers this one with its code (errorBody); MCP sends the English.
const shopUrlInvalid = () => {
  const body = errorBody('wishlist_shop_url_invalid');
  return err(400, body.error, { code: body.code });
};

const populateItem = (id) => WishlistItem.findById(id).populate({
  path: 'wineDefinition',
  select: WINE_RESPONSE_SELECT,
  populate: [{ path: 'country' }, { path: 'region' }, { path: 'grapes' }],
});

const auditDetail = (via, extra = {}) => ({ ...extra, ...(via ? { via } : {}) });

/**
 * Check the fields of a NEW wishlist item. REST POST /api/wishlist and MCP
 * add_to_wishlist call it before any registry work.
 * Returns { fields: { vintage, notes, priority, shopUrl } } | { error }.
 */
function parseNewItemFields({ vintage, notes, priority, shopUrl } = {}) {
  const safeVintage = vintage != null ? String(vintage) : '';
  if (notes != null && typeof notes !== 'string') return err(400, 'Notes must be text');
  if (notes && notes.length > NOTES_MAX) return err(400, `Notes must be ${NOTES_MAX} characters or less`);
  if (priority && !PRIORITIES.includes(priority)) return err(400, 'Priority must be low, medium, or high');
  if (safeVintage.length > VINTAGE_MAX) return err(400, `Vintage must be ${VINTAGE_MAX} characters or less`);
  const shop = normalizeShopUrl(shopUrl);
  if (shop.error) return shopUrlInvalid();
  return {
    fields: {
      vintage: safeVintage || undefined,
      notes: notes || undefined,
      priority: priority || 'medium',
      shopUrl: shop.url || undefined,
    },
  };
}

/**
 * Put a resolved registry wine on the user's wishlist, with fields from
 * parseNewItemFields. REST POST /api/wishlist and MCP add_to_wishlist.
 * A wanted item of the same wine and vintage already there is a 409 naming it.
 * Returns { item } (wine populated) | { error }.
 */
async function addWishlistItem({ req, via }, wineId, fields) {
  // Runs AFTER the caller's resolve on purpose: a freshly MINTED wine cannot
  // have a duplicate item (nothing references its new id yet), so a 409 here
  // only ever follows a resolve-to-existing — no orphan wine is left behind.
  const dupFilter = { user: req.user.id, wineDefinition: wineId, status: 'wanted' };
  if (fields.vintage) dupFilter.vintage = fields.vintage;
  else dupFilter.$or = [{ vintage: null }, { vintage: { $exists: false } }, { vintage: '' }];
  const existing = await WishlistItem.findOne(dupFilter);
  if (existing) return err(409, 'This wine is already on your wishlist', { existingId: existing._id });

  const created = await WishlistItem.create({
    user: req.user.id,
    wineDefinition: wineId,
    vintage: fields.vintage,
    notes: fields.notes,
    shopUrl: fields.shopUrl,
    priority: fields.priority,
  });
  logAudit(req, 'wishlist.add', { type: 'wishlistItem', id: created._id }, auditDetail(via, { wineDefinitionId: String(wineId) }));
  return { item: await populateItem(created._id) };
}

// The user's own item, or the error REST has always answered.
async function findOwnItem(userId, id) {
  if (!mongoose.Types.ObjectId.isValid(id)) return err(400, 'Invalid wishlist item ID');
  const item = await WishlistItem.findById(id);
  if (!item) return err(404, 'Wishlist item not found');
  if (item.user.toString() !== String(userId)) return err(403, 'Access denied');
  return { item };
}

/**
 * Change notes, priority, status, vintage or shopUrl of the user's own item;
 * only the fields present change, null clears one. Marking it bought stamps
 * boughtAt, back to wanted clears it. REST PUT /api/wishlist/:id and MCP
 * update_wishlist_item. Returns { item } (wine populated) | { error }.
 */
async function updateWishlistItem({ req, via }, id, { notes, priority, status, vintage, shopUrl } = {}) {
  const own = await findOwnItem(req.user.id, id);
  if (own.error) return own;
  const { item } = own;

  // null clears a field (mirrors the add's "absent" semantics) — guard before
  // reading .length, and never store the literal string 'null'.
  if (notes !== undefined) {
    const safeNotes = notes != null ? String(notes) : '';
    if (safeNotes.length > NOTES_MAX) return err(400, `Notes must be ${NOTES_MAX} characters or less`);
    item.notes = safeNotes || undefined;
  }
  if (priority !== undefined) {
    if (!PRIORITIES.includes(priority)) return err(400, 'Invalid priority');
    item.priority = priority;
  }
  if (status !== undefined) {
    if (!STATUSES.includes(status)) return err(400, 'Invalid status');
    if (status === 'bought' && item.status !== 'bought') item.boughtAt = new Date();
    if (status === 'wanted') item.boughtAt = null;
    item.status = status;
  }
  if (vintage !== undefined) {
    const safeVin = vintage != null ? String(vintage) : '';
    if (safeVin.length > VINTAGE_MAX) return err(400, 'Vintage too long');
    item.vintage = safeVin || undefined;
  }
  if (shopUrl !== undefined) {
    const shop = normalizeShopUrl(shopUrl);
    if (shop.error) return shopUrlInvalid();
    item.shopUrl = shop.url || undefined;
  }

  await item.save();
  logAudit(req, 'wishlist.update', { type: 'wishlistItem', id: item._id }, auditDetail(via));
  return { item: await populateItem(item._id) };
}

/**
 * Remove the user's own item for good. REST DELETE /api/wishlist/:id and MCP
 * remove_from_wishlist. Returns { removed: { id, wineDefinitionId } } | { error }.
 */
async function removeWishlistItem({ req, via }, id) {
  const own = await findOwnItem(req.user.id, id);
  if (own.error) return own;
  const { item } = own;
  await item.deleteOne();
  logAudit(req, 'wishlist.remove', { type: 'wishlistItem', id: item._id }, auditDetail(via));
  return { removed: { id: item._id, wineDefinitionId: item.wineDefinition } };
}

module.exports = {
  parseNewItemFields, addWishlistItem, updateWishlistItem, removeWishlistItem,
  WINE_RESPONSE_SELECT, PRIORITIES, NOTES_MAX, VINTAGE_MAX,
};
