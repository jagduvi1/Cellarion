import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { PLANS, PLAN_NAMES, formatChatQuota } from '../config/plans';
import './Plans.css';

function Supporter() {
  const { t } = useTranslation();
  const { user, startTrial } = useAuth();
  const [trialLoading, setTrialLoading] = useState(false);
  const [trialError, setTrialError] = useState(null);

  const userPlan = user?.plan || 'free';
  const userExpiresAt = user?.planExpiresAt || null;
  const planExpired = userExpiresAt && Date.now() > new Date(userExpiresAt).getTime();

  const isPatronActive = userPlan === 'patron' && !planExpired;
  const canTrial = !isPatronActive && user?.trialEligible === true;

  async function handleStartTrial() {
    setTrialLoading(true);
    setTrialError(null);
    const result = await startTrial();
    setTrialLoading(false);
    if (!result.success) setTrialError(result.error);
  }

  function formatExpiry(expiresAt) {
    if (!expiresAt) return t('supporter.noExpiry');
    if (Date.now() > new Date(expiresAt).getTime()) return t('supporter.expired');
    return new Date(expiresAt).toLocaleDateString(undefined, {
      year: 'numeric', month: 'long', day: 'numeric'
    });
  }

  function formatPrice(price) {
    if (price === 0) return t('supporter.free');
    return `$${price.toFixed(2)} / ${t('supporter.month')}`;
  }

  return (
    <div className="plans-page">
      <div className="plans-header">
        <h1>{t('supporter.title')}</h1>
        <p className="plans-subtitle">{t('supporter.subtitle')}</p>
      </div>

      {/* Current tier banner */}
      <div className={`plans-current-banner plans-current-banner--${userPlan}`}>
        <span className="plans-current-label">{t('supporter.yourTier')}</span>
        <span className={`plans-badge plans-badge--${userPlan}`}>{PLANS[userPlan]?.label || userPlan}</span>
        <span className="plans-current-expiry">
          {planExpired
            ? <span className="plans-expiry--expired">{t('supporter.expired')}</span>
            : <>{t('supporter.expires')} {formatExpiry(userExpiresAt)}</>
          }
        </span>
      </div>

      {/* Comparison table */}
      <div className="plans-grid">
        {PLAN_NAMES.map(planKey => {
          const plan = PLANS[planKey];
          const isCurrent = userPlan === planKey && !planExpired;
          return (
            <div
              key={planKey}
              className={`plans-card ${isCurrent ? 'plans-card--current' : ''}`}
            >
              {isCurrent && (
                <div className="plans-card-current-tag">{t('supporter.currentTag')}</div>
              )}
              <div className="plans-card-header">
                <h2 className={`plans-card-name plans-card-name--${planKey}`}>{plan.label}</h2>
                <p className="plans-card-price">{formatPrice(plan.price)}</p>
                <p className="plans-card-desc">{plan.description}</p>
                <p className="plans-card-chat">
                  Cellar Chat: <strong>{formatChatQuota(plan.chatQuota)}</strong>
                </p>
              </div>
              <ul className="plans-feature-list">
                {plan.featureList.map((feature, i) => (
                  <li key={i} className="plans-feature-item">
                    <span className="plans-feature-check">{'\u2713'}</span>
                    {feature}
                  </li>
                ))}
              </ul>

              {planKey === 'patron' && canTrial && (
                <div className="plans-trial-wrap">
                  <button
                    className="btn btn-primary plans-trial-btn"
                    onClick={handleStartTrial}
                    disabled={trialLoading}
                  >
                    {trialLoading ? t('common.saving') : t('supporter.tryPatron')}
                  </button>
                  {trialError && <p className="plans-trial-error">{trialError}</p>}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <p className="plans-admin-note">{t('supporter.allFeaturesNote')}</p>
    </div>
  );
}

export default Supporter;
