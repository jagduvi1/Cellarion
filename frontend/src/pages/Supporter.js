import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { PLANS } from '../config/plans';
import { createCheckout, createPortal } from '../api/stripe';
import './Plans.css';

const GITHUB_URL = 'https://github.com/jagduvi1/Cellarion';

/**
 * Shared support call-to-action — rendered both at the top (compact, the first
 * thing you see) and inside the bottom donate card (the last thing you see).
 * `compact` drops the reassurance line so the top instance stays punchy.
 */
function DonateActions({
  compact, hasStripeSubscription, checkoutLoading, onCheckout, onManage,
  actionError, billingInterval, onIntervalChange, t,
}) {
  if (hasStripeSubscription) {
    return (
      <>
        <p className="donate-thanks">{t('supporter.alreadySupporting')}</p>
        <div className="plans-manage-wrap">
          <button className="btn btn-secondary" onClick={onManage}>
            {t('supporter.manageSubscription')}
          </button>
        </div>
        {actionError && <p className="plans-trial-error">{actionError}</p>}
      </>
    );
  }

  const yearly = billingInterval === 'year';
  // Yearly figures come from PLANS.annualPrice rather than price × 12 so the
  // label can never drift from the Stripe Price if one is ever discounted.
  const amount = (tier) =>
    `$${(yearly ? PLANS[tier].annualPrice : PLANS[tier].price).toFixed(2)}`;

  return (
    <>
      <div className="billing-toggle" role="group" aria-label={t('supporter.billingIntervalLabel')}>
        {['month', 'year'].map((iv) => (
          <button
            key={iv}
            type="button"
            className={`billing-toggle-btn${billingInterval === iv ? ' is-active' : ''}`}
            aria-pressed={billingInterval === iv}
            onClick={() => onIntervalChange(iv)}
          >
            {t(iv === 'month' ? 'supporter.billingMonthly' : 'supporter.billingYearly')}
          </button>
        ))}
      </div>
      <div className="donate-buttons">
        <button
          className="btn btn-primary donate-btn"
          onClick={() => onCheckout('supporter')}
          disabled={checkoutLoading === 'supporter'}
        >
          {checkoutLoading === 'supporter'
            ? t('common.saving')
            : t(yearly ? 'supporter.supporterCtaYear' : 'supporter.supporterCta', { amount: amount('supporter') })}
        </button>
        <button
          className="btn btn-secondary donate-btn"
          onClick={() => onCheckout('patron')}
          disabled={checkoutLoading === 'patron'}
        >
          {checkoutLoading === 'patron'
            ? t('common.saving')
            : t(yearly ? 'supporter.patronCtaYear' : 'supporter.patronCta', { amount: amount('patron') })}
        </button>
      </div>
      {!compact && (
        <p className="donate-reassure">
          {t(yearly ? 'supporter.reassureYear' : 'supporter.reassure')}
        </p>
      )}
      {actionError && <p className="plans-trial-error">{actionError}</p>}
    </>
  );
}

function Supporter() {
  const { t } = useTranslation();
  const { user, apiFetch } = useAuth();
  const [actionError, setActionError] = useState(null);
  const [checkoutLoading, setCheckoutLoading] = useState(null);
  // Named billingInterval, not interval — `setInterval` would shadow the DOM global.
  const [billingInterval, setBillingInterval] = useState('month');

  // Derived boolean from User.toJSON — the raw stripeSubscriptionId is no
  // longer serialised to the client (data minimisation).
  const hasStripeSubscription = !!user?.hasStripeSubscription;

  async function handleCheckout(plan) {
    setCheckoutLoading(plan);
    try {
      const res = await createCheckout(apiFetch, plan, billingInterval);
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

  // Qualitative "where your support goes" buckets — no tier buys anything different.
  const buckets = [
    { icon: '🖥️', label: t('supporter.whereHosting'), desc: t('supporter.whereHostingDesc') },
    { icon: '✨', label: t('supporter.whereAI'), desc: t('supporter.whereAIDesc') },
    { icon: '🛠️', label: t('supporter.whereDev'), desc: t('supporter.whereDevDesc') },
  ];

  const actionProps = {
    hasStripeSubscription,
    checkoutLoading,
    onCheckout: handleCheckout,
    onManage: handleManageSubscription,
    actionError,
    billingInterval,
    onIntervalChange: setBillingInterval,
    t,
  };

  return (
    <div className="plans-page">
      <div className="plans-header">
        <h1>
          <span className="support-emoji" aria-hidden="true">🍷 </span>
          {t('supporter.title')}
        </h1>
        <p className="plans-subtitle support-subtitle">{t('supporter.subtitle')}</p>
        <div className="support-chips">
          <span className="support-chip support-chip--license">{t('supporter.licenseChip')}</span>
          <a
            className="support-chip support-chip--link"
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            <span className="support-chip-glyph" aria-hidden="true">{'</>'}</span>
            {t('supporter.viewSource')} →
          </a>
        </div>
      </div>

      {/* Top CTA — the first thing you see */}
      <div className="donate-top">
        <DonateActions compact {...actionProps} />
      </div>

      {/* Prose: free + costs */}
      <div className="support-card">
        <h2 className="support-h2">
          <span className="support-h2-icon" aria-hidden="true">🔓</span>
          {t('supporter.freeHeading')}
        </h2>
        <p className="support-p">{t('supporter.freeBody')}</p>

        <h2 className="support-h2">
          <span className="support-h2-icon" aria-hidden="true">🧾</span>
          {t('supporter.costsHeading')}
        </h2>
        <p className="support-p">{t('supporter.costsBody')}</p>
      </div>

      {/* Where your support goes */}
      <p className="support-eyebrow">{t('supporter.whereEyebrow')}</p>
      <div className="support-goes">
        {buckets.map((b, i) => (
          <div className="support-goes-row" key={i}>
            <span className="support-goes-icon" aria-hidden="true">{b.icon}</span>
            <span className="support-goes-label">{b.label}</span>
            <span className="support-goes-desc">{b.desc}</span>
          </div>
        ))}
      </div>
      <p className="support-goes-caption">{t('supporter.whereCaption')}</p>

      {/* Bottom donate card — the last thing you see */}
      <div className="donate-card donate-card--accent">
        <p className="donate-lead">{t('supporter.donateLead')}</p>
        <p className="donate-body">{t('supporter.donateBody')}</p>
        <DonateActions {...actionProps} />
        <p className="donate-note">{t('supporter.donateNote')}</p>
      </div>
    </div>
  );
}

export default Supporter;
