// User-data registry entries: what a member contributed to data everyone
// shares. Prices and drink windows a sommelier set, blog posts, and the wines,
// taxonomy and registry rows whose contributor reference is reassigned, so
// the shared data stays.
// One part of the REGISTRY of services/userDataRegistry.js, which documents the
// entry shape and runs the entries in order.

const WineVintagePrice = require('../../models/WineVintagePrice');
const WineVintageProfile = require('../../models/WineVintageProfile');
const BlogPost = require('../../models/BlogPost');
const WineDefinition = require('../../models/WineDefinition');
const Country = require('../../models/Country');
const Region = require('../../models/Region');
const Grape = require('../../models/Grape');
const Classification = require('../../models/Classification');
const SweetnessTerm = require('../../models/SweetnessTerm');
const Appellation = require('../../models/Appellation');
const AppellationReviewSkip = require('../../models/AppellationReviewSkip');
const ProfileAuditSample = require('../../models/ProfileAuditSample');
const SiteConfig = require('../../models/SiteConfig');
const { eraseCuratorFromWindowSnapshots } = require('../undoSnapshotErasure');
const { EXPORT_MAX, markTrunc, BRIDGE_REGISTRY_NOTE } = require('./shared');

module.exports = [
  // ── Somm-contributed data: clear the user ref, keep the shared data ──────
  {
    model: WineVintagePrice, category: 'creator-ref', userFields: ['setBy'],
    purge: (ctx) => WineVintagePrice.updateMany({ setBy: ctx.userId }, { $unset: { setBy: '', sommNotes: '' } }),
    exportFragment: null,
    note: 'somm price contribution (shared data); portability of own contributions is a follow-up',
  },
  {
    model: WineVintageProfile, category: 'creator-ref', userFields: ['setBy'],
    // Two passes. A somm's own row loses the stamp and the note they wrote. A
    // row the Registry Bridge wrote keeps its note: without it the row reads
    // as a local edit and the bridge never updates that drink window again;
    // dropping the stamp removes the personal reference. The same two passes
    // run first on the undo snapshots other curators hold of such rows.
    purge: async (ctx) => {
      await eraseCuratorFromWindowSnapshots(ctx.userId, BRIDGE_REGISTRY_NOTE);
      await WineVintageProfile.updateMany(
        { setBy: ctx.userId, sommNotes: { $ne: BRIDGE_REGISTRY_NOTE } },
        { $unset: { setBy: '', setAt: '', sommNotes: '' } }
      );
      return WineVintageProfile.updateMany(
        { setBy: ctx.userId, sommNotes: BRIDGE_REGISTRY_NOTE },
        { $unset: { setBy: '', setAt: '' } }
      );
    },
    exportFragment: null,
    note: 'somm maturity contribution (shared data); portability of own contributions is a follow-up',
  },

  // ── Blog ────────────────────────────────────────────────────────────────
  {
    model: BlogPost, category: 'shared-content', userFields: ['author'],
    purge: (ctx) => BlogPost.updateMany({ author: ctx.userId }, { $unset: { author: '' } }),
    exportFragment: null,
    note: 'authored public content (preserved, author unset on delete); portability is a follow-up',
  },

  // ── Shared taxonomy / registry: reassign the contributor ref ────────────
  // These documents are admin-managed shared data that survives the user's
  // deletion. They carry only a creator/editor ref to the departing user; we
  // re-point it to the [deleted] sentinel so the ref doesn't dangle (createdBy
  // is `required`, so it can't be unset). Not exported — not the user's data.
  {
    model: WineDefinition, category: 'creator-ref', userFields: ['createdBy', 'aiProfile.verifiedBy', 'contribution.user'],
    // aiProfile.verifiedBy is the curator who corrected the tasting profile.
    // Reassigned rather than unset, like createdBy: the profile stays
    // curator-sourced (which is what keeps the AI job from regenerating over
    // it) and only the person is anonymised.
    purge: async (ctx) => {
      // PRIVATE DRAFTS are the user's own data, not shared registry content
      // (models/WineDefinition.draft): remember which rows those are BEFORE
      // the createdBy reassign below makes them indistinguishable; postPurge
      // decides each one once the user's bottles are gone.
      ctx.draftWineIds = await WineDefinition.distinct('_id', { createdBy: ctx.userId, draft: true });
      await WineDefinition.updateMany({ createdBy: ctx.userId }, { $set: { createdBy: ctx.deletedUserId } });
      await WineDefinition.updateMany({ 'aiProfile.verifiedBy': ctx.userId }, { $set: { 'aiProfile.verifiedBy': ctx.deletedUserId } });
      // The contributor whose request produced this wine, anonymised the same
      // way. `contribution.bridgeKey` is deliberately KEPT: once the key row
      // and the account are gone it identifies nobody, but it still GROUPS
      // everything that install contributed — which is what a rights-holder
      // takedown needs. The self-reported host can name a household, so it
      // goes. Retaining more than this, with a legal basis and terms wording,
      // is the provenance-ledger work, not something to smuggle in here.
      await WineDefinition.updateMany({ 'contribution.user': ctx.userId }, { $set: { 'contribution.user': ctx.deletedUserId, 'contribution.instanceHost': null } });
    },
    // The departing user's drafts, after the batch (their bottles are gone by
    // now): a draft another member's bottle still points at (a shared cellar)
    // is published as it stands — a lost bottle is the worse outcome — and an
    // empty one is deleted. The same two outcomes the expiry job applies.
    postPurge: async (ctx) => {
      const ids = ctx.draftWineIds || [];
      if (!ids.length) return;
      // Lazy: the draft ops pull the resolver tree; erasure must stay light.
      const ops = require('../wineDraftOps');
      const Bottle = require('../../models/Bottle');
      for (const id of ids) {
        try {
          const wine = await WineDefinition.findOne({ _id: id, draft: true });
          if (!wine) continue;
          if (await Bottle.exists({ wineDefinition: wine._id })) {
            const r = await ops.publishDraft(wine, { userId: null, req: null, auto: true, reason: 'erasure' });
            if (!r.ok && r.code === 'duplicate' && r.match) {
              // The departed user's rows now carry the shared [deleted]
              // identity, under which the resolver would treat EVERY erased
              // user's pending row as "own" — so the surviving member's
              // bottles may only move onto a genuinely published wine, never
              // onto some other erased user's pending row (audit 2026-09-12).
              const published = await WineDefinition.exists({ _id: r.match.wine_id, pendingIdentity: { $ne: true }, draft: { $ne: true } });
              if (published) {
                await ops.attachDraftBottles(wine, r.match.wine_id, { userId: ctx.deletedUserId, roles: [], req: null, auto: true, reason: 'erasure' });
              } else {
                console.warn('[userDataRegistry] draft', String(id), 'kept: its duplicate match is not a published wine');
              }
            }
          } else {
            await ops.deleteDraft(wine, null, { action: 'wine.draft_erasure_delete' });
          }
        } catch (err) {
          console.warn('[userDataRegistry] draft wine cleanup failed (non-fatal):', String(id), err.message);
        }
      }
    },
    // Only the drafts are exported: a published registry wine is shared data,
    // not the user's.
    exportFragment: async (ctx) => ({
      draftWines: markTrunc(ctx, 'draftWines',
        await WineDefinition.find({ createdBy: ctx.userId, draft: true })
          .select('name producer appellation classification type colour country region grapes createdAt draftExpiresAt createdVia')
          .populate([{ path: 'country', select: 'name' }, { path: 'region', select: 'name' }, { path: 'grapes', select: 'name' }])
          .limit(EXPORT_MAX).lean())
        .map((w) => ({
          name: w.name,
          producer: w.producer || null,
          appellation: w.appellation || null,
          classification: w.classification || null,
          type: w.type || null,
          colour: w.colour || null,
          country: w.country?.name || null,
          region: w.region?.name || null,
          grapes: (w.grapes || []).map((g) => g?.name).filter(Boolean),
          createdVia: w.createdVia || null,
          createdAt: w.createdAt,
          draftExpiresAt: w.draftExpiresAt || null,
        })),
    }),
    note: 'shared registry; required createdBy + aiProfile.verifiedBy reassigned to [deleted] on erasure; the user\'s PRIVATE DRAFTS are exported, and on erasure published (bottles remain) or deleted (empty)',
  },
  {
    model: Country, category: 'creator-ref', userFields: ['createdBy'],
    purge: (ctx) => Country.updateMany({ createdBy: ctx.userId }, { $set: { createdBy: ctx.deletedUserId } }),
    exportFragment: null,
    note: 'shared taxonomy; required createdBy reassigned to [deleted] on erasure',
  },
  {
    model: Region, category: 'creator-ref', userFields: ['createdBy'],
    purge: (ctx) => Region.updateMany({ createdBy: ctx.userId }, { $set: { createdBy: ctx.deletedUserId } }),
    exportFragment: null,
    note: 'shared taxonomy; required createdBy reassigned to [deleted] on erasure',
  },
  {
    model: Grape, category: 'creator-ref', userFields: ['createdBy'],
    purge: (ctx) => Grape.updateMany({ createdBy: ctx.userId }, { $set: { createdBy: ctx.deletedUserId } }),
    exportFragment: null,
    note: 'shared taxonomy; required createdBy reassigned to [deleted] on erasure',
  },
  {
    model: Classification, category: 'creator-ref', userFields: ['createdBy', 'reviewedBy'],
    purge: (ctx) => Promise.all([
      Classification.updateMany({ createdBy: ctx.userId }, { $set: { createdBy: ctx.deletedUserId } }),
      Classification.updateMany({ reviewedBy: ctx.userId }, { $set: { reviewedBy: ctx.deletedUserId } }),
    ]),
    exportFragment: null,
    note: 'shared taxonomy; createdBy and reviewedBy reassigned to [deleted] on erasure (the row and its review stand)',
  },
  {
    model: SweetnessTerm, category: 'creator-ref', userFields: ['createdBy', 'reviewedBy'],
    purge: (ctx) => Promise.all([
      SweetnessTerm.updateMany({ createdBy: ctx.userId }, { $set: { createdBy: ctx.deletedUserId } }),
      SweetnessTerm.updateMany({ reviewedBy: ctx.userId }, { $set: { reviewedBy: ctx.deletedUserId } }),
    ]),
    exportFragment: null,
    note: 'shared taxonomy (label sweetness terms); createdBy and reviewedBy reassigned to [deleted] on erasure (the row and its review stand)',
  },
  {
    model: Appellation, category: 'creator-ref', userFields: ['createdBy'],
    purge: (ctx) => Appellation.updateMany({ createdBy: ctx.userId }, { $set: { createdBy: ctx.deletedUserId } }),
    exportFragment: null,
    note: 'shared taxonomy; required createdBy reassigned to [deleted] on erasure',
  },
  {
    model: AppellationReviewSkip, category: 'creator-ref', userFields: ['skippedBy'],
    // A dismissal is registry curation state — deleting it on erasure would
    // resurrect reviewed-and-rejected strings in the unmatched queue. Only
    // the person is anonymised, exactly like taxonomy createdBy.
    purge: (ctx) => AppellationReviewSkip.updateMany({ skippedBy: ctx.userId }, { $set: { skippedBy: ctx.deletedUserId } }),
    exportFragment: null,
    note: 'shared curation state; required skippedBy reassigned to [deleted] on erasure',
  },
  {
    model: ProfileAuditSample, category: 'creator-ref', userFields: ['recordedBy'],
    // The spot-check tally is registry quality telemetry, not the curator's
    // personal data — the trend must survive their departure; only the
    // person is anonymised.
    purge: (ctx) => ProfileAuditSample.updateMany({ recordedBy: ctx.userId }, { $set: { recordedBy: ctx.deletedUserId } }),
    exportFragment: null,
    note: 'registry quality telemetry; required recordedBy reassigned to [deleted] on erasure',
  },
  {
    model: SiteConfig, category: 'creator-ref', userFields: ['updatedBy'],
    // updatedBy is nullable — clear it (don't reassign).
    purge: (ctx) => SiteConfig.updateMany({ updatedBy: ctx.userId }, { $unset: { updatedBy: '' } }),
    exportFragment: null,
    note: 'global config; nullable updatedBy cleared on erasure',
  },
];
