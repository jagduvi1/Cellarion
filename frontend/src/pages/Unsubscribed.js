import { useSearchParams } from 'react-router-dom';
import { useTranslation, Trans } from 'react-i18next';

// Where the one-click unsubscribe links land. `?only=support` comes from the
// support-reply email's "stop emailing me answers" link, which turned off that
// one email and nothing else — the page must not claim more than that.
function Unsubscribed() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const supportOnly = params.get('only') === 'support';
  return (
    <div style={{ maxWidth: 480, margin: '4rem auto', padding: '2rem', textAlign: 'center' }}>
      <h1>{t('unsubscribed.title')}</h1>
      <p>{supportOnly ? t('unsubscribed.messageSupport') : t('unsubscribed.message')}</p>
      <p>
        <Trans i18nKey="unsubscribed.reEnable">
          You can re-enable individual categories at any time from <a href="/settings#notifications">Settings</a>.
        </Trans>
      </p>
    </div>
  );
}

export default Unsubscribed;
