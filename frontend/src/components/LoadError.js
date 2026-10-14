import { useTranslation } from 'react-i18next';
import './LoadError.css';

// What a list shows when it could not be loaded — in place of its empty state.
// Before this, a failed load fell through to "You have no cellars yet" / "No
// bottles in this cellar yet", which on a weak signal reads as "my data is
// gone" and invites adding everything again. Says what happened in the user's
// language and offers the one useful action: load it again.
export default function LoadError({ message, onRetry }) {
  const { t } = useTranslation();
  return (
    <div className="load-error" role="alert">
      <p>{message || t('common.loadFailed', 'This could not be loaded. Check your connection and try again.')}</p>
      {onRetry && (
        <button type="button" className="btn btn-secondary btn-small" onClick={onRetry}>
          {t('common.retry', 'Retry')}
        </button>
      )}
    </div>
  );
}
