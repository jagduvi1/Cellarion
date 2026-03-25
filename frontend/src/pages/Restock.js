import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { getStatsOverview } from '../api/stats';
import './Restock.css';

function computeRestock(stats) {
  if (!stats) return [];

  const { overview, byType, byRegion, byCountry, consumedByType, consumedByRegion, consumedByCountry, pace } = stats;

  // Estimate months of consumption data (from pace or fallback to 12)
  const consumptionMonths = pace?.avgOutputPerYear > 0
    ? Math.max(12, (overview.totalConsumed / pace.avgOutputPerYear) * 12)
    : 12;

  const categories = [];

  // By wine type
  if (byType && consumedByType) {
    for (const [type, stock] of Object.entries(byType)) {
      const consumed = consumedByType[type] || 0;
      if (consumed === 0) continue;
      const rate = consumed / consumptionMonths;
      const months = stock / rate;
      categories.push({
        category: 'type',
        name: type,
        stock,
        consumed,
        rate: Math.round(rate * 10) / 10,
        monthsRemaining: Math.round(months),
        status: months < 2 ? 'urgent' : months < 4 ? 'low' : 'healthy'
      });
    }
  }

  // By region
  if (byRegion && consumedByRegion) {
    const regionStock = {};
    for (const r of byRegion) regionStock[r.name] = r.count;

    for (const [name, consumed] of Object.entries(consumedByRegion)) {
      const stock = regionStock[name] || 0;
      if (consumed === 0) continue;
      const rate = consumed / consumptionMonths;
      const months = stock > 0 ? stock / rate : 0;
      categories.push({
        category: 'region',
        name,
        stock,
        consumed,
        rate: Math.round(rate * 10) / 10,
        monthsRemaining: Math.round(months),
        status: months < 2 ? 'urgent' : months < 4 ? 'low' : 'healthy'
      });
    }
  }

  // By country
  if (byCountry && consumedByCountry) {
    const countryStock = {};
    for (const c of byCountry) countryStock[c.name] = c.count;

    for (const [name, consumed] of Object.entries(consumedByCountry)) {
      const stock = countryStock[name] || 0;
      if (consumed === 0) continue;
      const rate = consumed / consumptionMonths;
      const months = stock > 0 ? stock / rate : 0;
      categories.push({
        category: 'country',
        name,
        stock,
        consumed,
        rate: Math.round(rate * 10) / 10,
        monthsRemaining: Math.round(months),
        status: months < 2 ? 'urgent' : months < 4 ? 'low' : 'healthy'
      });
    }
  }

  return categories.sort((a, b) => a.monthsRemaining - b.monthsRemaining);
}

const STATUS_ICONS = { urgent: '🔴', low: '🟡', healthy: '🟢' };

export default function Restock() {
  const { t } = useTranslation();
  const { apiFetch } = useAuth();
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState('type');

  useEffect(() => {
    const fetch = async () => {
      try {
        const res = await getStatsOverview(apiFetch);
        if (res.ok) {
          const data = await res.json();
          setStats(data.stats);
        }
      } catch { /* ignore */ }
      setLoading(false);
    };
    fetch();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const allCategories = computeRestock(stats);
  const filtered = allCategories.filter(c => c.category === view);
  const urgent = filtered.filter(c => c.status === 'urgent');
  const low = filtered.filter(c => c.status === 'low');
  const healthy = filtered.filter(c => c.status === 'healthy');

  if (loading) return <div className="restock-page"><p className="restock-loading">{t('restock.loading', 'Analyzing your cellar...')}</p></div>;

  if (!stats || allCategories.length === 0) {
    return (
      <div className="restock-page">
        <h1>{t('restock.title', 'Smart Restock')}</h1>
        <div className="restock-empty">
          <p>{t('restock.noData', 'Not enough data yet. Consume some bottles so we can analyze your drinking patterns.')}</p>
          <Link to="/cellars" className="btn btn-primary">{t('restock.goToCellars', 'Go to Cellars')}</Link>
        </div>
      </div>
    );
  }

  const paceInfo = stats.pace;

  return (
    <div className="restock-page">
      <h1>{t('restock.title', 'Smart Restock')}</h1>
      <p className="restock-subtitle">{t('restock.subtitle', 'Based on your consumption patterns and current inventory.')}</p>

      {/* Pace overview */}
      {paceInfo && paceInfo.avgOutputPerYear > 0 && (
        <div className="restock-pace card">
          <div className="restock-pace__stats">
            <div className="restock-pace__stat">
              <span className="restock-pace__value">{Math.round(paceInfo.avgOutputPerYear)}</span>
              <span className="restock-pace__label">{t('restock.bottlesPerYear', 'bottles/year')}</span>
            </div>
            <div className="restock-pace__stat">
              <span className="restock-pace__value">{Math.round(paceInfo.avgIntakePerYear)}</span>
              <span className="restock-pace__label">{t('restock.purchased', 'purchased/year')}</span>
            </div>
            <div className="restock-pace__stat">
              <span className={`restock-pace__value ${paceInfo.netPerYear > 0 ? 'restock-pace__value--growing' : 'restock-pace__value--shrinking'}`}>
                {paceInfo.netPerYear > 0 ? '+' : ''}{Math.round(paceInfo.netPerYear)}
              </span>
              <span className="restock-pace__label">{t('restock.netPerYear', 'net/year')}</span>
            </div>
            {paceInfo.runway > 0 && paceInfo.runway < 100 && (
              <div className="restock-pace__stat">
                <span className="restock-pace__value">{Math.round(paceInfo.runway)}</span>
                <span className="restock-pace__label">{t('restock.yearsRunway', 'years runway')}</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* View tabs */}
      <div className="restock-tabs">
        <button className={`restock-tab ${view === 'type' ? 'active' : ''}`} onClick={() => setView('type')}>
          {t('restock.byType', 'By Type')}
        </button>
        <button className={`restock-tab ${view === 'region' ? 'active' : ''}`} onClick={() => setView('region')}>
          {t('restock.byRegion', 'By Region')}
        </button>
        <button className={`restock-tab ${view === 'country' ? 'active' : ''}`} onClick={() => setView('country')}>
          {t('restock.byCountry', 'By Country')}
        </button>
      </div>

      {/* Urgent */}
      {urgent.length > 0 && (
        <div className="restock-section">
          <h2 className="restock-section__title restock-section__title--urgent">
            {t('restock.runningLow', 'Running Low')}
          </h2>
          {urgent.map(c => <RestockCard key={c.name} item={c} t={t} />)}
        </div>
      )}

      {/* Low */}
      {low.length > 0 && (
        <div className="restock-section">
          <h2 className="restock-section__title restock-section__title--low">
            {t('restock.gettingLow', 'Getting Low')}
          </h2>
          {low.map(c => <RestockCard key={c.name} item={c} t={t} />)}
        </div>
      )}

      {/* Healthy */}
      {healthy.length > 0 && (
        <div className="restock-section">
          <h2 className="restock-section__title restock-section__title--healthy">
            {t('restock.wellStocked', 'Well Stocked')}
          </h2>
          {healthy.map(c => <RestockCard key={c.name} item={c} t={t} />)}
        </div>
      )}

      {filtered.length === 0 && (
        <p className="restock-empty-tab">{t('restock.noConsumption', 'No consumption data for this category yet.')}</p>
      )}
    </div>
  );
}

function RestockCard({ item, t }) {
  const maxMonths = 12;
  const barWidth = Math.min(item.monthsRemaining / maxMonths, 1) * 100;

  return (
    <div className={`restock-card restock-card--${item.status}`}>
      <div className="restock-card__header">
        <span className="restock-card__icon">{STATUS_ICONS[item.status]}</span>
        <span className="restock-card__name">{item.name}</span>
        <span className="restock-card__stock">
          {item.stock} {t('restock.inStock', 'in stock')}
        </span>
      </div>
      <div className="restock-card__bar-bg">
        <div className={`restock-card__bar restock-card__bar--${item.status}`} style={{ width: `${barWidth}%` }} />
      </div>
      <div className="restock-card__details">
        <span>{t('restock.consumeRate', '~{{rate}}/month', { rate: item.rate })}</span>
        <span className="restock-card__runway">
          {item.monthsRemaining === 0
            ? t('restock.outOfStock', 'Out of stock')
            : t('restock.monthsSupply', '~{{months}} months supply', { months: item.monthsRemaining })}
        </span>
      </div>
    </div>
  );
}
