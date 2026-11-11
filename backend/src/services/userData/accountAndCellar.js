// User-data registry entries: the account itself and what a member keeps in
// the app: cellars, racks, bottles and their photos, wine lists, the wishlist,
// personal data keys and values, saved views and dashboards, pick lists.
// One part of the REGISTRY of services/userDataRegistry.js, which documents the
// entry shape and runs the entries in order.

const User = require('../../models/User');
const Bottle = require('../../models/Bottle');
const BottleImage = require('../../models/BottleImage');
const DeletedBottle = require('../../models/DeletedBottle');
const Cellar = require('../../models/Cellar');
const CellarLayout = require('../../models/CellarLayout');
const Rack = require('../../models/Rack');
const WineList = require('../../models/WineList');
const WishlistItem = require('../../models/WishlistItem');
const PersonalDataKey = require('../../models/PersonalDataKey');
const PersonalDataEntry = require('../../models/PersonalDataEntry');
const SavedDashboard = require('../../models/SavedDashboard');
const SavedView = require('../../models/SavedView');
const PickList = require('../../models/PickList');
const RegistryDataKey = require('../../models/RegistryDataKey');
const RegistryDataValue = require('../../models/RegistryDataValue');
const WineDefinition = require('../../models/WineDefinition');
const RegistryReadDay = require('../../models/RegistryReadDay');
const { deleteLogoFilesFor } = require('../wineListLogos');
const { unlinkImageFiles } = require('../imageProcessor');
const { EXPORT_MAX, markTrunc } = require('./shared');

module.exports = [
  // ── The account itself ──────────────────────────────────────────────────
  {
    model: User,
    category: 'personal-data',
    userFields: ['_id', 'discussionBan.bannedBy'],
    // The account row itself is removed by runUserDeletionJob AFTER purgeUserData.
    // Here we only clear this user's admin ref (discussionBan.bannedBy) off OTHER
    // users' records so it doesn't dangle when the issuing admin is deleted.
    purge: (ctx) => User.updateMany({ 'discussionBan.bannedBy': ctx.userId }, { $unset: { 'discussionBan.bannedBy': '' } }),
    note: 'account row deleted by runUserDeletionJob; purge only clears bannedBy on other users',
    exportFragment: async (ctx) => {
      const u = ctx.user;
      return {
        account: {
          username: u.username,
          email: u.email,
          displayName: u.displayName,
          bio: u.bio,
          roles: u.roles,
          plan: u.plan,
          stripeSubscriptionId: u.stripeSubscriptionId || null,
          // When we sent the one-off supporter thank-you. Included because the
          // export is an explicit field pick, so anything omitted here is
          // simply absent from a subject access request — and "we emailed you
          // on this date" is processing history the user is entitled to see.
          supporterThankYouSentAt: u.supporterThankYouSentAt || null,
          // The one email sent to a new member two days after joining
          // (services/newMemberEmails) — when, and which of the two.
          newMemberEmailSentAt: u.newMemberEmailSentAt || null,
          newMemberEmailKind: u.newMemberEmailKind || null,
          preferences: u.preferences,
          profileVisibility: u.profileVisibility,
          emailVerified: u.emailVerified,
          // When they objected to all Cellarion email (the unsubscribe link) —
          // processing history, like supporterThankYouSentAt above.
          emailOptOutAt: u.emailOptOutAt || null,
          gdprConsent: u.gdprConsent,
          createdAt: u.createdAt,
          // The last day the account was used (a date, no time): what the
          // inactive-account rule reads. null until first seen after it existed.
          lastActiveAt: u.lastActiveAt || null,
          // The notices before deletion of an unused account, while a timeline
          // runs (services/inactiveAccounts): when each went out and the date
          // they announced — processing history, like the email stamps above.
          inactivityNotice: u.inactivityNotice?.firstSentAt
            ? {
              firstSentAt: u.inactivityNotice.firstSentAt,
              finalSentAt: u.inactivityNotice.finalSentAt || null,
              deleteAfter: u.inactivityNotice.deleteAfter || null,
            }
            : null,
          // How the account found Cellarion, recorded at signup (referrer
          // domain, campaign tags, landing page) — null when never recorded.
          signupSource: u.signupSource || null,
          contribution: u.contribution || { totalScore: 0, categories: {}, tier: 'newcomer', specialty: null },
          // Admin-granted temporary AI budget override (rides on the User doc).
          aiBudgetOverride: u.aiBudgetOverride?.max
            ? { max: u.aiBudgetOverride.max, expiresAt: u.aiBudgetOverride.expiresAt }
            : null,
          // Signed-in devices (per-device sessions). Metadata only — the token
          // hashes are the credential itself, not the user's data, and never
          // leave the database.
          sessions: (u.sessions || []).map(s => ({
            client: s.client, createdAt: s.createdAt, lastUsedAt: s.lastUsedAt,
            expiresAt: s.expiresAt, persistent: s.persistent !== false,
          })),
        },
      };
    },
  },

  // ── Core wine data ──────────────────────────────────────────────────────
  {
    model: Bottle, category: 'personal-data', userFields: ['user'],
    // Collect the ids BEFORE deleteMany — the rack slots below still need them.
    purge: async (ctx) => {
      const bottleIds = await Bottle.find({ user: ctx.userId }).distinct('_id');
      await Bottle.deleteMany({ user: ctx.userId });
      // The Rack entry below only purges racks in the user's OWN cellars, so a
      // deleted bottle placed in ANOTHER owner's cellar would leave a dangling
      // slot ref in that cellar's racks — pull those slots too.
      await Rack.updateMany(
        { 'slots.bottle': { $in: bottleIds } },
        { $pull: { slots: { bottle: { $in: bottleIds } } } }
      );
    },
    exportFragment: async (ctx) => ({ bottles: markTrunc(ctx, 'bottles', await Bottle.find({ user: ctx.userId }).limit(EXPORT_MAX).lean()) }),
  },
  {
    model: BottleImage, category: 'personal-data', userFields: ['uploadedBy', 'reviewedBy'],
    // A photo the registry keeps (services/photoRetention: the wine's chosen
    // picture, or any photo an admin approved as PUBLIC — policy 2026-09-27)
    // is seen by OTHER users, so it must NOT be deleted on the uploader's
    // account deletion — anonymise it (re-point uploadedBy to the [deleted]
    // sentinel, like forum content) and detach it from the bottle that is
    // going, so the shared photo survives and stays managed. Only the user's
    // own photos (pending, private, rejected, every label scan) are
    // hard-deleted. Also clear this user's reviewedBy ref off OTHER users'
    // images. Unlink the on-disk files for the user's own photos BEFORE
    // deleting the docs — those docs are the only reference to the files, so
    // deleting them first would orphan the files on disk forever. Kept photos
    // are anonymised, not deleted, so their files stay. Returned as a single
    // self-contained promise so the inner DB ops are awaited (an async fn
    // returning an *array* would not await the queries inside it).
    purge: async (ctx) => {
      const { OWN_PHOTO, REGISTRY_PHOTO } = require('../photoRetention');
      const own = await BottleImage.find({ uploadedBy: ctx.userId, ...OWN_PHOTO })
        .select('originalUrl processedUrl').lean();
      for (const img of own) await unlinkImageFiles(img);
      // Label-scan images (kind:'label-scan') are in that hard-delete set —
      // they are never assignedToWine. A pending/curated WineDefinition may
      // POINT at one via scanImage, and a dangling pointer would make the
      // pending queue 404 on an image forever, so the reference is cleared in
      // the same pass. Deliberately keyed on the image ids we are about to
      // delete rather than on the user: a wine created by someone ELSE can
      // legitimately carry this user's scan (a second bottle supplied it).
      // A wine added through the back-label rescue points at TWO label frames
      // (scanImage + scanImageBack); both are kind:'label-scan', both are in
      // the hard-delete set above, and BOTH pointers have to be cleared or the
      // pending queue 404s on an image forever. Separate matched updates so
      // each pointer is nulled only where it names a deleted image.
      const ownIds = own.map((i) => i._id);
      await Promise.all([
        BottleImage.deleteMany({ uploadedBy: ctx.userId, ...OWN_PHOTO }),
        BottleImage.updateMany({ uploadedBy: ctx.userId, ...REGISTRY_PHOTO }, { $set: { uploadedBy: ctx.deletedUserId }, $unset: { bottle: '' } }),
        BottleImage.updateMany({ reviewedBy: ctx.userId }, { $unset: { reviewedBy: '' } }),
        // Reports this user filed on OTHER people's photos.
        // The report is the user's own statement, so it leaves with them — but
        // the photo it concerns belongs to someone else and stays. reportedAt
        // is deliberately NOT cleared here: an admin may still be mid-review,
        // and a queue item that vanishes because an unrelated account closed
        // is worse than one whose reporter reads "a former user".
        BottleImage.updateMany(
          { 'reports.user': ctx.userId },
          { $pull: { reports: { user: ctx.userId } } }
        ),
        // scanFieldConflicts goes with the pointers (release-audit L-4): the
        // "front said X, back said Y" record is a statement ABOUT those photos,
        // and evidence that outlives the images it refers to cannot be checked
        // — same rule the retention sweep already applies.
        ownIds.length
          ? WineDefinition.updateMany({ scanImage: { $in: ownIds } }, { $set: { scanImage: null, scanFieldConflicts: [] } })
          : Promise.resolve(),
        ownIds.length
          ? WineDefinition.updateMany({ scanImageBack: { $in: ownIds } }, { $set: { scanImageBack: null, scanFieldConflicts: [] } })
          : Promise.resolve(),
      ]);
    },
    exportFragment: async (ctx) => ({
      // `kind` rides along so the export distinguishes the user's bottle photos
      // from the label frames the scanner kept — same three fields otherwise,
      // same URL-reference form (the bytes ship in the full-export ZIP).
      // `side` distinguishes the front frame from the optional back-label
      // rescue frame: both are label scans of one bottle, and an export that
      // showed two indistinguishable images would be a worse answer to "what do
      // you hold about me" than one that names them.
      images: markTrunc(ctx, 'images', await BottleImage.find({ uploadedBy: ctx.userId }).limit(EXPORT_MAX).lean())
        .map(i => ({ originalUrl: i.originalUrl, processedUrl: i.processedUrl, uploadedAt: i.createdAt, kind: i.kind || 'bottle', side: i.side || 'front' })),
      // Reports the user filed on photos — their words about someone else's
      // image, so they belong in "what do you hold about me". The image is
      // named by id only: including its URL would put another user's photo
      // into this export.
      imageReports: markTrunc(ctx, 'imageReports',
        await BottleImage.find({ 'reports.user': ctx.userId }).select('reports').limit(EXPORT_MAX).lean())
        .flatMap((i) => (i.reports || [])
          .filter((r) => String(r.user) === String(ctx.userId))
          .map((r) => ({ imageId: String(i._id), reason: r.reason, detail: r.detail || null, reportedAt: r.createdAt }))),
    }),
  },
  {
    // "Recently deleted" (services/bottleTrash): bottles a bulk delete keeps
    // for 30 days before they go for good. The user's own rows, and every row
    // in their cellars' trash, are purged with the account — each bottle's own
    // photos first (purgeTrashRows), which the BottleImage entry above misses
    // when another member of a shared cellar took them. A row this user
    // created in SOMEONE ELSE's cellar trash keeps the bottle (it is the
    // owner's to restore) and only loses the link to who deleted it.
    model: DeletedBottle, category: 'personal-data', userFields: ['user', 'deletedBy'],
    purge: async (ctx) => {
      const { purgeTrashRows } = require('../bottleTrash');
      await purgeTrashRows({ $or: [{ user: ctx.userId }, { cellar: { $in: ctx.cellarIds } }] });
      await DeletedBottle.updateMany({ deletedBy: ctx.userId }, { $set: { deletedBy: ctx.deletedUserId } });
    },
    exportFragment: async (ctx) => ({
      // The bottle as it was stored, and when it is deleted for good.
      recentlyDeletedBottles: markTrunc(ctx, 'recentlyDeletedBottles', await DeletedBottle.find({ user: ctx.userId }).limit(EXPORT_MAX).lean())
        .map((r) => ({ bottle: r.snapshot ? r.snapshot.bottle : null, deletedAt: r.deletedAt, purgeAt: r.purgeAt })),
    }),
  },
  {
    model: Cellar, category: 'personal-data', userFields: ['user', 'members.user', 'userColors.user'],
    purge: async (ctx) => {
      // GAP FIX: bottles inside the user's cellars that are OWNED BY OTHERS
      // (legacy data — bottle.user is set to the cellar owner on every current
      // creation path, but older/moved rows can differ) are missed by the
      // user-scoped Bottle purge and would survive pointing at a deleted
      // cellar. Delete them too, cleaning their images the same
      // reference-safe way as the Bottle/BottleImage entries: ids collected
      // before deleteMany, files unlinked before their only referencing docs
      // go, registry photos (services/photoRetention) kept with the bottle
      // ref detached.
      const orphanIds = await Bottle.find({ cellar: { $in: ctx.cellarIds }, user: { $ne: ctx.userId } }).distinct('_id');
      if (orphanIds.length > 0) {
        const { OWN_PHOTO, REGISTRY_PHOTO } = require('../photoRetention');
        const imgs = await BottleImage.find({ bottle: { $in: orphanIds }, ...OWN_PHOTO })
          .select('originalUrl processedUrl').lean();
        for (const img of imgs) await unlinkImageFiles(img);
        await Promise.all([
          BottleImage.deleteMany({ bottle: { $in: orphanIds }, ...OWN_PHOTO }),
          BottleImage.updateMany({ bottle: { $in: orphanIds }, ...REGISTRY_PHOTO }, { $unset: { bottle: '' } }),
          Bottle.deleteMany({ _id: { $in: orphanIds } }),
        ]);
      }
      await Promise.all([
        Cellar.deleteMany({ user: ctx.userId }),
        // Remove the user from cellars OWNED BY OTHERS that they were a member of.
        Cellar.updateMany({ 'members.user': ctx.userId }, { $pull: { members: { user: ctx.userId } } }),
        // GAP FIX: also pull the matching userColors entry (was left dangling).
        Cellar.updateMany({ 'userColors.user': ctx.userId }, { $pull: { userColors: { user: ctx.userId } } }),
      ]);
    },
    exportFragment: async (ctx) => ({
      cellars: markTrunc(ctx, 'cellars', await Cellar.find({ $or: [{ user: ctx.userId }, { 'members.user': ctx.userId }], deletedAt: null }).limit(EXPORT_MAX).lean()),
    }),
  },
  {
    model: Rack, category: 'personal-data', userFields: ['user'],
    // Scoped to the user's OWNED cellars. A rack this user created inside
    // ANOTHER owner's cellar is deliberately NOT deleted here — it belongs to
    // that cellar and deleting it would damage another user's data (treated as
    // a contributor ref, follow-up).
    purge: (ctx) => Rack.deleteMany({ cellar: { $in: ctx.cellarIds } }),
    exportFragment: async (ctx) => ({ racks: markTrunc(ctx, 'racks', await Rack.find({ cellar: { $in: ctx.cellarIds }, deletedAt: null }).limit(EXPORT_MAX).lean()) }),
  },
  {
    model: CellarLayout, category: 'via-cellar', userFields: ['(via cellar)'],
    purge: (ctx) => CellarLayout.deleteMany({ cellar: { $in: ctx.cellarIds } }),
    // GAP FIX: was purged but never exported.
    exportFragment: async (ctx) => ({ cellarLayouts: markTrunc(ctx, 'cellarLayouts', await CellarLayout.find({ cellar: { $in: ctx.cellarIds } }).limit(EXPORT_MAX).lean()) }),
  },
  {
    model: WineList, category: 'personal-data', userFields: ['user'],
    // Uploaded restaurant logos are user content too — unlink them from disk
    // before the docs (and with them the only references) are deleted.
    purge: async (ctx) => {
      await deleteLogoFilesFor(WineList, { user: ctx.userId });
      return WineList.deleteMany({ user: ctx.userId });
    },
    exportFragment: async (ctx) => ({
      wineLists: markTrunc(ctx, 'wineLists', await WineList.find({ user: ctx.userId }).select('name cellar structureMode branding layout createdAt updatedAt').limit(EXPORT_MAX).lean())
        .map(wl => ({ name: wl.name, structureMode: wl.structureMode, branding: wl.branding, layout: wl.layout, createdAt: wl.createdAt })),
    }),
  },
  {
    model: WishlistItem, category: 'personal-data', userFields: ['user'],
    purge: (ctx) => WishlistItem.deleteMany({ user: ctx.userId }),
    // Trunc flag key kept as 'wishlistItems' to match the pre-refactor _truncated payload.
    exportFragment: async (ctx) => ({ wishlist: markTrunc(ctx, 'wishlistItems', await WishlistItem.find({ user: ctx.userId }).limit(EXPORT_MAX).lean()) }),
  },
  {
    // Registry lockdown (2026-09-06, L4): per-day distinct-wine read counters
    // keyed `user:<id>` for signed-in readers. Operational telemetry with a
    // 14-day TTL — purged with the account; the export carries the summary
    // (day, reads, distinct count), not the wine ids, which are registry
    // content rather than personal data.
    model: RegistryReadDay, category: 'personal-data', userFields: ['readerKey (user:<id>)'],
    purge: (ctx) => RegistryReadDay.deleteMany({ readerKey: `user:${ctx.userId}` }),
    exportFragment: async (ctx) => ({
      registryReads: markTrunc(ctx, 'registryReads', await RegistryReadDay.find({ readerKey: `user:${ctx.userId}` }).select('day count wines').limit(EXPORT_MAX).lean())
        .map((r) => ({ day: r.day, reads: r.count, distinctWines: (r.wines || []).length })),
    }),
  },
  {
    model: PersonalDataKey, category: 'personal-data', userFields: ['user'],
    purge: (ctx) => PersonalDataKey.deleteMany({ user: ctx.userId }),
    exportFragment: async (ctx) => ({ personalDataKeys: markTrunc(ctx, 'personalDataKeys', await PersonalDataKey.find({ user: ctx.userId }).limit(EXPORT_MAX).lean()) }),
  },
  {
    // Hard delete, not anonymise: unlike forum threads, an entry has no
    // multi-party thread to preserve — erasure removes the author's entries
    // even where cellar co-members could see them (issue #986 requirement).
    model: PersonalDataEntry, category: 'personal-data', userFields: ['author'],
    purge: (ctx) => PersonalDataEntry.deleteMany({ author: ctx.userId }),
    exportFragment: async (ctx) => ({ personalDataEntries: markTrunc(ctx, 'personalDataEntries', await PersonalDataEntry.find({ author: ctx.userId }).populate('key', 'name type unit').limit(EXPORT_MAX).lean()) }),
  },
  {
    // Analytics dashboards (#987): named per-user boards, pure preference
    // data — hard delete, full export.
    model: SavedDashboard, category: 'personal-data', userFields: ['user'],
    purge: (ctx) => SavedDashboard.deleteMany({ user: ctx.userId }),
    exportFragment: async (ctx) => ({ analyticsDashboards: markTrunc(ctx, 'analyticsDashboards', await SavedDashboard.find({ user: ctx.userId }).limit(EXPORT_MAX).lean()) }),
  },
  {
    // Pick lists (forum request 2026-10-13): the user's own named lists of
    // bottle references — pure personal data, hard delete, full export.
    model: PickList, category: 'personal-data', userFields: ['user'],
    purge: (ctx) => PickList.deleteMany({ user: ctx.userId }),
    exportFragment: async (ctx) => ({ pickLists: markTrunc(ctx, 'pickLists', await PickList.find({ user: ctx.userId }).limit(EXPORT_MAX).lean()) }),
  },
  {
    // Saved analytics views + preset stars (#987 saved-views slice).
    model: SavedView, category: 'personal-data', userFields: ['user'],
    purge: (ctx) => SavedView.deleteMany({ user: ctx.userId }),
    exportFragment: async (ctx) => ({ analyticsSavedViews: markTrunc(ctx, 'analyticsSavedViews', await SavedView.find({ user: ctx.userId }).limit(EXPORT_MAX).lean()) }),
  },
  {
    // The PUBLIC vocabulary is shared content (#985): an accepted key belongs
    // to the registry, not the proposer — anonymise provenance, keep the key.
    model: RegistryDataKey, category: 'shared-content', userFields: ['proposedBy', 'decidedBy'],
    purge: (ctx) => [
      RegistryDataKey.updateMany({ proposedBy: ctx.userId }, { $set: { proposedBy: ctx.deletedUserId } }),
      RegistryDataKey.updateMany({ decidedBy: ctx.userId }, { $unset: { decidedBy: '' } }),
    ],
    exportFragment: async (ctx) => ({ registryDataKeyProposals: markTrunc(ctx, 'registryDataKeyProposals', await RegistryDataKey.find({ proposedBy: ctx.userId }).select('name type unit enumOptions rationale status createdAt decidedAt rejectReason').limit(EXPORT_MAX).lean()) }),
  },
  {
    // Published values are registry content; suggestions carry attribution.
    // Anonymise both — the record survives its contributor (#985).
    model: RegistryDataValue, category: 'shared-content', userFields: ['suggestedBy', 'decidedBy'],
    purge: (ctx) => [
      // instanceHost can name a household; bridgeKey survives as an opaque
      // grouping id (see the WineDefinition entry in sharedRegistry.js for the reasoning).
      RegistryDataValue.updateMany({ suggestedBy: ctx.userId }, { $set: { suggestedBy: ctx.deletedUserId, instanceHost: null } }),
      RegistryDataValue.updateMany({ decidedBy: ctx.userId }, { $unset: { decidedBy: '' } }),
    ],
    exportFragment: async (ctx) => ({ registryDataValueSuggestions: markTrunc(ctx, 'registryDataValueSuggestions', await RegistryDataValue.find({ suggestedBy: ctx.userId }).populate('key', 'name type unit').select('wineDefinition key vintage value status reason evidenceUrl createdAt decidedAt rejectReason').limit(EXPORT_MAX).lean()) }),
  },
];
