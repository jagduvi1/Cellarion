/**
 * The "Other" category: a drink that is not wine (cider, beer, spirits, a
 * soft drink) kept in a member's cellar.
 *
 * Cellarion's shared registry is for wine. A drink that is not wine keeps
 * working for the people who hold it — bottles, racks, notes, personal data —
 * but leaves the registry's search, its vectors and the sommelier's maturity
 * queue: the non-wine quarantine (WineDefinition.nonWine), which the app
 * shows as the category "Other" (the type is none). The flag used to be set
 * by curators only, hours after a member had added a cider as "sparkling";
 * now the member says so up front (add form, import, MCP: category "other")
 * or moves a drink to Other from the bottle page, which is what this module
 * does. One quarantine procedure for every path that flags a row.
 */
const Bottle = require('../models/Bottle');
const Cellar = require('../models/Cellar');
const WineDefinition = require('../models/WineDefinition');
const WineEmbedding = require('../models/WineEmbedding');
const WineVintageProfile = require('../models/WineVintageProfile');
const WineCorrectionProposal = require('../models/WineCorrectionProposal');
const { logAudit } = require('./audit');
const { isValidId } = require('../utils/validation');
const { countHoldingMembers, NON_WINE_DIRECT_MAX_OWNERS } = require('./proposalDirectApply');

// The curator reads this on the proposal a member's action files when too
// many members hold the row for the flag to apply on their word alone.
const NOT_WINE_REASON = 'A bottle owner marked this record as a drink that is not wine (cider, beer, spirits or a soft drink), from their bottle page.';

/**
 * Flag a row as not wine and complete the quarantine: it leaves the search
 * index (indexWine owns membership and drops a flagged row), its vectors go
 * (semantic search and the similar-wines graph would keep showing it), and
 * its PENDING maturity rows go (auto-seeded stubs; a REVIEWED window is
 * curated data and stays with the record). Owners keep their bottles.
 *
 * @param {object} wine  a WineDefinition document (saved here)
 * @param {{req?: object, via: string}} opts  via = 'member' | 'mcp' | 'admin' | …
 */
async function quarantineAsNonWine(wine, { req = null, via }) {
  const alreadyFlagged = wine.nonWine === true;
  if (!alreadyFlagged) {
    wine.nonWine = true;
    await wine.save();
  }
  // services/search top-requires the ESM-only meilisearch package: lazy, like
  // every other caller outside the route layer.
  const searchService = require('./search');
  searchService.indexWine(wine._id);
  await WineEmbedding.deleteMany({ wineDefinition: wine._id });
  let pendingRemoved = 0;
  if (!alreadyFlagged) {
    const del = await WineVintageProfile.deleteMany({ wineDefinition: wine._id, status: 'pending' });
    pendingRemoved = del.deletedCount || 0;
  }
  logAudit(req, 'wine.nonWine', { type: 'wine', id: wine._id },
    { value: true, via, name: wine.name, producer: wine.producer || null, pendingRemoved });
  return { alreadyFlagged, pendingRemoved };
}

/** Does this member hold a bottle of the wine, in a cellar of theirs or one shared with them? */
async function holdsBottleOf(userId, wineId) {
  const cellarIds = await Cellar.distinct('_id', {
    deletedAt: null,
    $or: [{ user: userId }, { 'members.user': userId }],
  });
  if (!cellarIds.length) return false;
  return Boolean(await Bottle.exists({ wineDefinition: wineId, cellar: { $in: cellarIds } }));
}

/**
 * A member moves a drink that is not wine to the Other category.
 *
 * Applies at once while at most NON_WINE_DIRECT_MAX_OWNERS members hold
 * bottles of the row (the sommelier's own direct-apply rule): hiding a row
 * from a handful of people on one of their word is reversible and cheap.
 * With more holders it files the same non_wine proposal the sommelier would,
 * and a curator decides. Only a member who holds a bottle of it (or created
 * it) may ask.
 *
 * @returns {Promise<{ok: true, status: 'applied'|'already'|'filed'|'pending', category: 'other'|'wine', holders?: number, pendingRemoved?: number}
 *                 | {ok: false, code: 'invalid'|'not_found'|'forbidden', message: string}>}
 */
async function markNotWineByMember({ wineId, userId, req = null, via = 'member' }) {
  if (!isValidId(String(wineId))) return { ok: false, code: 'invalid', message: 'Invalid wine id' };
  const wine = await WineDefinition.findById(wineId);
  // A private draft is edited by its creator, not quarantined.
  if (!wine || wine.draft === true) return { ok: false, code: 'not_found', message: 'Wine not found' };
  if (wine.nonWine === true) return { ok: true, status: 'already', category: 'other' };

  const holds = String(wine.createdBy || '') === String(userId) || await holdsBottleOf(userId, wine._id);
  if (!holds) {
    return { ok: false, code: 'forbidden', message: 'Only a member who holds a bottle of it can move a drink to Other.' };
  }

  const holders = await countHoldingMembers(wine._id);
  if (holders <= NON_WINE_DIRECT_MAX_OWNERS) {
    const { pendingRemoved } = await quarantineAsNonWine(wine, { req, via });
    return { ok: true, status: 'applied', category: 'other', holders, pendingRemoved };
  }

  try {
    await WineCorrectionProposal.create({
      proposer: userId,
      wineDefinition: wine._id,
      kind: 'non_wine',
      reason: NOT_WINE_REASON,
      currentSnapshot: {
        producer: wine.producer || null,
        name: wine.name || null,
        appellation: wine.appellation || null,
        classification: wine.classification || null,
        type: wine.type || null,
        colour: wine.colour || null,
      },
    });
  } catch (err) {
    // One pending proposal per (wine, kind): somebody — a member or the
    // sommelier — already asked, and a curator has not decided yet.
    if (err && err.code === 11000) return { ok: true, status: 'pending', category: 'wine', holders };
    throw err;
  }
  logAudit(req, 'wine.nonWineProposed', { type: 'wine', id: wine._id },
    { via, holders, name: wine.name, producer: wine.producer || null });
  return { ok: true, status: 'filed', category: 'wine', holders };
}

module.exports = { quarantineAsNonWine, markNotWineByMember, holdsBottleOf, NOT_WINE_REASON };
