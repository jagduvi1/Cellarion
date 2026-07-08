import { useTranslation, Trans } from 'react-i18next';

function Unsubscribed() {
  const { t } = useTranslation();
  return (
    <div style={{ maxWidth: 480, margin: '4rem auto', padding: '2rem', textAlign: 'center' }}>
      <h1>{t('unsubscribed.title')}</h1>
      <p>{t('unsubscribed.message')}</p>
      <p>
        <Trans i18nKey="unsubscribed.reEnable">
          You can re-enable individual categories at any time from <a href="/settings">Settings</a>.
        </Trans>
      </p>
    </div>
  );
}

export default Unsubscribed;
