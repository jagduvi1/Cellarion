/**
 * Which photos belong to the shared registry, and so outlive the bottle they
 * were taken of and the account that uploaded them (policy, 2026-09-27).
 *
 * A photo an admin approved as PUBLIC is registry content: every owner of the
 * wine sees it, it may be the wine's picture, and other people's cellars and
 * exports point at it. Deleting it with its bottle, or with its uploader's
 * account, would take a picture away from everyone else — so it is kept and,
 * on account deletion, anonymised (uploadedBy re-pointed to the [deleted]
 * sentinel, like forum content). Until 2026-09-27 only the wine's chosen
 * picture (assignedToWine) was kept; every other approved photo went with the
 * bottle or the account.
 *
 * Everything else — pending, private, rejected tombstones, and every label
 * scan (private curation evidence, never approvable) — is the uploader's own
 * and is deleted with them. The rule is defined ONCE here; every cascade
 * (bottle delete/undo, cellar purge, overwrite import, account erasure, the
 * orphan sweep) reads it from here so they can never drift.
 */

// A photo the registry keeps.
const REGISTRY_PHOTO = {
  kind: { $ne: 'label-scan' },
  $or: [
    { assignedToWine: true },
    { status: 'approved', visibility: 'public' },
  ],
};

// Its complement — photos that go with their bottle / account. Written out
// (not `$nor: [REGISTRY_PHOTO]`) so it stays readable in a query log.
const OWN_PHOTO = {
  $or: [
    { kind: 'label-scan' },
    {
      assignedToWine: { $ne: true },
      $nor: [{ status: 'approved', visibility: 'public' }],
    },
  ],
};

/** The same rule for one loaded document / plain object. */
function isRegistryPhoto(img) {
  if (!img || img.kind === 'label-scan') return false;
  return img.assignedToWine === true || (img.status === 'approved' && img.visibility === 'public');
}

module.exports = { REGISTRY_PHOTO, OWN_PHOTO, isRegistryPhoto };
