import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { PLANS } from '../config/plans';
import { createCheckout, createPortal } from '../api/stripe';
import './Plans.css';

// Donation tiers, in ascending order. Everything in Cellarion is free — these
// are voluntary contributions that unlock nothing extra.
const DONATE_TIERS = ['supporter', 'patron'];

function Supporter() {
  const { t } = useTranslation();
  const { user, apiFetch } = useAuth();
  const [actionError, setActionError] = useState(null);
  const [checkoutLoading, setCheckoutLoading] = useState(null);

  const hasStripeSubscription = !!user?.stripeSubscriptionId;

  async function handleCheckout(plan) {
    setCheckoutLoading(plan);
    try {
      const res = await createCheckout(apiFetch, plan);
      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
      } else if (data.code === 'subscription_exists') {
        // Already supporting — send them to the portal to change/cancel rather
        // than creating a second subscription (the backend blocks that with 409).
        setCheckoutLoading(null);
        handleManageSubscription();
      } else {
        setActionError(data.error || t('supporter.checkoutError'));
        setCheckoutLoading(null);
      }
    } catch {
      setActionError(t('supporter.checkoutError'));
      setCheckoutLoading(null);
    }
  }

  async function handleManageSubscription() {
    try {
      const res = await createPortal(apiFetch);
      const data = await res.json();
      if (data.url) window.location.href = data.url;
    } catch {
      setActionError(t('supporter.portalError'));
    }
  }

  return (
    <div className="plans-page">
      <div className="plans-header">
        <h1>{t('supporter.title')}</h1>
        <p className="plans-subtitle">{t('supporter.subtitle')}</p>
      </div>

      <div className="donate-card">
        <p className="donate-lead">{t('supporter.everythingFree')}</p>
        <p className="donate-body">{t('supporter.donateExplain')}</p>

        {hasStripeSubscription ? (
          <>
            <p className="donate-thanks">{t('supporter.alreadySupporting')}</p>
            <div className="plans-manage-wrap">
              <button className="btn btn-secondary" onClick={handleManageSubscription}>
                {t('supporter.manageSubscription')}
              </button>
            </div>
          </>
        ) : (
          <div className="donate-buttons">
            {DONATE_TIERS.map(key => (
              <button
                key={key}
                className="btn btn-primary donate-btn"
                onClick={() => handleCheckout(key)}
                disabled={checkoutLoading === key}
              >
                {checkoutLoading === key
                  ? t('common.saving')
                  : t('supporter.supportAmount', { amount: `$${PLANS[key].price.toFixed(2)}` })}
              </button>
            ))}
          </div>
        )}

        {actionError && <p className="plans-trial-error">{actionError}</p>}

        <p className="donate-note">{t('supporter.openSourceNote')}</p>
      </div>
    </div>
  );
}

export default Supporter;
