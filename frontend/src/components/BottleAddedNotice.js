import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import './BottleUndoNotice.css';

/**
 * The line the cellar page shows after the add page saved bottles — with the
 * next one a tap away ("Add another bottle"). A newcomer adding a few wines
 * in a row had to find the add button again after every save (newcomer
 * walkthrough 2026-10-15). Same look as BottleUndoNotice.
 *
 * `notice` = { name, count, history, at } — handed over in the navigation's
 * router state by AddBottle (hooks/useHandedOverState).
 */
export default function BottleAddedNotice({ notice, cellarId, onDismiss }) {
  const { t } = useTranslation();
  const name = notice.name || t('bottleNotice.thisBottle', 'The bottle');
  const count = notice.count > 0 ? notice.count : 1;
  const text = notice.history
    ? t('bottleNotice.addedToHistory', { name, count })
    : t('bottleNotice.added', { name, count });
  return (
    <div className="alert alert-success bottle-undo-notice" role="status">
      <span className="bottle-undo-notice__text">{text}</span>
      <Link to={`/cellars/${cellarId}/add-bottle`} className="btn btn-small btn-secondary">
        {t('bottleNotice.addAnother', 'Add another bottle')}
      </Link>
      <button
        type="button"
        className="btn btn-small btn-secondary bottle-undo-notice__close"
        onClick={onDismiss}
        aria-label={t('common.close', 'Close')}
      >
        ✕
      </button>
    </div>
  );
}
