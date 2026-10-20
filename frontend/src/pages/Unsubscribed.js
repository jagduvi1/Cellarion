import { useSearchParams } from 'react-router-dom';
import { useTranslation, Trans } from 'react-i18next';

// Where the one-click unsubscribe links land. `?only=support` comes from the
// support-reply email's "stop emailing me answers" link, `?only=owner-questions`
// from the owner-question email's "stop emailing me questions" link; each
// turned off that one email and nothing else — the page must not claim more.
const ONLY_MESSAGES = {
  support: 'unsubscribed.messageSupport',
  'owner-questions': 'unsubscribed.messageOwnerQuestions',
};

function Unsubscribed() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const onlyKey = ONLY_MESSAGES[params.get('only')];
  return (
    <div style={{ maxWidth: 480, margin: '4rem auto', padding: '2rem', textAlign: 'center' }}>
      <h1>{t('unsubscribed.title')}</h1>
      <p>{onlyKey ? t(onlyKey) : t('unsubscribed.message')}</p>
      <p>
        <Trans i18nKey="unsubscribed.reEnable">
          You can re-enable individual categories at any time from <a href="/settings#notifications">Settings</a>.
        </Trans>
      </p>
    </div>
  );
}

export default Unsubscribed;
