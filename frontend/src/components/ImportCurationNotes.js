import { useTranslation } from 'react-i18next';

/**
 * The lines on the import's done screen about wines a curator still looks at.
 * Plain lines, no dialog and no extra step: the bottles ARE imported, so this
 * is information, not an action.
 *
 *   pendingIdentityCount  wines that could not be fully identified from the
 *                         file (no producer): a curator completes them;
 *   uncheckedCount        new wines a curator checks before other members can
 *                         see them (a server setting, backend
 *                         config/importPolicy).
 *
 * Renders nothing when both are zero. Used by pages/ImportBottles.
 */
export default function ImportCurationNotes({ result }) {
  const { t } = useTranslation();
  const incomplete = result?.pendingIdentityCount || 0;
  const unchecked = result?.uncheckedCount || 0;
  if (!incomplete && !unchecked) return null;
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
    </>
  );
}
