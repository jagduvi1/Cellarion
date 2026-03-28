import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { CURRENCIES } from '../config/currencies';
import { fetchRates, convertAmountHistorical } from '../utils/currency';
import WineImage from '../components/WineImage';
import './SommPrices.css';

function timeAgo(dateStr) {
  if (!dateStr) return '';
  const diff = Date.now() - new Date(dateStr).getTime();
  const days  = Math.floor(diff / (1000 * 60 * 60 * 24));
  if (days === 0) return 'today';
  if (days === 1) return '1 day ago';
  if (days < 30)  return `${days} days ago`;
  const months = Math.floor(days / 30);
  if (months === 1) return '1 month ago';
  if (months < 12)  return `${months} months ago`;
  const years = Math.floor(months / 12);
  return years === 1 ? '1 year ago' : `${years} years ago`;
}

function SommPrices() {
  const { t } = useTranslation();
  const { apiFetch, user } = useAuth();
  const [queue, setQueue]     = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [rates, setRates]     = useState(null);

  const fetchQueue = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res  = await apiFetch('/api/somm/prices/queue');
      const data = await res.json();
      if (res.ok) {
        setQueue(data.queue);
        fetchRates().then(r => { if (r) setRates(r); });
      } else {
        setError(data.error || 'Failed to load queue');
      }
    } catch {
      setError('Network error');
    } finally {
      setLoading(false);
    }
  }, [apiFetch]);

  useEffect(() => { fetchQueue(); }, [fetchQueue]);

  const handleSaved = (wineId, vintage) => {
    // Remove the entry from the queue once a price is saved (it's now fresh)
    setQueue(prev => prev.filter(
      item => !(item.wineDefinition?._id === wineId && item.vintage === vintage)
    ));
  };

  return (
    <div className="somm-page">
      <div className="page-header">
        <h1>{t('somm.prices.title')}</h1>
        <p className="somm-subtitle">
          {t('somm.prices.subtitle')}
        </p>
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      {loading ? (
        <div className="loading">{t('somm.prices.loadingQueue')}</div>
      ) : queue.length === 0 ? (
        <div className="somm-empty">{t('somm.prices.allUpToDate')}</div>
      ) : (
        <>
          <p className="sp-count">{t('somm.prices.needsUpdate', { count: queue.length })}</p>
          <div className="somm-list">
            {queue.map(item => (
              <PriceCard
                key={`${item.wineDefinition?._id}:${item.vintage}`}
                item={item}
                defaultCurrency={user?.preferences?.currency || 'USD'}
                userCurrency={user?.preferences?.currency || 'USD'}
                rates={rates}
                onSaved={handleSaved}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ── Individual price card ──────────────────────────────────────────────────────
function PriceCard({ item, defaultCurrency, userCurrency, rates, onSaved }) {
  const { t } = useTranslation();
  const { apiFetch } = useAuth();
  const wine  = item.wineDefinition;
  const isNew = !item.latestPrice;

  const [expanded,  setExpanded]  = useState(isNew); // auto-expand no-history cards
  const [saving,    setSaving]    = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiMsg,     setAiMsg]     = useState(null);
  const [err,       setErr]       = useState(null);

  const [form, setForm] = useState({
    price:    '',
    currency: item.latestPrice?.currency || defaultCurrency || 'USD',
    source:   ''
  });

  const set = (field) => (e) => setForm(f => ({ ...f, [field]: e.target.value }));

  const handleAiSuggest = async () => {
    setAiLoading(true);
    setAiMsg(null);
    setErr(null);
    try {
      const res = await apiFetch('/api/somm/prices/ai-suggest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wineDefinition: wine?._id,
          vintage: item.vintage
        })
      });
      const data = await res.json();
      if (res.ok && data.suggestion) {
        const s = data.suggestion;
        if (s.price != null) {
          setForm(f => ({
            ...f,
            price:    String(s.price),
            currency: s.currency || f.currency,
            source:   s.source   || f.source
          }));
          setAiMsg({ ok: true, text: t('somm.prices.aiSuggestFilled'), reasoning: s.reasoning });
        } else {
          setAiMsg({ ok: false, text: t('somm.prices.aiNoValue'), reasoning: s.reasoning });
        }
      } else {
        setAiMsg({ ok: false, text: data.error || t('somm.prices.aiSuggestError') });
      }
    } catch {
      setAiMsg({ ok: false, text: t('somm.prices.aiSuggestError') });
    } finally {
      setAiLoading(false);
    }
  };

  const handleSave = async (e) => {
    e.preventDefault();
    if (!form.price) { setErr(t('somm.prices.priceRequired')); return; }
    setSaving(true);
    setErr(null);
    try {
      const res = await apiFetch('/api/somm/prices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wineDefinition: wine?._id,
          vintage:  item.vintage,
          price:    parseFloat(form.price),
          currency: form.currency,
          source:   form.source || undefined
        })
      });
      const data = await res.json();
      if (res.ok) {
        onSaved(wine?._id, item.vintage);
      } else {
        setErr(data.error || 'Failed to save');
      }
    } catch {
      setErr('Network error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={`somm-card ${expanded ? 'expanded' : ''}`}>
      {/* ── Header ── */}
      <div className="somm-card-header" onClick={() => setExpanded(o => !o)}>
        <div className="somm-card-identity">
          <WineImage image={wine?.image} alt={wine?.name} className="somm-wine-thumb" wineType={wine?.type} placeholder="somm-wine-thumb-placeholder" />
          <div>
            <span className="somm-wine-name">{wine?.name || 'Unknown'}</span>
            <span className="somm-wine-meta">
              {wine?.producer}{wine?.country?.name && ` · ${wine.country.name}`}
            </span>
          </div>
        </div>

        <div className="somm-card-right">
          <span className="somm-vintage-pill">{item.vintage}</span>
          {item.latestPrice ? (
            <span className="sp-last-price">
              {item.latestPrice.price} {item.latestPrice.currency}
              <span className="sp-last-age"> · {timeAgo(item.latestPrice.setAt)}</span>
            </span>
          ) : (
            <span className="somm-status-pill pending">{t('somm.prices.noHistory')}</span>
          )}
          {item.bottleCount > 1 && (
            <span className="sp-bottle-count">{t('somm.prices.bottle', { count: item.bottleCount })}</span>
          )}
          <span className="somm-chevron">{expanded ? '▲' : '▼'}</span>
        </div>
      </div>

      {/* ── Inline form ── */}
      {expanded && (
        <form className="somm-form" onSubmit={handleSave}>
          {err && <div className="alert alert-error">{err}</div>}

          <div className="somm-ai-row">
            <button
              type="button"
              className="btn btn-ai"
              onClick={handleAiSuggest}
              disabled={aiLoading}
            >
              {aiLoading ? t('somm.prices.aiSuggesting') : t('somm.prices.aiSuggest')}
            </button>
            {aiMsg && (
              <div className={`somm-ai-msg ${aiMsg.ok ? 'somm-ai-msg--ok' : 'somm-ai-msg--err'}`}>
                {aiMsg.text}
                {aiMsg.reasoning && (
                  <div className="somm-ai-reasoning">
                    {t('somm.prices.aiReasoning')} {aiMsg.reasoning}
                  </div>
                )}
              </div>
            )}
          </div>

          {item.latestPrice && (() => {
            const prev = item.latestPrice;
            const converted = convertAmountHistorical(prev.price, prev.currency, userCurrency, prev.exchangeRates, rates);
            return (
              <div className="sp-previous">
                <span className="sp-previous-label">{t('somm.prices.previousLabel')}</span>
                <strong>{prev.price} {prev.currency}</strong>
                {converted !== null && (
                  <span className="sp-previous-converted">≈ {converted.toLocaleString()} {userCurrency}</span>
                )}
                <span className="sp-previous-age">{t('somm.prices.setLabel')}{timeAgo(prev.setAt)}</span>
                {prev.source && (
                  <span className="sp-previous-source">{t('somm.prices.viaLabel')}{prev.source}</span>
                )}
              </div>
            );
          })()}

          <div className="sp-form-row">
            <div className="form-group sp-price-field">
              <label>{t('somm.prices.marketPrice')}</label>
              <input
                type="number"
                step="0.01"
                min="0"
                placeholder={t('somm.prices.marketPricePlaceholder')}
                value={form.price}
                onChange={set('price')}
                autoFocus={isNew}
                required
              />
            </div>

            <div className="form-group sp-currency-field">
              <label>{t('common.currency')}</label>
              <select value={form.currency} onChange={set('currency')}>
                {CURRENCIES.map(c => <option key={c}>{c}</option>)}
              </select>
            </div>

            <div className="form-group sp-source-field">
              <label>{t('common.source')} <span className="somm-year-hint">{t('somm.prices.sourceOptional')}</span></label>
              <input
                type="text"
                placeholder={t('somm.prices.sourcePlaceholder')}
                value={form.source}
                onChange={set('source')}
              />
            </div>
          </div>

          <div className="somm-form-actions">
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? t('common.saving') : t('somm.prices.savePrice')}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

export default SommPrices;
