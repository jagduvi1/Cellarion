/**
 * Cellar Cred for accepted community suggestions: a wine correction an admin
 * approved (WineCorrectionProposal, every kind) and a registry value a curator
 * published (RegistryDataValue). The daily suggestion budget
 * (services/contributionGate) rises with the contribution tier — these are
 * the contributions that promise is about.
 *
 * ONE way in, for the live paths (approving a proposal, publishing a value,
 * the non-wine quarantine toggle) and for the backfill script alike: an award
 * first claims the row's `credAwardedAt` marker (null → now, conditional on
 * the row still being accepted) and only a claim that matched pays out, so a
 * row earns once however many paths reach it. A reversal releases the marker
 * and takes the points back (utils/cellarCred: every award has its reversal).
 *
 * Who earns: the proposer / the suggester — not for a suggestion they decided
 * themselves (a self-applied proposal, a curator publishing their own value),
 * not a staff account (admin, somm: curation is their job, and the budget the
 * score raises is the members' one), not an account that is gone (deleted, or
 * the erasure sentinel published values are re-pointed to).
 *
 * What stands: an approved proposal that applied (its appliedNote is the
 * receipt); a published value, still once a newer value supersedes it — the
 * contribution stood. A non-wine flag stands while its wine stays in the
 * quarantine: restoring the wine (the undo of an applied flag) takes the
 * points back, quarantining it again gives them back. Merging a wine away or
 * deleting it takes nothing back: the corrections and values that described
 * it stood.
 */
const User = require('../models/User');
const WineCorrectionProposal = require('../models/WineCorrectionProposal');
const RegistryDataValue = require('../models/RegistryDataValue');
const WineDefinition = require('../models/WineDefinition');
const { incrementCred, decrementCred } = require('../utils/cellarCred');
const { isReservedUsername } = require('../utils/deletedUser');

// What services/registryDataOps writes on the published value a newer
// approval demotes — how a superseded publication is told from a rejection.
const SUPERSEDED_REASON = 'Superseded by a newer approval';

const STAFF_ROLES = ['admin', 'somm'];

const KINDS = {
  proposal: {
    Model: WineCorrectionProposal,
    event: 'wine_correction_accepted',
    earner: 'proposer',
    accepted: { status: 'approved', appliedNote: { $nin: [null, ''] } },
    fields: 'proposer decidedBy kind wineDefinition status credAwardedAt',
  },
  value: {
    Model: RegistryDataValue,
    event: 'registry_value_published',
    earner: 'suggestedBy',
    accepted: { $or: [{ status: 'published' }, { status: 'rejected', rejectReason: SUPERSEDED_REASON }] },
    fields: 'suggestedBy decidedBy status credAwardedAt',
  },
};

const EVENTS = { proposal: KINDS.proposal.event, value: KINDS.value.event };

const idOf = (v) => (v && v._id ? v._id : v);
const sameId = (a, b) => a != null && b != null && String(idOf(a)) === String(idOf(b));
// The marker is bookkeeping, not an edit: it must not move updatedAt.
const QUIET = { timestamps: false };

/**
 * The next `limit` accepted rows of a kind that hold no award yet, by _id
 * after `after` — the backfill's scan.
 */
function unawardedBatch(kind, { after = null, limit = 200 } = {}) {
  const { Model, accepted, fields } = KINDS[kind];
  return Model.find({ ...accepted, credAwardedAt: null, ...(after ? { _id: { $gt: after } } : {}) })
    .sort({ _id: 1 }).limit(limit).select(fields).lean();
}

/**
 * Who of `rows` earns, and why the others do not. Reads the earners (and, for
 * non-wine proposals, their wines) in one query each; writes nothing.
 * @returns {Promise<{earning: Array<{row: object, userId: string}>,
 *   skipped: {self: number, staff: number, gone: number, restored: number},
 *   users: Map<string, object>}>} users = the earners read, by id
 */
async function planAwards(kind, rows) {
  const { earner } = KINDS[kind];
  const skipped = { self: 0, staff: 0, gone: 0, restored: 0 };
  const candidates = [];
  for (const row of rows) {
    const userId = row[earner] ? String(idOf(row[earner])) : null;
    if (!userId) skipped.gone++;
    else if (sameId(userId, row.decidedBy)) skipped.self++;
    else candidates.push({ row, userId });
  }

  const userIds = [...new Set(candidates.map((c) => c.userId))];
  const found = userIds.length
    ? await User.find({ _id: { $in: userIds } }).select('username roles contribution').lean()
    : [];
  const users = new Map(found.map((u) => [String(u._id), u]));

  // A missing wine was merged away or deleted while quarantined: the flag stood.
  const wineIds = [...new Set(candidates
    .filter((c) => kind === 'proposal' && c.row.kind === 'non_wine')
    .map((c) => String(idOf(c.row.wineDefinition))))];
  const restored = new Set(wineIds.length
    ? (await WineDefinition.find({ _id: { $in: wineIds }, nonWine: { $ne: true } }).select('_id').lean()).map((w) => String(w._id))
    : []);

  const earning = [];
  for (const c of candidates) {
    const user = users.get(c.userId);
    if (!user || isReservedUsername(user.username)) skipped.gone++;
    else if ((user.roles || []).some((r) => STAFF_ROLES.includes(r))) skipped.staff++;
    else if (c.row.kind === 'non_wine' && restored.has(String(idOf(c.row.wineDefinition)))) skipped.restored++;
    else earning.push(c);
  }
  return { earning, skipped, users };
}

/**
 * Pay out `earning` (from planAwards): per row, claim the marker, then award.
 * A row already claimed — by the live path, an earlier run — is passed over.
 * A points write that fails releases its claim, so a later run can retry it.
 * @returns {Promise<Array<{row: object, userId: string}>>} the rows awarded
 */
async function awardRows(kind, earning) {
  const { Model, event, accepted } = KINDS[kind];
  const awarded = [];
  for (const entry of earning) {
    const at = new Date();
    const claim = await Model.updateOne(
      { _id: entry.row._id, credAwardedAt: null, ...accepted },
      { $set: { credAwardedAt: at } },
      QUIET
    );
    if (!claim.modifiedCount) continue;
    try {
      await incrementCred(entry.userId, event);
      awarded.push(entry);
    } catch (err) {
      await Model.updateOne({ _id: entry.row._id, credAwardedAt: at }, { $set: { credAwardedAt: null } }, QUIET).catch(() => {});
      console.warn(`[suggestionCred] ${event} for ${entry.row._id} not awarded:`, err.message);
    }
  }
  return awarded;
}

/** Take one row's award back: release the marker, then the points. */
async function reverseRow(kind, row) {
  const { Model, event, earner } = KINDS[kind];
  const released = await Model.updateOne(
    { _id: row._id, credAwardedAt: row.credAwardedAt },
    { $set: { credAwardedAt: null } },
    QUIET
  );
  if (!released.modifiedCount) return false;
  try {
    await decrementCred(idOf(row[earner]), event);
    return true;
  } catch (err) {
    await Model.updateOne({ _id: row._id, credAwardedAt: null }, { $set: { credAwardedAt: row.credAwardedAt } }, QUIET).catch(() => {});
    console.warn(`[suggestionCred] ${event} for ${row._id} not taken back:`, err.message);
    return false;
  }
}

// The live award, after the decision is recorded. Never throws: a missed
// award is logged and leaves the marker null, so the backfill still pays it.
async function awardAccepted(kind, row) {
  try {
    const { earning } = await planAwards(kind, [row]);
    return earning.length > 0 && (await awardRows(kind, earning)).length > 0;
  } catch (err) {
    console.warn(`[suggestionCred] ${KINDS[kind].event} for ${row && row._id} failed (non-fatal):`, err.message);
    return false;
  }
}

/** An approved proposal (routes/admin/wineProposals.approveProposal) earns its proposer. */
const awardProposal = (proposal) => awardAccepted('proposal', proposal);

/** A published value (registryDataOps.decideValue) earns its suggester. */
const awardValue = (value) => awardAccepted('value', value);

/**
 * The quarantine toggle moved a wine out of the registry (`quarantined`) or
 * back into it: the approved non-wine proposals on it stand again, or no
 * longer do. Never throws.
 * @returns {Promise<{awarded: number, reversed: number}>}
 */
async function settleNonWineProposals(wineId, quarantined) {
  try {
    const rows = await WineCorrectionProposal.find({ wineDefinition: wineId, kind: 'non_wine', ...KINDS.proposal.accepted })
      .select(KINDS.proposal.fields).lean();
    if (quarantined) {
      const { earning } = await planAwards('proposal', rows.filter((r) => !r.credAwardedAt));
      return { awarded: (await awardRows('proposal', earning)).length, reversed: 0 };
    }
    let reversed = 0;
    for (const row of rows) {
      if (row.credAwardedAt && await reverseRow('proposal', row)) reversed++;
    }
    return { awarded: 0, reversed };
  } catch (err) {
    console.warn(`[suggestionCred] non-wine settle for wine ${wineId} failed (non-fatal):`, err.message);
    return { awarded: 0, reversed: 0 };
  }
}

module.exports = {
  SUPERSEDED_REASON,
  EVENTS,
  awardProposal,
  awardValue,
  settleNonWineProposals,
  // The backfill script's steps — the same claim and exclusions as above.
  unawardedBatch,
  planAwards,
  awardRows,
};
