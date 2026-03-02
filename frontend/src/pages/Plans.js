import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { PLANS, PLAN_NAMES } from '../config/plans';
import './Plans.css';

function Plans() {
  const { t } = useTranslation();
  const { user, startTrial } = useAuth();
  const [trialLoading, setTrialLoading] = useState(false);
  const [trialError, setTrialError] = useState(null);

  const userPlan = user?.plan || 'free';
  const userExpiresAt = user?.planExpiresAt || null;
  const planExpired = userExpiresAt && Date.now() > new Date(userExpiresAt).getTime();

  const isPremiumActive = userPlan === 'premium' && !planExpired;
  const canTrial = !isPremiumActive && user?.trialEligible === true;

  async function handleStartTrial() {
    setTrialLoading(true);
    setTrialError(null);
    const result = await startTrial();
    setTrialLoading(false);
    if (!result.success) setTrialError(result.error);
  }

  function formatExpiry(expiresAt) {
    if (!expiresAt) return t('plans.noExpiry');
    if (Date.now() > new Date(expiresAt).getTime()) return t('plans.expired');
    return new Date(expiresAt).toLocaleDateString(undefined, {
      year: 'numeric', month: 'long', day: 'numeric'
    });
  }

  return (
    <div className="plans-page">
      <div className="plans-header">
        <h1>{t('plans.title')}</h1>
        <p className="plans-subtitle">{t('plans.subtitle')}</p>
      </div>

      {/* Current plan banner */}
      <div className={`plans-current-banner plans-current-banner--${userPlan}`}>
        <span className="plans-current-label">{t('plans.yourPlan')}</span>
        <span className={`plans-badge plans-badge--${userPlan}`}>{PLANS[userPlan]?.label || userPlan}</span>
        <span className="plans-current-expiry">
          {planExpired
            ? <span className="plans-expiry--expired">{t('plans.expired')}</span>
            : <>{t('plans.expires')} {formatExpiry(userExpiresAt)}</>
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
                <div className="plans-card-current-tag">{t('plans.currentTag')}</div>
              )}
              <div className="plans-card-header">
                <h2 className={`plans-card-name plans-card-name--${planKey}`}>{plan.label}</h2>
                <p className="plans-card-desc">{plan.description}</p>
              </div>
              <ul className="plans-feature-list">
                {plan.featureList.map((feature, i) => (
                  <li key={i} className="plans-feature-item">
                    <span className="plans-feature-check">✓</span>
                    {feature}
                  </li>
                ))}
              </ul>

              {planKey === 'premium' && canTrial && (
                <div className="plans-trial-wrap">
                  <button
                    className="btn btn-primary plans-trial-btn"
                    onClick={handleStartTrial}
                    disabled={trialLoading}
                  >
                    {trialLoading ? t('common.saving') : t('plans.tryPremium')}
                  </button>
                  {trialError && <p className="plans-trial-error">{trialError}</p>}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <p className="plans-admin-note">{t('plans.adminManaged')}</p>
    </div>
  );
}

export default Plans;
