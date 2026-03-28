import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { getValueHistory } from '../api/stats';
import { TYPE_COLORS, COUNTRY_COLORS, GRAPE_COLORS, fmt, fmtRating, fmtCurrency } from '../components/charts/chartHelpers';
import DonutChart from '../components/charts/DonutChart';
import HBarChart from '../components/charts/HBarChart';
import VintageBarChart from '../components/charts/VintageBarChart';
import RatingChart from '../components/charts/RatingChart';
import MaturityViz from '../components/charts/MaturityViz';
import HealthScoreCard from '../components/charts/HealthScoreCard';
import RegretIndexCard from '../components/charts/RegretIndexCard';
import MaturityForecastChart from '../components/charts/MaturityForecastChart';
import UrgencyLadder from '../components/charts/UrgencyLadder';
import HoldingTimeChart from '../components/charts/HoldingTimeChart';
import JoyPerDollarChart from '../components/charts/JoyPerDollarChart';
import RegretSignalCard from '../components/charts/RegretSignalCard';
import PaceCard from '../components/charts/PaceCard';
import ConsumptionChart from '../components/charts/ConsumptionChart';
import PurchaseHistoryChart from '../components/charts/PurchaseHistoryChart';
import TopValueList from '../components/charts/TopValueList';
import CellarBreakdownViz from '../components/charts/CellarBreakdownViz';
import BottleSizeChart from '../components/charts/BottleSizeChart';
import WorldMapChart from '../components/charts/WorldMapChart';
import UpgradeCard from '../components/charts/UpgradeCard';
import ValueOverTimeChart from '../components/ValueOverTimeChart';
import './Statistics.css';

// ── KPI Card ──────────────────────────────────────────────────────────────────
function KPICard({ icon, label, value, sub, accentColor }) {
  return (
    <div className="kpi-card" style={accentColor ? { borderTopColor: accentColor } : {}}>
      <div className="kpi-icon">{icon}</div>
      <div className="kpi-value">{value}</div>
      <div className="kpi-label">{label}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  );
}

// ── Empty State ───────────────────────────────────────────────────────────────
function EmptyCollection() {
  const { t } = useTranslation();
  return (
    <div className="stats-empty-state">
      <div className="stats-empty-icon">{'\ud83c\udf7e'}</div>
      <h2>{t('statistics.emptyTitle')}</h2>
      <p>{t('statistics.emptyDesc')}</p>
      <Link to="/cellars" className="btn btn-primary">{t('statistics.emptyBtn')}</Link>
    </div>
  );
}

// ── Main Statistics Page ──────────────────────────────────────────────────────
function Statistics() {
  const { t } = useTranslation();
  const { user, apiFetch } = useAuth();
  const [stats, setStats]  = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]  = useState(null);
  const [valueHistory, setValueHistory] = useState(null);

  const planExpired   = user?.planExpiresAt && Date.now() > new Date(user.planExpiresAt).getTime();
  const effectivePlan = planExpired ? 'free' : (user?.plan || 'free');
  const isBasic       = effectivePlan === 'basic' || effectivePlan === 'premium';
  const isPremium     = effectivePlan === 'premium';

  const load = useCallback(async () => {
    try {
      const res  = await apiFetch('/api/stats/overview');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load statistics');
      setStats(data.stats);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [apiFetch]);

  // Fetch value history for premium users (parallel with overview)
  const loadValueHistory = useCallback(async () => {
    if (!isPremium) return;
    try {
      const res = await getValueHistory(apiFetch);
      const data = await res.json();
      if (res.ok && data.valueHistory) setValueHistory(data.valueHistory);
    } catch {}
  }, [apiFetch, isPremium]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadValueHistory(); }, [loadValueHistory]);

  if (loading) {
    return (
      <div className="stats-page stats-loading">
        <div className="stats-spinner" />
        <p>{t('statistics.loading')}</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="stats-page">
        <div className="alert alert-error">{error}</div>
      </div>
    );
  }

  if (!stats) return null;

  const {
    overview, byType, byCountry, byRegion, byGrape,
    byVintage, byRating, byBottleSize, byPurchaseYear,
    maturity, maturityCoverage, topValueBottles,
    consumptionByYear, consumptionByReason, cellarBreakdown,
    maturityForecast, urgencyLadder, holdingTime,
    joyPerDollar, regretSignal, pace, topProducers,
  } = stats;

  if (overview.totalBottles === 0 && overview.totalConsumed === 0) {
    return <div className="stats-page"><EmptyCollection /></div>;
  }

  const typeSegments = Object.entries(byType)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([type, value]) => ({
      type, label: t(`statistics.typeLabels.${type}`, { defaultValue: type }),
      value, color: TYPE_COLORS[type] || '#6a6a6a',
    }));

  const total          = overview.totalBottles;
  const currency       = overview.currency;
  const targetScale    = overview.targetRatingScale || '5';
  const hasConsumption = overview.totalConsumed > 0;
  const hasMultipleSizes = Object.keys(byBottleSize).length > 1;
  const hasPurchaseDates = byPurchaseYear && byPurchaseYear.length > 0;
  const hasUrgency     = urgencyLadder && urgencyLadder.length > 0;
  const hasForecast    = maturityForecast && maturityForecast.some(d => d.count > 0);
  const hasProducers   = topProducers && topProducers.length > 0;

  const PREMIUM_FEATURES = [
    t('statistics.upgradeFeatures.premium1'),
    t('statistics.upgradeFeatures.premium2'),
    t('statistics.upgradeFeatures.premium3'),
    t('statistics.upgradeFeatures.premium4'),
    t('statistics.upgradeFeatures.premium5'),
    t('statistics.upgradeFeatures.premium6'),
    t('statistics.upgradeFeatures.premium7'),
    t('statistics.upgradeFeatures.premium8'),
  ];

  return (
    <div className="stats-page">

      {/* ── Header ── */}
      <div className="stats-header">
        <div className="stats-title-row">
          <h1 className="stats-title">{t('statistics.title')}</h1>
          <Link to="/statistics/card" className="btn btn-small btn-secondary stats-card-link">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/></svg>
            {t('statsCard.createCard', 'Share Card')}
          </Link>
        </div>
        <p className="stats-subtitle">
          {isBasic
            ? t('statistics.subtitleFull', {
                cellars: overview.totalCellars,
                count: overview.totalCellars,
                countries: overview.totalCountries,
                grapes: overview.totalGrapes,
              })
            : t('statistics.subtitleFree')
          }
        </p>
        {isPremium
          ? <span className="stats-plan-badge stats-plan-badge--premium">{'\u2605'} Premium</span>
          : isBasic
            ? <span className="stats-plan-badge stats-plan-badge--basic">Basic</span>
            : null
        }
      </div>

      {/* ── Primary KPIs ── */}
      <div className={`kpi-grid${isPremium ? '' : isBasic ? ' kpi-grid--5' : ' kpi-grid--5'}`}>
        <KPICard icon={'\ud83c\udf7e'} label={t('statistics.kpi.activeBottles')} value={fmt(total)}
          sub={t('statistics.kpi.uniqueWines', { count: overview.uniqueWines })} accentColor="#7A1E2D" />
        <KPICard icon={'\ud83c\udf0d'} label={t('statistics.kpi.countries')} value={fmt(overview.totalCountries)}
          sub={t('statistics.kpi.grapeVarieties', { count: overview.totalGrapes })} accentColor="#6EC6C6" />
        <KPICard icon={'\u2b50'} label={t('statistics.kpi.avgRating')}
          value={overview.avgRating != null ? fmtRating(overview.avgRating, targetScale) : '\u2014'}
          accentColor="#D4C87A" />
        <KPICard icon={'\ud83d\udcc5'} label={t('statistics.kpi.avgVintageAge')}
          value={overview.avgVintageAge ? `${overview.avgVintageAge} ${t('statistics.kpi.yrs')}` : '\u2014'}
          sub={overview.oldestVintage
            ? `${overview.oldestVintage} \u2192 ${overview.newestVintage}` : undefined}
          accentColor="#8B6A9A" />
        <KPICard icon={'\u23f1'} label={t('statistics.kpi.decliningLate')}
          value={`${(maturity.declining || 0) + (maturity.late || 0)}`}
          sub={maturity.declining > 0
            ? t('statistics.kpi.pastPrime', { count: maturity.declining })
            : t('statistics.kpi.atPeak', { count: maturity.peak || 0 })}
          accentColor={maturity.declining > 0 ? '#C94040' : '#7A1E2D'} />
        {isPremium && (
          <KPICard icon={'\ud83d\udcb0'} label={t('statistics.kpi.estValue')}
            value={overview.totalValue > 0 ? fmtCurrency(overview.totalValue, currency) : '\u2014'}
            sub={overview.avgPrice > 0
              ? t('statistics.kpi.avgPerBottle', { price: fmtCurrency(overview.avgPrice, currency) }) : undefined}
            accentColor="#D4A070" />
        )}
      </div>

      {/* ── Secondary KPIs (consumption) — basic+ only ── */}
      {isBasic && hasConsumption && (
        <div className="kpi-grid kpi-grid--secondary">
          <KPICard icon={'\u2713'} label={t('statistics.kpi.totalConsumed')} value={fmt(overview.totalConsumed)} />
          <KPICard icon={'\ud83e\udd42'} label={t('statistics.kpi.bottlesDrunk')}  value={fmt(overview.bottlesDrunk)} />
          <KPICard icon={'\ud83c\udf81'} label={t('statistics.kpi.gifted')}          value={fmt(overview.bottlesGifted)} />
          <KPICard icon={'\ud83d\udcb5'} label={t('statistics.kpi.sold')}            value={fmt(overview.bottlesSold)} />
          {overview.avgConsumedRating != null && (
            <KPICard icon={'\ud83c\udf1f'} label={t('statistics.kpi.avgConsumedRating')}
              value={fmtRating(overview.avgConsumedRating, targetScale)} />
          )}
        </div>
      )}

      {/* ── Health + Regret row — premium only ── */}
      {isPremium && (
        <div className="stats-grid stats-grid--insight">
          <div className="stats-card">
            <h2 className="stats-card-title">
              {t('statistics.sections.healthScore')}
              <span className="stats-card-title-note">{t('statistics.sections.healthScoreNote')}</span>
            </h2>
            <HealthScoreCard
              healthScore={overview.healthScore}
              healthGrade={overview.healthGrade}
              maturity={maturity}
            />
          </div>
          <div className={`stats-card stats-card--regret${overview.regretIndex >= 15 ? ' stats-card--regret-alert' : ''}`}>
            <h2 className="stats-card-title">
              {t('statistics.sections.regretIndex')}
              <span className="stats-card-title-note">{t('statistics.sections.regretIndexNote')}</span>
            </h2>
            <RegretIndexCard
              regretIndex={overview.regretIndex}
              decliningCount={maturity.declining}
              total={total}
            />
          </div>
        </div>
      )}

      {/* ── Collection Value Over Time — premium only ── */}
      {isPremium && valueHistory && valueHistory.snapshots.length > 1 && (
        <div className="stats-grid">
          <div className="stats-card stats-card--full">
            <h2 className="stats-card-title">
              {t('statistics.sections.valueOverTime', 'Collection Value Over Time')}
              {valueHistory.changePercent !== 0 && (
                <span className="stats-card-title-note" style={{
                  color: valueHistory.changePercent >= 0 ? '#2D7A45' : '#C0504D'
                }}>
                  {valueHistory.changePercent >= 0 ? '+' : ''}{valueHistory.changePercent}%
                </span>
              )}
            </h2>
            <ValueOverTimeChart
              snapshots={valueHistory.snapshots}
              currency={valueHistory.currency}
            />
          </div>
        </div>
      )}
      {isPremium && valueHistory && valueHistory.snapshots.length <= 1 && (
        <div className="stats-grid">
          <div className="stats-card stats-card--full">
            <h2 className="stats-card-title">
              {t('statistics.sections.valueOverTime', 'Collection Value Over Time')}
            </h2>
            <p className="value-chart-seed-msg">
              {valueHistory.snapshots.length === 0
                ? 'Value tracking has started. Your first data point will appear after the weekly snapshot runs.'
                : 'Your first snapshot is recorded. Trend data will appear after next week\'s snapshot.'}
            </p>
          </div>
        </div>
      )}

      {/* ── Main Grid ── */}
      <div className="stats-grid">

        {/* Wine Types Donut — FREE+ */}
        <div className="stats-card">
          <h2 className="stats-card-title">{t('statistics.sections.wineTypes')}</h2>
          {total > 0 ? (
            <div className="donut-layout">
              <DonutChart segments={typeSegments} total={total} />
              <div className="donut-legend">
                {typeSegments.map(seg => (
                  <div key={seg.type} className="donut-legend-item">
                    <span className="donut-legend-dot" style={{ background: seg.color }} />
                    <span className="donut-legend-label">{seg.label}</span>
                    <span className="donut-legend-count">{seg.value}</span>
                    <span className="donut-legend-pct">
                      ({total > 0 ? ((seg.value / total) * 100).toFixed(0) : 0}%)
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <p className="stats-empty">{t('statistics.noBottlesYet')}</p>
          )}
        </div>

        {/* Drinking Windows — FREE+ */}
        <div className="stats-card">
          <h2 className="stats-card-title">{t('statistics.sections.maturityStatus')}</h2>
          <MaturityViz maturity={maturity} maturityCoverage={maturityCoverage} total={total} />
        </div>

        {/* Vintage Distribution — BASIC+ */}
        {isBasic && (
          <div className="stats-card stats-card--full">
            <h2 className="stats-card-title">
              {t('statistics.sections.vintageDistribution')}
              {overview.oldestVintage && (
                <span className="stats-card-title-note">
                  {overview.oldestVintage} – {overview.newestVintage}
                </span>
              )}
            </h2>
            <VintageBarChart data={byVintage} />
          </div>
        )}

        {/* Rating Distribution — FREE+ */}
        {!isBasic && (
          <div className="stats-card">
            <h2 className="stats-card-title">{t('statistics.sections.ratingDistribution')}</h2>
            <RatingChart byRating={byRating} avg={overview.avgRating} targetScale={targetScale} />
          </div>
        )}

        {/* Top 5 Origins — FREE only */}
        {!isBasic && (
          <div className="stats-card">
            <h2 className="stats-card-title">
              {t('statistics.sections.topOrigins')}
              <span className="stats-card-title-note">{t('statistics.sections.top5')}</span>
            </h2>
            <HBarChart data={byCountry} colors={COUNTRY_COLORS} maxItems={5} />
          </div>
        )}

        {/* Upgrade cards — FREE users only */}
        {!isBasic && (
          <>
            <UpgradeCard plan="basic" fullWidth features={[
              t('statistics.upgradeFeatures.basic1'),
              t('statistics.upgradeFeatures.basic2'),
              t('statistics.upgradeFeatures.basic3'),
              t('statistics.upgradeFeatures.basic4'),
              t('statistics.upgradeFeatures.basic5'),
              t('statistics.upgradeFeatures.basic6'),
              t('statistics.upgradeFeatures.basic7'),
              t('statistics.upgradeFeatures.basic8'),
            ]} />
            <UpgradeCard plan="premium" fullWidth features={PREMIUM_FEATURES} />
          </>
        )}

        {/* ── BASIC+ sections ── */}
        {isBasic && (
          <>
            {/* World Map — BASIC (desktop only, hover-based) */}
            <div className="stats-card stats-card--full stats-card--desktop-only">
              <h2 className="stats-card-title">
                {t('statistics.sections.collectionOrigins')}
                <span className="stats-card-title-note">{t('statistics.sections.darkerMoreBottles')}</span>
              </h2>
              <WorldMapChart byCountry={byCountry} />
            </div>

            {/* Top Origins — BASIC */}
            <div className="stats-card">
              <h2 className="stats-card-title">{t('statistics.sections.topOrigins')}</h2>
              <HBarChart data={byCountry} colors={COUNTRY_COLORS} />
            </div>

            {/* Top Grape Varieties — BASIC */}
            <div className="stats-card">
              <h2 className="stats-card-title">{t('statistics.sections.topGrapeVarieties')}</h2>
              <HBarChart data={byGrape} colors={GRAPE_COLORS} />
            </div>

            {/* Top Regions — BASIC */}
            {byRegion && byRegion.length > 0 && (
              <div className="stats-card">
                <h2 className="stats-card-title">{t('statistics.sections.topRegions')}</h2>
                <HBarChart data={byRegion}
                  colors={['#7aade0', '#6a9dd0', '#5a8dc0', '#4a7db0', '#3a6da0']} />
              </div>
            )}

            {/* Top Producers — BASIC */}
            {hasProducers && (
              <div className="stats-card">
                <h2 className="stats-card-title">{t('statistics.sections.topProducers')}</h2>
                <HBarChart data={topProducers}
                  colors={['#D4A070', '#C4906A', '#B48064', '#A4705E', '#946058']} />
              </div>
            )}

            {/* Rating Distribution — BASIC */}
            <div className="stats-card">
              <h2 className="stats-card-title">{t('statistics.sections.ratingDistribution')}</h2>
              <RatingChart byRating={byRating} avg={overview.avgRating} targetScale={targetScale} />
            </div>

            {/* Bottle Sizes — BASIC */}
            {hasMultipleSizes && (
              <div className="stats-card">
                <h2 className="stats-card-title">{t('statistics.sections.bottleSizes')}</h2>
                <BottleSizeChart byBottleSize={byBottleSize} />
              </div>
            )}

            {/* Purchase History — BASIC (desktop only, scrolling bar chart) */}
            {hasPurchaseDates && (
              <div className="stats-card stats-card--desktop-only">
                <h2 className="stats-card-title">{t('statistics.sections.purchasesByYear')}</h2>
                <PurchaseHistoryChart byPurchaseYear={byPurchaseYear} />
              </div>
            )}

            {/* Pace — BASIC */}
            <div className="stats-card">
              <h2 className="stats-card-title">
                {t('statistics.sections.cellarPace')}
                <span className="stats-card-title-note">{t('statistics.sections.intakeVsConsumption')}</span>
              </h2>
              <PaceCard pace={pace} totalBottles={total} />
            </div>

            {/* Consumption History — BASIC */}
            <div className="stats-card stats-card--full">
              <h2 className="stats-card-title">{t('statistics.sections.consumptionHistory')}</h2>
              <ConsumptionChart
                consumptionByYear={consumptionByYear}
                consumptionByReason={consumptionByReason}
              />
            </div>

            {/* Cellar Breakdown — BASIC */}
            <div className="stats-card">
              <h2 className="stats-card-title">{t('statistics.sections.cellarBreakdown')}</h2>
              <CellarBreakdownViz cellars={cellarBreakdown} currency={currency} />
            </div>

            {/* Premium upgrade for basic users OR premium-only content */}
            {!isPremium ? (
              <UpgradeCard plan="premium" fullWidth features={PREMIUM_FEATURES} />
            ) : (
              <>
                {/* Maturity Forecast — PREMIUM (desktop only, many columns) */}
                {hasForecast && (
                  <div className="stats-card stats-card--full stats-card--desktop-only">
                    <h2 className="stats-card-title">
                      {t('statistics.sections.maturityForecast')}
                      <span className="stats-card-title-note">{t('statistics.sections.forecastNote')}</span>
                    </h2>
                    <MaturityForecastChart forecast={maturityForecast} />
                  </div>
                )}

                {/* Urgency Ladder — PREMIUM */}
                {hasUrgency && (
                  <div className="stats-card stats-card--full">
                    <h2 className="stats-card-title">
                      {t('statistics.sections.drinkTheseNow')}
                      <span className="stats-card-title-note">{t('statistics.sections.orderedByUrgency')}</span>
                    </h2>
                    <UrgencyLadder bottles={urgencyLadder} currency={currency} />
                  </div>
                )}

                {/* Holding Time — PREMIUM */}
                <div className="stats-card">
                  <h2 className="stats-card-title">
                    {t('statistics.sections.patiencePayoff')}
                    <span className="stats-card-title-note">{t('statistics.sections.doesAgingReward')}</span>
                  </h2>
                  <HoldingTimeChart holdingTime={holdingTime} targetScale={targetScale} />
                </div>

                {/* Joy Per Dollar — PREMIUM */}
                <div className="stats-card">
                  <h2 className="stats-card-title">
                    {t('statistics.sections.joyPer', { currency })}
                    <span className="stats-card-title-note">{t('statistics.sections.ratingVsPrice')}</span>
                  </h2>
                  <JoyPerDollarChart data={joyPerDollar} currency={currency} targetScale={targetScale} />
                </div>

                {/* Regret Signal — PREMIUM (desktop only, complex two-column layout) */}
                {hasConsumption && (
                  <div className="stats-card stats-card--full stats-card--desktop-only">
                    <h2 className="stats-card-title">
                      {t('statistics.sections.expectationVsReality')}
                      <span className="stats-card-title-note">{t('statistics.sections.surprisedOrDisappointed')}</span>
                    </h2>
                    <RegretSignalCard regretSignal={regretSignal} targetScale={targetScale} />
                  </div>
                )}

                {/* Most Valuable Bottles — PREMIUM */}
                <div className="stats-card">
                  <h2 className="stats-card-title">{t('statistics.sections.mostValuableBottles')}</h2>
                  <TopValueList bottles={topValueBottles} currency={currency} />
                </div>
              </>
            )}
          </>
        )}

      </div>

      <p className="stats-footnote">
        {t('statistics.footnote.activeOnly')} ·{' '}
        {isPremium && `${t('statistics.footnote.pricesConverted', { currency })} · `}
        {t('statistics.footnote.maturityData')} ·
        {' '}{t('statistics.footnote.ownedOnly')}
      </p>
    </div>
  );
}

export default Statistics;
