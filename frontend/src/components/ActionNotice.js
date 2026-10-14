import { useTranslation } from 'react-i18next';
import './ActionNotice.css';

// Why an action just failed, said where the person is looking: a small fixed
// message at the bottom of the screen (above the phone's tab bar and above any
// open popup), until dismissed. Replaces the English browser alert() the rack
// pages used — and the actions that failed with no message at all.
//
// It floats, so it never moves anything on the page. No timer: an error that
// vanishes on its own can be missed; the next failure replaces it.
export default function ActionNotice({ message, onDismiss }) {
  const { t } = useTranslation();
  if (!message) return null;
  return (
    <div className="action-notice" role="alert">
      <span className="action-notice__text">{message}</span>
      <button
        type="button"
        className="action-notice__close"
        onClick={onDismiss}
        aria-label={t('common.close', 'Close')}
      >
        ✕
      </button>
    </div>
  );
}
