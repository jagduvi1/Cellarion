import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

function UpgradeCard({ plan = 'basic', features = [], fullWidth = false }) {
  const { t } = useTranslation();
  const isPremiumCard = plan === 'premium';
  const label  = isPremiumCard ? 'Premium' : 'Basic';
  const color  = isPremiumCard ? '#7B5A8A' : '#4a8a9a';
  const badge  = isPremiumCard ? '\u2605 Premium' : 'Basic';

  return (
    <div className={`stats-card upgrade-card upgrade-card--${plan}${fullWidth ? ' stats-card--full' : ''}`}>
      <div className="upgrade-card-inner">
        <div className="upgrade-card-header">
          <span className="upgrade-card-icon">{'\ud83d\udd12'}</span>
          <span className="upgrade-card-badge" style={{ color }}>{badge}</span>
        </div>
        <p className="upgrade-card-tagline">{t('statistics.upgrade.unlockWith', { plan: label })}</p>
        {features.length > 0 && (
          <div className="upgrade-card-features">
            {features.map((f, i) => (
              <span key={i} className="upgrade-card-feature">{f}</span>
            ))}
          </div>
        )}
        <Link to="/plans" className="btn upgrade-card-btn" style={{ borderColor: color, color }}>
          {t('statistics.upgrade.upgradeTo', { plan: label })}
        </Link>
      </div>
    </div>
  );
}

export default UpgradeCard;
