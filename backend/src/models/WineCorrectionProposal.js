const mongoose = require('mongoose');

/**
 * A sommelier's proposed correction to a SHARED registry wine — an identity
 * field fix (producer/name/appellation/region/country/classification), a
 * duplicate merge, or a non-wine quarantine flag. Raised from the maturity
 * queue (typically over MCP via propose_wine_correction); an admin reviews the
 * diff and applies it in one click (routes/admin/wineProposals.js).
 *
 * Why proposals and not direct writes: type/grapes/tasting-profile corrections
 * ARE direct (set_wine_profile) because a wrong value there is recoverable and
 * undoable. Identity fields drive dedup keys, URLs and every owner's display —
 * and verified experience says curator assertions on producer/name are
 * sometimes confidently wrong (5 overturned by web-verification 2026-08-10) —
 * so they stay human-gated, with the curator's research preserved as a
 * structured, appliable diff instead of a prose ticket an admin re-types.
 *
 * GDPR: registered in services/userDataRegistry.js (proposals deleted with the
 * proposer's account, decidedBy cleared off other users' proposals when the
 * deciding admin is erased, authored proposals included in /me/export).
 */

// Identity fields a proposal may correct. region/country are STRINGS here —
// resolved to taxonomy refs at APPROVE time (routes/admin/wineProposals.js),
// so a proposal can never mint taxonomy and an unresolvable country fails the
// approve, not the propose.
const proposedFieldsSchema = new mongoose.Schema({
  producer:       { type: String, trim: true, maxlength: 200 },
  name:           { type: String, trim: true, maxlength: 200 },
  appellation:    { type: String, trim: true, maxlength: 200 },
  region:         { type: String, trim: true, maxlength: 200 },
  country:        { type: String, trim: true, maxlength: 200 },
  classification: { type: String, trim: true, maxlength: 200 },
  // Added 2026-08-19 (somm ticket 6a85ad44). Until now a curator could see a
  // wine stored red on nothing but white grapes and had no way to propose the
  // fix — type and grapes were the only identity fields with no route through
  // this pipeline, so every one came back to an admin by hand.
  //
  // Validated at BOTH ends rather than here: the MCP tool rejects a bad type or
  // an unknown variety at file time (so the curator learns immediately), and
  // the approve path re-checks against live taxonomy (because a grape can be
  // renamed or merged between filing and approval). A plain String here matches
  // how country and region are already carried.
  type:           { type: String, trim: true, maxlength: 20 },
  // Variety NAMES, not ids: the proposal records what the curator meant, and
  // resolution to taxonomy happens at approval — same reason country travels as
  // a name. A proposed list REPLACES the wine's list; `default: undefined`
  // keeps "not proposed" distinct from "proposed empty".
  grapes:         { type: [{ type: String, trim: true, maxlength: 60 }], default: undefined },
}, { _id: false });

const wineCorrectionProposalSchema = new mongoose.Schema({
  proposer: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  wineDefinition: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'WineDefinition',
    required: true,
    index: true,
  },
  kind: {
    type: String,
    enum: ['field_correction', 'merge', 'non_wine'],
    required: true,
  },
  // Only set for kind 'field_correction'.
  proposedFields: {
    type: proposedFieldsSchema,
    default: undefined,
  },
  // Only set for kind 'merge' — the wine this one should be absorbed into.
  mergeTargetId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'WineDefinition',
    required: function () { return this.kind === 'merge'; },
  },
  // A URL backing the claim (producer site, appellation register, …) — what
  // makes a one-click approve possible instead of the admin redoing research.
  evidenceUrl: {
    type: String,
    trim: true,
    maxlength: 500,
    validate: {
      validator: (v) => !v || /^https?:\/\//i.test(v),
      message: 'evidenceUrl must start with http:// or https://',
    },
  },
  reason: {
    type: String,
    required: [true, 'Reason is required'],
    trim: true,
    minlength: [10, 'Reason too short'],
    maxlength: [1000, 'Reason too long'],
  },
  // The wine's identity fields as they stood when the proposal was made
  // (region/country as display names). The admin diff renders against LIVE
  // values; this snapshot is what lets it show drift in between.
  currentSnapshot: {
    type: mongoose.Schema.Types.Mixed,
    default: null,
  },
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected'],
    default: 'pending',
    index: true,
  },
  decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  decidedAt: { type: Date, default: null },
  rejectReason: { type: String, trim: true, maxlength: 2000 }, // 500 was too short for a real explanation (registry backlog 2026-09-06)
  // What the approve actually did (fields applied / bottles moved / queue rows
  // cleared) — the reviewer-facing receipt.
  appliedNote: { type: String, trim: true, maxlength: 500 },
}, { timestamps: true });

wineCorrectionProposalSchema.index({ status: 1, createdAt: -1 });

// At most ONE pending proposal per (wine, kind) — makes the duplicate-propose
// conflict race-safe (two concurrent creates can't both insert a pending row),
// same pattern as AiBudgetRequest's one-pending-per-user index. Compound with
// status so it doesn't duplicate the field-level `index: true` on
// wineDefinition; the partial filter means decided rows never collide.
wineCorrectionProposalSchema.index(
  { wineDefinition: 1, kind: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: 'pending' } }
);

module.exports = mongoose.model('WineCorrectionProposal', wineCorrectionProposalSchema);
