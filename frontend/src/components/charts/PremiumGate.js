import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

function PremiumGate() {
  const { t } = useTranslation();
  return (
    <div className="premium-gate">
      <div className="premium-gate-glow" />
      <div className="premium-gate-icon">{'\ud83d\udcca'}</div>
      <h1>{t('statistics.title')}</h1>
      <p className="premium-gate-sub">
        {t('statistics.premiumGate.desc')}
      </p>
      <div className="premium-gate-features">
        <div className="pgf-item"><span>{'\ud83c\udf77'}</span> {t('statistics.premiumGate.feat1')}</div>
        <div className="pgf-item"><span>{'\ud83d\udcc5'}</span> {t('statistics.premiumGate.feat2')}</div>
        <div className="pgf-item"><span>{'\ud83d\udcb0'}</span> {t('statistics.premiumGate.feat3')}</div>
        <div className="pgf-item"><span>{'\u23f1'}</span> {t('statistics.premiumGate.feat4')}</div>
        <div className="pgf-item"><span>{'\ud83c\udfaf'}</span> {t('statistics.premiumGate.feat5')}</div>
        <div className="pgf-item"><span>{'\ud83d\ude2c'}</span> {t('statistics.premiumGate.feat6')}</div>
        <div className="pgf-item"><span>{'\ud83d\udea8'}</span> {t('statistics.premiumGate.feat7')}</div>
        <div className="pgf-item"><span>{'\ud83d\udc8e'}</span> {t('statistics.premiumGate.feat8')}</div>
      </div>
      <Link to="/plans" className="btn btn-primary premium-gate-btn">
        {t('statistics.premiumGate.upgradeBtn')}
      </Link>
      <p className="premium-gate-trial">
        {t('statistics.premiumGate.notSure')} <Link to="/plans">{t('statistics.premiumGate.startTrial')}</Link>
      </p>
    </div>
  );
}

export default PremiumGate;
