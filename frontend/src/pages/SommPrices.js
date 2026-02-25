import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { CURRENCIES } from '../config/currencies';
import { fetchRates, convertAmount } from '../utils/currency';
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
  const { token, user } = useAuth();
  const [queue, setQueue]     = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [rates, setRates]     = useState(null);

  const fetchQueue = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res  = await fetch('/api/somm/prices/queue', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
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
  }, [token]);

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
        <h1>Price Queue</h1>
        <p className="somm-subtitle">
          Update market prices for vintages with no history or a price older than 3 months.
        </p>
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      {loading ? (
        <div className="loading">Loading queue…</div>
      ) : queue.length === 0 ? (
        <div className="somm-empty">All prices are up to date. Great work!</div>
      ) : (
        <>
          <p className="sp-count">{queue.length} wine{queue.length !== 1 ? 's' : ''} need a price update</p>
          <div className="somm-list">
            {queue.map(item => (
              <PriceCard
                key={`${item.wineDefinition?._id}:${item.vintage}`}
                item={item}
                token={token}
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
function PriceCard({ item, token, defaultCurrency, userCurrency, rates, onSaved }) {
  const wine  = item.wineDefinition;
  const isNew = !item.latestPrice;

  const [expanded, setExpanded] = useState(isNew); // auto-expand no-history cards
  const [saving,   setSaving]   = useState(false);
  const [err,      setErr]      = useState(null);

  const [form, setForm] = useState({
    price:    '',
    currency: item.latestPrice?.currency || defaultCurrency || 'USD',
    source:   ''
  });

  const set = (field) => (e) => setForm(f => ({ ...f, [field]: e.target.value }));

  const handleSave = async (e) => {
    e.preventDefault();
    if (!form.price) { setErr('Price is required'); return; }
    setSaving(true);
    setErr(null);
    try {
      const res = await fetch('/api/somm/prices', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
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
          {wine?.image ? (
            <img src={wine.image} alt={wine?.name} className="somm-wine-thumb"
              onError={e => { e.target.style.display = 'none'; }} />
          ) : (
            <div className={`somm-wine-thumb-placeholder ${wine?.type || 'red'}`} />
          )}
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
            <span className="somm-status-pill pending">No history</span>
          )}
          {item.bottleCount > 1 && (
            <span className="sp-bottle-count">{item.bottleCount} bottles</span>
          )}
          <span className="somm-chevron">{expanded ? '▲' : '▼'}</span>
        </div>
      </div>

      {/* ── Inline form ── */}
      {expanded && (
        <form className="somm-form" onSubmit={handleSave}>
          {err && <div className="alert alert-error">{err}</div>}

          {item.latestPrice && (() => {
            const prev = item.latestPrice;
            const converted = convertAmount(prev.price, prev.currency, userCurrency, rates);
            return (
              <div className="sp-previous">
                <span className="sp-previous-label">Previous:</span>
                <strong>{prev.price} {prev.currency}</strong>
                {converted !== null && (
                  <span className="sp-previous-converted">≈ {converted.toLocaleString()} {userCurrency}</span>
                )}
                <span className="sp-previous-age">— set {timeAgo(prev.setAt)}</span>
                {prev.source && (
                  <span className="sp-previous-source">via {prev.source}</span>
                )}
              </div>
            );
          })()}

          <div className="sp-form-row">
            <div className="form-group sp-price-field">
              <label>Market price</label>
              <input
                type="number"
                step="0.01"
                min="0"
                placeholder="e.g. 89.00"
                value={form.price}
                onChange={set('price')}
                autoFocus={isNew}
                required
              />
            </div>

            <div className="form-group sp-currency-field">
              <label>Currency</label>
              <select value={form.currency} onChange={set('currency')}>
                {CURRENCIES.map(c => <option key={c}>{c}</option>)}
              </select>
            </div>

            <div className="form-group sp-source-field">
              <label>Source <span className="somm-year-hint">(optional)</span></label>
              <input
                type="text"
                placeholder="Vivino, Wine-Searcher…"
                value={form.source}
                onChange={set('source')}
              />
            </div>
          </div>

          <div className="somm-form-actions">
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? 'Saving…' : 'Save price'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

export default SommPrices;
