import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import './BottleUndoNotice.css';

/**
 * The line the cellar page shows after the add page saved bottles — with the
 * next one a tap away ("Add another bottle"). A newcomer adding a few wines
 * in a row had to find the add button again after every save (newcomer
 * walkthrough 2026-10-15). Same look as BottleUndoNotice.
 *
 * `notice` = { name, count, history, onOrder } — handed over in the navigation's
 * router state by AddBottle (hooks/useHandedOverState), to the cellar page or
 * the On order list.
 */
export default function BottleAddedNotice({ notice, cellarId, onDismiss }) {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  // The next bottle is added the same way (on order, to the history), and
  // the add page comes back here when done (pages/AddBottle leaveTo).
  const addMode = notice.onOrder ? 'onOrder' : notice.history ? 'history' : undefined;
  const name = notice.name;
  const count = notice.count > 0 ? notice.count : 1;
  // Without a wine name (none should reach here), no quoted stand-in.
  const text = !name
    ? t('bottleNotice.addedUnnamed', { count })
    : notice.history
      ? t('bottleNotice.addedToHistory', { name, count })
      : t('bottleNotice.added', { name, count });
  return (
    <div className="alert alert-success bottle-undo-notice" role="status">
      <span className="bottle-undo-notice__text">{text}</span>
      <Link to={`/cellars/${cellarId}/add-bottle`} state={{ cameFrom: pathname, addMode }} className="btn btn-small btn-secondary">
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
