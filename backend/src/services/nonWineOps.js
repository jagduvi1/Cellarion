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
 * does.
 *
 * ONE quarantine procedure: a member's move is the same non_wine proposal the
 * sommelier files, decided by the same rule (services/proposalDirectApply:
 * direct while at most a few members hold the row) and applied by the same
 * code (routes/admin/wineProposals.approveProposal), so Admin → Proposals
 * shows every move under Decided with its Restore button, and a flag an
 * admin wants to re-seed or revisit has one place to look.
 */
const Bottle = require('../models/Bottle');
const Cellar = require('../models/Cellar');
const WineDefinition = require('../models/WineDefinition');
const WineCorrectionProposal = require('../models/WineCorrectionProposal');
const { logAudit } = require('./audit');
const { isValidId } = require('../utils/validation');
const { classifyProposal, countHoldingMembers } = require('./proposalDirectApply');
const { checkContributionGate } = require('./contributionGate');
const { createNotification } = require('./notifications');
const { bumpWineOwners } = require('./dataVersion');

// The curator reads this on the proposal when too many members hold the row
// for the flag to apply on one member's word.
const NOT_WINE_REASON = 'A bottle owner marked this record as a drink that is not wine (cider, beer, spirits or a soft drink), from their bottle page.';

/**
 * Does this member hold a bottle of the wine in a cellar they can EDIT — their
 * own, or one shared with them as an editor? A viewer of a shared cellar may
 * not change a bottle note; they do not get to move the owner's wine either.
 */
async function holdsBottleOf(userId, wineId) {
  const cellarIds = await Cellar.distinct('_id', {
    deletedAt: null,
    $or: [{ user: userId }, { members: { $elemMatch: { user: userId, role: 'editor' } } }],
  });
  if (!cellarIds.length) return false;
  return Boolean(await Bottle.exists({ wineDefinition: wineId, cellar: { $in: cellarIds } }));
}

/**
 * A member moves a drink that is not wine to the Other category.
 *
 * Files the non_wine proposal and, when the direct-apply rule allows it (at
 * most NON_WINE_DIRECT_MAX_OWNERS members hold bottles of the row), applies
 * it at once as the sommelier's own filings do. Otherwise the proposal waits
 * for a curator. Only a member who holds a bottle of it in a cellar they can
 * edit (or who created the row) may ask.
 *
 * @returns {Promise<{ok: true, status: 'applied'|'already'|'filed'|'pending', category: 'other'|'wine', holders?: number}
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
    return { ok: false, code: 'forbidden', message: 'Only a member who holds a bottle of it in a cellar they can edit can move a drink to Other.' };
  }

  // The gate every member contribution to the shared registry pays (release
  // audit 2026-10-28): a banned account may not move a row, and a move from
  // the bottle page or MCP counts against the day's suggestion budget — a
  // drink added as Other up front only says what the member bought, so it
  // pays the ban check alone.
  const gate = await checkContributionGate(userId, { budget: via !== 'add' });
  if (!gate.ok) return gate;

  let proposal;
  try {
    proposal = await WineCorrectionProposal.create({
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
    if (err && err.code === 11000) return { ok: true, status: 'pending', category: 'wine' };
    throw err;
  }
  logAudit(req, 'wine.nonWineProposed', { type: 'wine', id: wine._id },
    { via, name: wine.name, producer: wine.producer || null });

  const verdict = await classifyProposal(wine, 'non_wine', null);
  if (!verdict.direct) {
    return { ok: true, status: 'filed', category: 'wine', holders: await countHoldingMembers(wine._id) };
  }

  // Required lazily: the admin route tree requires the MCP registry, which
  // requires the tools, which require this module (the sommelier tool does
  // the same for the same reason). approveProposal reads req.user.id for
  // decidedBy; a request-less caller (MCP contexts, scripts) gets a stand-in.
  const { approveProposal } = require('../routes/admin/wineProposals');
  const asReq = req && req.user ? req : { user: { id: userId } };
  const outcome = await approveProposal(proposal._id, asReq);
  if (outcome.status !== 200) {
    // The proposal stays pending and a curator picks it up: a failed
    // self-apply must never read as a success.
    console.warn(`[nonWine] self-apply declined for proposal ${proposal._id}: ${outcome.status} ${outcome.body?.error || ''}`);
    return { ok: true, status: 'filed', category: 'wine' };
  }
  // The other holders see "Other" on their bottles from now on: tell them,
  // and let their cached lists and statistics refresh.
  await notifyOtherHolders(wine, userId);
  await bumpWineOwners([wine._id]);
  return { ok: true, status: 'applied', category: 'other' };
}

/** Every member with a bottle of the wine in a live cellar: owners and members. */
async function holdingMemberIds(wineId) {
  const cellarIds = await Bottle.distinct('cellar', { wineDefinition: wineId });
  if (!cellarIds.length) return [];
  const cellars = await Cellar.find({ _id: { $in: cellarIds }, deletedAt: null }).select('user members.user').lean();
  const people = new Set();
  for (const c of cellars) {
    if (c.user) people.add(String(c.user));
    for (const m of c.members || []) if (m.user) people.add(String(m.user));
  }
  return [...people];
}

/**
 * A row moved to Other on one member's word changes what up to two other
 * holders see on their own bottles — they are told, in the bell. Never
 * throws: the move itself is done, a missed notice must not read as failure.
 */
async function notifyOtherHolders(wine, actorId) {
  try {
    const others = (await holdingMemberIds(wine._id)).filter((id) => id !== String(actorId));
    const who = `"${wine.name}"${wine.producer ? ` by ${wine.producer}` : ''}`;
    for (const id of others) {
      await createNotification(id, 'wine_moved_to_other', 'A drink in your cellar moved to Other',
        `${who} was marked as not wine by another member who holds it. Your bottles are unchanged; they now show under Other.`);
    }
  } catch (err) {
    console.warn('[nonWine] holder notification failed:', err.message);
  }
}

/**
 * An add with category "other" that resolved to a record the registry already
 * had as WINE: the member's choice is not dropped — they now hold a bottle of
 * it, so the move runs as from the bottle page (applied, or filed for a
 * curator). Null when nothing is to do.
 */
async function applyOtherCategoryAfterAdd({ wine, newWine, userId, req = null, via = 'add' }) {
  if (!wine || !newWine || newWine.category !== 'other' || wine.nonWine === true) return null;
  const r = await markNotWineByMember({ wineId: wine._id, userId, req, via });
  return r.ok ? { status: r.status, category: r.category, ...(r.holders !== undefined ? { holders: r.holders } : {}) } : null;
}

module.exports = { markNotWineByMember, applyOtherCategoryAfterAdd, holdsBottleOf, NOT_WINE_REASON };
