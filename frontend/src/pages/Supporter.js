import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { PLANS, PAID_PLAN_NAMES } from '../config/plans';
import { createCheckout, createPortal, getAvailability } from '../api/stripe';
import './Plans.css';

const GITHUB_URL = 'https://github.com/jagduvi1/Cellarion';
const SPONSORS_URL = 'https://github.com/sponsors/jagduvi1';

/** Yearly first: the cadence we want chosen is the one read first and preselected. */
const INTERVALS = ['year', 'month'];

/** `$24` / `$5` — trailing `.00` is noise on prices that are whole dollars. */
function formatAmount(value) {
  return `$${Number.isInteger(value) ? value : value.toFixed(2)}`;
}

/**
 * Billing-cadence segmented control. Yearly carries a plain-language note
 * rather than a discount badge — there is no discount to advertise, only the
 * card-fee saving, and overstating it would undercut the page's whole tone.
 */
function BillingToggle({ billingInterval, onIntervalChange, t }) {
  return (
    <div className="billing-toggle" role="group" aria-label={t('supporter.billingIntervalLabel')}>
      {INTERVALS.map((iv) => (
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
  );
}

/**
 * One tier card. Every tier grants the identical app, so the card sells the
 * SIZE of the gift, not a feature set: an amount, what that amount is worth in
 * wine, and what it covers. The middle tier is marked `suggested` in the plan
 * config and lifted here — with three amounts the extremes frame the middle,
 * which is the one most people actually want permission to choose.
 */
function TierCard({ tier, yearly, available, loading, onCheckout, t }) {
  const plan = PLANS[tier];
  const amount = formatAmount(yearly ? plan.annualPrice : plan.price);
  const perMonth = formatAmount(plan.price);

  return (
    <div className={`tier-card${plan.suggested ? ' tier-card--suggested' : ''}`}>
      {plan.suggested && (
        <span className="tier-card-flag">{t('supporter.suggestedFlag')}</span>
      )}
      <h3 className="tier-card-name">{plan.label}</h3>

      <p className="tier-card-price">
        <span className="tier-card-amount">{amount}</span>
        <span className="tier-card-period">
          {t(yearly ? 'supporter.perYear' : 'supporter.perMonth')}
        </span>
      </p>
      {/* Monthly equivalent keeps the yearly figure from reading as a big ask. */}
      <p className="tier-card-equiv">
        {yearly
          ? t('supporter.equivPerMonth', { amount: perMonth })
          : t('supporter.equivPerYear', { amount: formatAmount(plan.annualPrice) })}
      </p>

      <p className="tier-card-analogy">{t(`supporter.analogy.${tier}`)}</p>

      {available ? (
        <button
          className={`btn ${plan.suggested ? 'btn-primary' : 'btn-secondary'} tier-card-btn`}
          onClick={() => onCheckout(tier)}
          disabled={loading === tier}
        >
          {loading === tier ? t('common.saving') : t('supporter.chooseCta')}
        </button>
      ) : (
        <p className="tier-card-unavailable">{t('supporter.tierUnavailable')}</p>
      )}
    </div>
  );
}

/**
 * The support call-to-action: cadence toggle, the three tier cards, and the
 * custom-amount escape hatch. Rendered once — a second full copy lower down
 * read as pressure rather than as a reminder, so the bottom of the page closes
 * with prose and a link back up instead.
 */
function SupportPicker({
  hasStripeSubscription, checkoutLoading, onCheckout, onManage,
  actionError, billingInterval, onIntervalChange, availability, t,
}) {
  if (hasStripeSubscription) {
    return (
      <div className="donate-card donate-card--accent">
        <p className="donate-thanks">{t('supporter.alreadySupporting')}</p>
        <div className="plans-manage-wrap">
          <button className="btn btn-secondary" onClick={onManage}>
            {t('supporter.manageSubscription')}
          </button>
        </div>
        {actionError && <p className="plans-trial-error">{actionError}</p>}
      </div>
    );
  }

  const yearly = billingInterval === 'year';
  // Optimism applies only BEFORE availability loads — flashing "unavailable" on
  // a healthy install is worse than a rare late correction. Once it has loaded
  // the answer is authoritative, including for a tier the backend prices at all:
  // a tier in this config but absent from the backend's PRICE_ENV would
  // otherwise render a live button that 400s with "Invalid plan".
  const isAvailable = (tier) =>
    availability === null ? true : !!availability.tiers?.[tier]?.[billingInterval];

  return (
    <section className="support-picker" aria-labelledby="support-picker-heading">
      <h2 id="support-picker-heading" className="support-picker-heading">
        {t('supporter.pickerHeading')}
      </h2>

      <BillingToggle
        billingInterval={billingInterval}
        onIntervalChange={onIntervalChange}
        t={t}
      />
      <p className="billing-note">
        {t(yearly ? 'supporter.yearlyNote' : 'supporter.monthlyNote')}
      </p>

      <div className="tier-grid">
        {PAID_PLAN_NAMES.map((tier) => (
          <TierCard
            key={tier}
            tier={tier}
            yearly={yearly}
            available={isAvailable(tier)}
            loading={checkoutLoading}
            onCheckout={onCheckout}
            t={t}
          />
        ))}
      </div>

      <p className="tier-grid-note">{t('supporter.sameAppNote')}</p>
      {actionError && <p className="plans-trial-error">{actionError}</p>}

      {/* Custom / one-time amounts — a peer of the tiers, not a footnote. */}
      <a
        className="custom-amount"
        href={SPONSORS_URL}
        target="_blank"
        rel="noopener noreferrer"
      >
        <span className="custom-amount-icon" aria-hidden="true">♥</span>
        <span className="custom-amount-text">
          <span className="custom-amount-title">{t('supporter.customTitle')}</span>
          <span className="custom-amount-desc">{t('supporter.customDesc')}</span>
        </span>
        <span className="custom-amount-arrow" aria-hidden="true">→</span>
      </a>

      <p className="donate-reassure">{t('supporter.reassure')}</p>
    </section>
  );
}

function Supporter() {
  const { t } = useTranslation();
  const { user, apiFetch } = useAuth();
  const [actionError, setActionError] = useState(null);
  const [checkoutLoading, setCheckoutLoading] = useState(null);
  const [availability, setAvailability] = useState(null);
  // Named billingInterval, not interval — `setInterval` would shadow the DOM global.
  // Defaults to 'year': one card fee a year instead of twelve means materially
  // more of the same gift arrives, and the default is what most people accept.
  const [billingInterval, setBillingInterval] = useState('year');

  // Derived boolean from User.toJSON — the raw stripeSubscriptionId is no
  // longer serialised to the client (data minimisation).
  const hasStripeSubscription = !!user?.hasStripeSubscription;

  useEffect(() => {
    let cancelled = false;
    if (hasStripeSubscription) return undefined;
    (async () => {
      try {
        const res = await getAvailability(apiFetch);
        const data = await res.json();
        if (!cancelled) setAvailability(data);
      } catch {
        // Non-fatal: every tier stays optimistically enabled and a genuinely
        // unconfigured price still fails loudly at checkout.
      }
    })();
    return () => { cancelled = true; };
  }, [apiFetch, hasStripeSubscription]);

  const handleManageSubscription = useCallback(async () => {
    try {
      const res = await createPortal(apiFetch);
      const data = await res.json();
      if (data.url) window.location.href = data.url;
    } catch {
      setActionError(t('supporter.portalError'));
    }
  }, [apiFetch, t]);

  async function handleCheckout(plan) {
    setActionError(null);
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

  // Qualitative "where your support goes" buckets — no tier buys anything different.
  const buckets = [
    { icon: '🖥️', label: t('supporter.whereHosting'), desc: t('supporter.whereHostingDesc') },
    { icon: '✨', label: t('supporter.whereAI'), desc: t('supporter.whereAIDesc') },
    { icon: '🛠️', label: t('supporter.whereDev'), desc: t('supporter.whereDevDesc') },
  ];

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

      <SupportPicker
        hasStripeSubscription={hasStripeSubscription}
        checkoutLoading={checkoutLoading}
        onCheckout={handleCheckout}
        onManage={handleManageSubscription}
        actionError={actionError}
        billingInterval={billingInterval}
        onIntervalChange={setBillingInterval}
        availability={availability}
        t={t}
      />

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

      {/* Closing note — no second button wall; the picker is one screen up. */}
      <div className="donate-card donate-card--accent">
        <p className="donate-lead">{t('supporter.closingLead')}</p>
        <p className="donate-body">{t('supporter.closingBody')}</p>
        <p className="donate-note">{t('supporter.donateNote')}</p>
      </div>
    </div>
  );
}

export default Supporter;
