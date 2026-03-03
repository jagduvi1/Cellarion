import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import './Statistics.css';

// ── Color palette ─────────────────────────────────────────────────────────────
const TYPE_COLORS = {
  red:       '#C0504D',
  white:     '#D4C87A',
  'rosé':    '#E8A0B0',
  sparkling: '#6EC6C6',
  dessert:   '#D4A070',
  fortified: '#8B6A9A',
  unknown:   '#6a6a6a',
};

const TYPE_LABELS = {
  red: 'Red', white: 'White', 'rosé': 'Rosé',
  sparkling: 'Sparkling', dessert: 'Dessert', fortified: 'Fortified', unknown: 'Unknown',
};

const REASON_COLORS = {
  drank:  '#7B9E88',
  gifted: '#7aade0',
  sold:   '#D4A070',
  other:  '#9A9484',
};

const COUNTRY_COLORS = [
  '#7B9E88', '#6B8E7B', '#5B7E6B', '#4B6E5B', '#3B5E4B',
  '#6EC6C6', '#5EB6B6', '#4EA6A6', '#3E9696', '#2E8686',
  '#D4C87A', '#C4B86A', '#B4A85A', '#A4984A', '#94883A',
];

const GRAPE_COLORS = [
  '#C0504D', '#B0403D', '#A0302D', '#90201D', '#80100D',
  '#E8A0B0', '#D890A0', '#C88090', '#B87080', '#A86070',
  '#8B6A9A', '#7B5A8A', '#6B4A7A', '#5B3A6A', '#4B2A5A',
];

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmt(n) {
  if (n == null) return '—';
  return n.toLocaleString();
}

function fmtCurrency(amount, currency) {
  if (!amount && amount !== 0) return '—';
  if (amount === 0) return '—';
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return `${currency} ${fmt(amount)}`;
  }
}

// ── SVG Donut Chart ───────────────────────────────────────────────────────────
// Segments start at 12 o'clock and go clockwise.
// Formula: dashoffset = C/4 - cumulative (no rotation transform needed).
function DonutChart({ segments, total, size = 180 }) {
  const R = size * 0.355;
  const C = 2 * Math.PI * R;
  const cx = size / 2;
  const cy = size / 2;
  const validSegs = segments.filter(s => s.value > 0);

  let cumulative = 0;

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className="donut-svg"
      role="img"
      aria-label={`Donut chart: ${total} total bottles`}
    >
      {/* Background ring */}
      <circle cx={cx} cy={cy} r={R} fill="none" stroke="#252525" strokeWidth="22" />

      {total === 0 ? null : validSegs.map((seg, i) => {
        const len = (seg.value / total) * C;
        const dashoffset = C / 4 - cumulative;
        cumulative += len;
        return (
          <circle
            key={i}
            cx={cx}
            cy={cy}
            r={R}
            fill="none"
            stroke={seg.color}
            strokeWidth="20"
            strokeDasharray={`${len} ${C}`}
            strokeDashoffset={dashoffset}
            strokeLinecap="butt"
          >
            <title>{seg.label}: {seg.value} ({total > 0 ? ((seg.value / total) * 100).toFixed(1) : 0}%)</title>
          </circle>
        );
      })}

      {/* Center text */}
      <text
        x={cx}
        y={cy - size * 0.06}
        textAnchor="middle"
        fontSize={size * 0.155}
        fontWeight="700"
        fill="#E8DFD0"
      >
        {total}
      </text>
      <text
        x={cx}
        y={cy + size * 0.1}
        textAnchor="middle"
        fontSize={size * 0.07}
        fill="#9A9484"
      >
        bottles
      </text>
    </svg>
  );
}

// ── Horizontal Bar Chart ──────────────────────────────────────────────────────
function HBarChart({ data, colors, maxItems = 12 }) {
  if (!data || data.length === 0) return <p className="stats-empty">No data yet</p>;
  const items = data.slice(0, maxItems);
  const maxVal = Math.max(...items.map(d => d.count), 1);

  return (
    <div className="hbar-chart">
      {items.map((d, i) => (
        <div key={i} className="hbar-row">
          <span className="hbar-label" title={d.name}>{d.name}</span>
          <div className="hbar-track">
            <div
              className="hbar-fill"
              style={{
                width: `${(d.count / maxVal) * 100}%`,
                background: Array.isArray(colors) ? (colors[i % colors.length] || '#7B9E88') : (colors || '#7B9E88'),
              }}
            />
          </div>
          <span className="hbar-count">{d.count}</span>
        </div>
      ))}
    </div>
  );
}

// ── Vintage Bar Chart (vertical) ──────────────────────────────────────────────
function VintageBarChart({ data }) {
  if (!data || data.length === 0) return <p className="stats-empty">No vintage data yet</p>;

  const numeric = data.filter(d => d.year !== 'NV');
  const nvItem = data.find(d => d.year === 'NV');
  const maxCount = Math.max(...data.map(d => d.count), 1);
  const BAR_HEIGHT = 160;

  return (
    <div className="vintage-chart">
      <div className="vintage-bars">
        {numeric.map((d, i) => (
          <div
            key={i}
            className="vintage-bar-wrap"
            title={`${d.year}: ${d.count} bottle${d.count !== 1 ? 's' : ''}`}
          >
            <div className="vintage-bar-count">{d.count > 1 ? d.count : ''}</div>
            <div
              className="vintage-bar"
              style={{ height: `${Math.max(4, (d.count / maxCount) * BAR_HEIGHT)}px` }}
            />
            <div className="vintage-bar-label">
              {numeric.length > 20 ? d.year.slice(-2) : d.year}
            </div>
          </div>
        ))}
        {nvItem && (
          <div
            className="vintage-bar-wrap vintage-bar-wrap--nv"
            title={`NV: ${nvItem.count} bottle${nvItem.count !== 1 ? 's' : ''}`}
          >
            <div className="vintage-bar-count">{nvItem.count}</div>
            <div
              className="vintage-bar vintage-bar--nv"
              style={{ height: `${Math.max(4, (nvItem.count / maxCount) * BAR_HEIGHT)}px` }}
            />
            <div className="vintage-bar-label">NV</div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Rating Distribution ───────────────────────────────────────────────────────
function RatingChart({ byRating, avg }) {
  const total = Object.values(byRating).reduce((s, v) => s + v, 0);
  const maxVal = Math.max(...Object.values(byRating), 1);

  return (
    <div className="rating-chart">
      {[5, 4, 3, 2, 1].map(stars => {
        const count = byRating[stars] || 0;
        const pct = total > 0 ? (count / total) * 100 : 0;
        return (
          <div key={stars} className="rating-row">
            <span className="rating-stars">
              {'★'.repeat(stars)}{'☆'.repeat(5 - stars)}
            </span>
            <div className="rating-track">
              <div
                className="rating-fill"
                style={{ width: `${(count / maxVal) * 100}%` }}
              />
            </div>
            <span className="rating-count">{count}</span>
            <span className="rating-pct">{pct.toFixed(0)}%</span>
          </div>
        );
      })}
      {avg && (
        <div className="rating-avg">
          Average: <strong>{avg.toFixed(1)}</strong> ★
          {total > 0 && <span> across {total} rated bottle{total !== 1 ? 's' : ''}</span>}
        </div>
      )}
      {!avg && total === 0 && (
        <p className="stats-empty">No rated bottles yet</p>
      )}
    </div>
  );
}

// ── Drink Window Visualization ────────────────────────────────────────────────
function DrinkWindowViz({ drinkWindow, total }) {
  const segments = [
    { key: 'overdue',  label: 'Past Drink Window', color: '#E07060', icon: '⚠' },
    { key: 'soon',     label: 'Drink Soon (≤90 days)', color: '#D4A070', icon: '⏱' },
    { key: 'inWindow', label: 'In Optimal Window', color: '#7B9E88', icon: '✓' },
    { key: 'notReady', label: 'Not Ready Yet', color: '#7aade0', icon: '◷' },
    { key: 'noWindow', label: 'No Dates Set', color: '#3a3a3a', icon: '—' },
  ];

  return (
    <div className="drink-window">
      {/* Segmented progress bar */}
      <div className="drink-bar">
        {total > 0 ? segments.map(seg => {
          const count = drinkWindow[seg.key] || 0;
          const pct = (count / total) * 100;
          if (pct === 0) return null;
          return (
            <div
              key={seg.key}
              className="drink-segment"
              style={{ width: `${pct}%`, background: seg.color }}
              title={`${seg.label}: ${count}`}
            />
          );
        }) : (
          <div className="drink-segment" style={{ width: '100%', background: '#252525' }} />
        )}
      </div>

      {/* Legend */}
      <div className="drink-legend">
        {segments.map(seg => {
          const count = drinkWindow[seg.key] || 0;
          return (
            <div key={seg.key} className="drink-legend-item">
              <span className="drink-legend-dot" style={{ background: seg.color }} />
              <span className="drink-legend-icon">{seg.icon}</span>
              <span className="drink-legend-label">{seg.label}</span>
              <span className="drink-legend-count" style={{ color: count > 0 && seg.key !== 'noWindow' ? seg.color : undefined }}>
                {count}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Consumption History (stacked bar) ────────────────────────────────────────
function ConsumptionChart({ consumptionByYear, consumptionByReason }) {
  if (!consumptionByYear || consumptionByYear.length === 0) {
    return (
      <p className="stats-empty">
        No consumption history yet — mark bottles as drank, gifted, or sold to see your history.
      </p>
    );
  }

  const reasons = ['drank', 'gifted', 'sold', 'other'];
  const maxTotal = Math.max(
    ...consumptionByYear.map(d => reasons.reduce((s, r) => s + (d[r] || 0), 0)),
    1
  );
  const BAR_H = 120;
  const total = Object.values(consumptionByReason).reduce((s, v) => s + v, 0);

  return (
    <div>
      <div className="consumption-chart">
        {consumptionByYear.map((d, i) => {
          const yearTotal = reasons.reduce((s, r) => s + (d[r] || 0), 0);
          return (
            <div key={i} className="consumption-year-col">
              <div
                className="consumption-bar-stack"
                style={{ height: `${BAR_H}px` }}
                title={`${d.year}: ${yearTotal} bottle${yearTotal !== 1 ? 's' : ''}`}
              >
                {reasons.map(r => {
                  const h = maxTotal > 0 ? ((d[r] || 0) / maxTotal) * BAR_H : 0;
                  if (h === 0) return null;
                  return (
                    <div
                      key={r}
                      className="consumption-segment"
                      style={{ height: `${h}px`, background: REASON_COLORS[r] }}
                      title={`${r}: ${d[r] || 0}`}
                    />
                  );
                })}
              </div>
              <div className="consumption-year-label">{d.year}</div>
            </div>
          );
        })}
      </div>

      <div className="consumption-legend">
        {reasons.map(r => (
          <span key={r} className="consumption-legend-item">
            <span className="consumption-dot" style={{ background: REASON_COLORS[r] }} />
            {r.charAt(0).toUpperCase() + r.slice(1)}: {consumptionByReason[r] || 0}
          </span>
        ))}
      </div>

      <div className="consumption-totals">
        <strong>{total}</strong> total bottles consumed
      </div>
    </div>
  );
}

// ── Purchase History (small bar chart) ───────────────────────────────────────
function PurchaseHistoryChart({ byPurchaseYear }) {
  if (!byPurchaseYear || byPurchaseYear.length === 0) {
    return <p className="stats-empty">No purchase date data</p>;
  }
  const maxVal = Math.max(...byPurchaseYear.map(d => d.count), 1);
  const BAR_H = 80;

  return (
    <div className="vintage-chart">
      <div className="vintage-bars">
        {byPurchaseYear.map((d, i) => (
          <div
            key={i}
            className="vintage-bar-wrap"
            title={`${d.year}: ${d.count} bottle${d.count !== 1 ? 's' : ''} purchased`}
          >
            <div className="vintage-bar-count">{d.count > 1 ? d.count : ''}</div>
            <div
              className="vintage-bar"
              style={{
                height: `${Math.max(4, (d.count / maxVal) * BAR_H)}px`,
                background: 'linear-gradient(to top, #5f7a8a, #7aade0)',
              }}
            />
            <div className="vintage-bar-label">
              {byPurchaseYear.length > 15 ? d.year.slice(-2) : d.year}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Top Value Bottles ─────────────────────────────────────────────────────────
function TopValueList({ bottles, currency }) {
  if (!bottles || bottles.length === 0) {
    return (
      <p className="stats-empty">
        Add prices to your bottles to see your most valuable wines.
      </p>
    );
  }

  return (
    <ol className="top-bottles-list">
      {bottles.map((b, i) => (
        <li key={i} className="top-bottle-item">
          <span className="top-bottle-rank" data-rank={i + 1}>#{i + 1}</span>
          <span
            className="top-bottle-type-dot"
            style={{ background: TYPE_COLORS[b.type] || '#7B9E88' }}
            title={TYPE_LABELS[b.type] || b.type}
          />
          <div className="top-bottle-info">
            <div className="top-bottle-name" title={b.name}>{b.name}</div>
            <div className="top-bottle-meta">{b.producer}{b.producer && b.vintage ? ' · ' : ''}{b.vintage}</div>
          </div>
          <span className="top-bottle-price" style={{ color: TYPE_COLORS[b.type] || '#7B9E88' }}>
            {fmtCurrency(b.price, currency)}
          </span>
        </li>
      ))}
    </ol>
  );
}

// ── Cellar Breakdown ──────────────────────────────────────────────────────────
function CellarBreakdownViz({ cellars, currency }) {
  if (!cellars || cellars.length === 0) {
    return <p className="stats-empty">No cellars found</p>;
  }
  const maxCount = Math.max(...cellars.map(c => c.bottleCount), 1);

  return (
    <div className="cellar-breakdown">
      {cellars.map((c, i) => (
        <div key={i} className="cellar-breakdown-row">
          <div className="cellar-breakdown-header">
            <span className="cellar-breakdown-name">{c.name}</span>
            {c.value > 0 && (
              <span className="cellar-breakdown-value">{fmtCurrency(c.value, currency)}</span>
            )}
          </div>
          <div className="cellar-breakdown-track">
            <div
              className="cellar-breakdown-fill"
              style={{ width: `${(c.bottleCount / maxCount) * 100}%` }}
            />
          </div>
          <div className="cellar-breakdown-meta">
            <span>{c.bottleCount} bottle{c.bottleCount !== 1 ? 's' : ''}</span>
            <span>{c.uniqueWines} unique wine{c.uniqueWines !== 1 ? 's' : ''}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Bottle Size Chart ─────────────────────────────────────────────────────────
function BottleSizeChart({ byBottleSize }) {
  const entries = Object.entries(byBottleSize).sort((a, b) => b[1] - a[1]);
  if (entries.length <= 1) return null; // hide if all one size
  const total = entries.reduce((s, [, v]) => s + v, 0);
  const sizeColors = ['#7B9E88', '#6EC6C6', '#D4C87A', '#D4A070', '#8B6A9A'];

  return (
    <div className="hbar-chart">
      {entries.map(([size, count], i) => (
        <div key={size} className="hbar-row">
          <span className="hbar-label">{size}</span>
          <div className="hbar-track">
            <div
              className="hbar-fill"
              style={{
                width: `${(count / total) * 100}%`,
                background: sizeColors[i % sizeColors.length],
              }}
            />
          </div>
          <span className="hbar-count">{count}</span>
          <span className="hbar-pct">{((count / total) * 100).toFixed(0)}%</span>
        </div>
      ))}
    </div>
  );
}

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

// ── Premium Upsell Gate ───────────────────────────────────────────────────────
function PremiumGate() {
  return (
    <div className="premium-gate">
      <div className="premium-gate-glow" />
      <div className="premium-gate-icon">📊</div>
      <h1>Collection Analytics</h1>
      <p className="premium-gate-sub">
        Deep insights into your entire wine collection — types, origins, vintages,
        value, drinking windows, consumption history, and more. The most comprehensive
        wine analytics dashboard available.
      </p>
      <div className="premium-gate-features">
        <div className="pgf-item"><span>🍷</span> Wine type &amp; origin breakdown</div>
        <div className="pgf-item"><span>📅</span> Vintage distribution by year</div>
        <div className="pgf-item"><span>💰</span> Collection value analysis</div>
        <div className="pgf-item"><span>⏱</span> Drinking window status</div>
        <div className="pgf-item"><span>🍇</span> Grape variety rankings</div>
        <div className="pgf-item"><span>📈</span> Consumption history over time</div>
        <div className="pgf-item"><span>🏆</span> Most valuable bottle rankings</div>
        <div className="pgf-item"><span>🏛</span> Per-cellar breakdown</div>
      </div>
      <Link to="/plans" className="btn btn-primary premium-gate-btn">
        Upgrade to Premium
      </Link>
      <p className="premium-gate-trial">
        Not sure yet? <Link to="/plans">Start a free 30-day trial</Link>
      </p>
    </div>
  );
}

// ── Empty State (no bottles) ──────────────────────────────────────────────────
function EmptyCollection() {
  return (
    <div className="stats-empty-state">
      <div className="stats-empty-icon">🍾</div>
      <h2>Your cellar is empty</h2>
      <p>Add bottles to your cellars to see your analytics.</p>
      <Link to="/cellars" className="btn btn-primary">Go to My Cellars</Link>
    </div>
  );
}

// ── Main Statistics Page ──────────────────────────────────────────────────────
function Statistics() {
  const { user, apiFetch } = useAuth();
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const planExpired =
    user?.planExpiresAt && Date.now() > new Date(user.planExpiresAt).getTime();
  const isPremium = user?.plan === 'premium' && !planExpired;

  const load = useCallback(async () => {
    if (!isPremium) { setLoading(false); return; }
    try {
      const res = await apiFetch('/api/stats/overview');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load statistics');
      setStats(data.stats);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [isPremium, apiFetch]);

  useEffect(() => { load(); }, [load]);

  if (!isPremium) return <PremiumGate />;

  if (loading) {
    return (
      <div className="stats-page stats-loading">
        <div className="stats-spinner" />
        <p>Analysing your collection…</p>
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
    drinkWindow, topValueBottles, consumptionByYear,
    consumptionByReason, cellarBreakdown,
  } = stats;

  if (overview.totalBottles === 0 && overview.totalConsumed === 0) {
    return (
      <div className="stats-page">
        <EmptyCollection />
      </div>
    );
  }

  // Build donut segments for wine types
  const typeSegments = Object.entries(byType)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([type, value]) => ({
      type,
      label: TYPE_LABELS[type] || type,
      value,
      color: TYPE_COLORS[type] || '#6a6a6a',
    }));

  const total = overview.totalBottles;
  const currency = overview.currency;
  const hasConsumption = overview.totalConsumed > 0;
  const hasMultipleSizes = Object.keys(byBottleSize).length > 1;
  const hasPurchaseDates = byPurchaseYear && byPurchaseYear.length > 0;

  return (
    <div className="stats-page">

      {/* ── Page Header ── */}
      <div className="stats-header">
        <div>
          <h1 className="stats-title">Collection Analytics</h1>
          <p className="stats-subtitle">
            Complete insights across {overview.totalCellars} cellar{overview.totalCellars !== 1 ? 's' : ''}
            {overview.totalCountries > 0 && ` · ${overview.totalCountries} countries · ${overview.totalGrapes} grape varieties`}
          </p>
        </div>
        <span className="stats-premium-badge">★ Premium</span>
      </div>

      {/* ── Primary KPIs ── */}
      <div className="kpi-grid">
        <KPICard
          icon="🍾"
          label="Active Bottles"
          value={fmt(total)}
          sub={`${fmt(overview.uniqueWines)} unique wines`}
          accentColor="#7B9E88"
        />
        <KPICard
          icon="🌍"
          label="Countries"
          value={fmt(overview.totalCountries)}
          sub={`${fmt(overview.totalGrapes)} grape varieties`}
          accentColor="#6EC6C6"
        />
        <KPICard
          icon="💰"
          label="Est. Collection Value"
          value={overview.totalValue > 0 ? fmtCurrency(overview.totalValue, currency) : '—'}
          sub={overview.avgPrice > 0 ? `avg ${fmtCurrency(overview.avgPrice, currency)} / bottle` : undefined}
          accentColor="#D4A070"
        />
        <KPICard
          icon="⭐"
          label="Avg Rating"
          value={overview.avgRating ? `${overview.avgRating} / 5` : '—'}
          accentColor="#D4C87A"
        />
        <KPICard
          icon="📅"
          label="Avg Vintage Age"
          value={overview.avgVintageAge ? `${overview.avgVintageAge} yrs` : '—'}
          sub={overview.oldestVintage
            ? `${overview.oldestVintage} → ${overview.newestVintage}`
            : undefined}
          accentColor="#8B6A9A"
        />
        <KPICard
          icon="⏱"
          label="Drink Soon / Overdue"
          value={`${drinkWindow.soon + drinkWindow.overdue}`}
          sub={drinkWindow.overdue > 0 ? `${drinkWindow.overdue} past window` : `${drinkWindow.inWindow} in window`}
          accentColor={drinkWindow.overdue > 0 ? '#E07060' : '#7B9E88'}
        />
      </div>

      {/* ── Secondary KPIs (consumption) ── */}
      {hasConsumption && (
        <div className="kpi-grid kpi-grid--secondary">
          <KPICard icon="✓" label="Total Consumed" value={fmt(overview.totalConsumed)} />
          <KPICard icon="🥂" label="Bottles Drunk" value={fmt(overview.bottlesDrunk)} />
          <KPICard icon="🎁" label="Gifted" value={fmt(overview.bottlesGifted)} />
          <KPICard icon="💵" label="Sold" value={fmt(overview.bottlesSold)} />
          {overview.avgConsumedRating && (
            <KPICard
              icon="🌟"
              label="Avg Consumed Rating"
              value={`${overview.avgConsumedRating} / 5`}
            />
          )}
        </div>
      )}

      {/* ── Main Grid ── */}
      <div className="stats-grid">

        {/* Wine Types Donut */}
        <div className="stats-card">
          <h2 className="stats-card-title">Wine Types</h2>
          {total > 0 ? (
            <div className="donut-layout">
              <DonutChart segments={typeSegments} total={total} size={180} />
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
            <p className="stats-empty">No bottles yet</p>
          )}
        </div>

        {/* Drinking Windows */}
        <div className="stats-card">
          <h2 className="stats-card-title">Drinking Windows</h2>
          <DrinkWindowViz drinkWindow={drinkWindow} total={total} />
        </div>

        {/* Vintage Distribution — full width */}
        <div className="stats-card stats-card--full">
          <h2 className="stats-card-title">
            Vintage Distribution
            {overview.oldestVintage && (
              <span className="stats-card-title-note">
                {overview.oldestVintage} – {overview.newestVintage}
              </span>
            )}
          </h2>
          <VintageBarChart data={byVintage} />
        </div>

        {/* Top Origins */}
        <div className="stats-card">
          <h2 className="stats-card-title">Top Origins</h2>
          <HBarChart data={byCountry} colors={COUNTRY_COLORS} />
        </div>

        {/* Top Grape Varieties */}
        <div className="stats-card">
          <h2 className="stats-card-title">Top Grape Varieties</h2>
          <HBarChart data={byGrape} colors={GRAPE_COLORS} />
        </div>

        {/* Top Regions */}
        {byRegion && byRegion.length > 0 && (
          <div className="stats-card">
            <h2 className="stats-card-title">Top Regions</h2>
            <HBarChart data={byRegion} colors={['#7aade0', '#6a9dd0', '#5a8dc0', '#4a7db0', '#3a6da0']} />
          </div>
        )}

        {/* Rating Distribution */}
        <div className="stats-card">
          <h2 className="stats-card-title">Rating Distribution</h2>
          <RatingChart byRating={byRating} avg={overview.avgRating} />
        </div>

        {/* Bottle Sizes (only if multiple) */}
        {hasMultipleSizes && (
          <div className="stats-card">
            <h2 className="stats-card-title">Bottle Sizes</h2>
            <BottleSizeChart byBottleSize={byBottleSize} />
          </div>
        )}

        {/* Purchase History */}
        {hasPurchaseDates && (
          <div className={`stats-card${!hasMultipleSizes && byRegion.length === 0 ? ' stats-card--full' : ''}`}>
            <h2 className="stats-card-title">Purchases by Year</h2>
            <PurchaseHistoryChart byPurchaseYear={byPurchaseYear} />
          </div>
        )}

        {/* Consumption History — full width */}
        <div className="stats-card stats-card--full">
          <h2 className="stats-card-title">Consumption History</h2>
          <ConsumptionChart
            consumptionByYear={consumptionByYear}
            consumptionByReason={consumptionByReason}
          />
        </div>

        {/* Most Valuable Bottles */}
        <div className="stats-card">
          <h2 className="stats-card-title">Most Valuable Bottles</h2>
          <TopValueList bottles={topValueBottles} currency={currency} />
        </div>

        {/* Cellar Breakdown */}
        <div className="stats-card">
          <h2 className="stats-card-title">Cellar Breakdown</h2>
          <CellarBreakdownViz cellars={cellarBreakdown} currency={currency} />
        </div>

      </div>

      <p className="stats-footnote">
        Active bottles only · Prices converted using today's exchange rates to {currency} ·
        Only your owned cellars are included
      </p>
    </div>
  );
}

export default Statistics;
