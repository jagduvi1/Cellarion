import { useTranslation } from 'react-i18next';

/**
 * The lines on the import's done screen about what still happens after it:
 * wines a curator still looks at, photos still being copied in. Plain lines,
 * no dialog and no extra step: the bottles ARE imported, so this is
 * information, not an action.
 *
 *   pendingIdentityCount  wines that could not be fully identified from the
 *                         file (no producer): a curator completes them;
 *   uncheckedCount        new wines a curator checks before other members can
 *                         see them (a server setting, backend
 *                         config/importPolicy);
 *   photosQueued          photos the file links to, copied onto the bottles
 *                         in the background (backend services/importPhotos),
 *                         each then handled like any uploaded photo;
 *   photosNotQueued       photos the server could not take (the member's
 *                         daily room, a full queue, a restart under way).
 *
 * Renders nothing when all are zero. Used by pages/ImportBottles.
 */
export default function ImportCurationNotes({ result }) {
  const { t } = useTranslation();
  const incomplete = result?.pendingIdentityCount || 0;
  const unchecked = result?.uncheckedCount || 0;
  const photos = result?.photosQueued || 0;
  const photosLeftOut = result?.photosNotQueued || 0;
  if (!incomplete && !unchecked && !photos && !photosLeftOut) return null;
  return (
    <>
      {incomplete > 0 && (
        <p className="done-note">
          {/* `n`, not `count`: passing i18next's magic `count` would demand a
              plural-suffix key pair, which this codebase's i18n workflow keeps
              out of feature PRs. */}
          {t('importBottles.done.pendingIdentityNote', { n: incomplete })}
        </p>
      )}
      {unchecked > 0 && (
        <p className="done-note">{t('importBottles.done.uncheckedNote', { n: unchecked })}</p>
      )}
      {photos > 0 && (
        <p className="done-note">{t('importBottles.done.photosQueuedNote', { n: photos })}</p>
      )}
      {photosLeftOut > 0 && (
        <p className="done-note">{t('importBottles.done.photosNotQueuedNote', { n: photosLeftOut })}</p>
      )}
    </>
  );
}
