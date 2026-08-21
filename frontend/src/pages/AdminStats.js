import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { adminGetGlobalStats } from '../api/admin';
import './AdminStats.css';

function fmt(n) {
  if (n == null) return '—';
  return Number(n).toLocaleString();
}

// Activity-retention tiers that already have their own hand-written card
// ("Returning users", "Power users"). Every other tier the server sends in
// retention.activityTiers renders from the generic template, so extending
// DAY_TIERS server-side needs no change here.
const NAMED_ACTIVITY_TIERS = [2, 4];

// Raw integer formatting for fields where a thousands separator is wrong —
// vintage years (1973 not "1,973") and decade labels (2020 not "2,020").
function fmtYear(n) {
  if (n == null) return '—';
  return String(n);
}

// Display percentage that shows "<1%" when the value rounds to zero but
// isn't actually zero — avoids "6 (0%)" rows that look like a bug.
function fmtPct(value) {
  if (value == null || value === 0) return '0%';
  if (value < 1) return '<1%';
  return `${Math.round(value)}%`;
}

function StatCard({ label, value, sublabel, accent, tooltip }) {
  return (
    <div
      className={`admin-stats-card ${accent ? `admin-stats-card--${accent}` : ''}`}
      title={tooltip || undefined}
    >
      <div className="admin-stats-card-value">{value ?? '—'}</div>
      <div className="admin-stats-card-label">{label}</div>
      {sublabel && <div className="admin-stats-card-sub">{sublabel}</div>}
    </div>
  );
}

function RankedList({ title, items, valueKey = 'count', nameKey = 'name', subKey = null, total = null }) {
  if (!items || items.length === 0) return null;
  return (
    <div className="admin-stats-panel">
      <h3>{title}</h3>
      <table className="admin-stats-table">
        <tbody>
          {items.map((it, i) => {
            const v = it[valueKey] || 0;
            const sharePct = total ? Math.round((v / total) * 100) : null;
            return (
              <tr key={`${it[nameKey] || 'unknown'}-${i}`}>
                <td className="admin-stats-rank">{i + 1}</td>
                <td className="admin-stats-name">
                  <span>{it[nameKey] || 'Unknown'}</span>
                  {subKey && it[subKey] && <span className="admin-stats-sub">{it[subKey]}</span>}
                </td>
                <td className="admin-stats-count">{v.toLocaleString()}</td>
                {sharePct != null && <td className="admin-stats-pct">{sharePct}%</td>}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function BarChart({ data, valueKey = 'count', labelKey = 'month', height = 80 }) {
  const max = Math.max(1, ...data.map(d => d[valueKey] || 0));
  return (
    <div className="admin-stats-bars" style={{ height: `${height}px` }}>
      {data.map((d, i) => {
        const v = d[valueKey] || 0;
        const heightPct = (v / max) * 100;
        const label = d[labelKey];
        return (
          <div key={`${label}-${i}`} className="admin-stats-bar-wrap" title={`${label}: ${v.toLocaleString()}`}>
            <div className="admin-stats-bar" style={{ height: `${heightPct}%` }}>
              <span className="admin-stats-bar-value">{v > 0 ? v.toLocaleString() : ''}</span>
            </div>
            <div className="admin-stats-bar-label">{label.slice(-2)}</div>
          </div>
        );
      })}
    </div>
  );
}

function HorizontalBar({ label, count, total, color }) {
  const p = total > 0 ? (count / total) * 100 : 0;
  return (
    <div className="admin-stats-hbar-row">
      <div className="admin-stats-hbar-label">{label}</div>
      <div className="admin-stats-hbar-track">
        <div className="admin-stats-hbar-fill" style={{ width: `${p}%`, background: color }} />
      </div>
      <div className="admin-stats-hbar-count">{fmt(count)} <span className="admin-stats-hbar-pct">({fmtPct(p)})</span></div>
    </div>
  );
}

function AdminStats() {
  const { t } = useTranslation();
  const { apiFetch } = useAuth();
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // Admins are excluded by default so the dashboard reflects real customers,
  // not our own test/admin accounts. Uncheck the toggle to include them.
  const [excludeAdmins, setExcludeAdmins] = useState(true);

  const fetchStats = useCallback(async ({ force = false } = {}) => {
    setLoading(true);
    setError('');
    try {
      const res = await adminGetGlobalStats(apiFetch, { excludeAdmins, force });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setStats(data);
    } catch (err) {
      setError(err.message || 'Failed to load stats');
    } finally {
      setLoading(false);
    }
  }, [apiFetch, excludeAdmins]);

  useEffect(() => { fetchStats(); }, [fetchStats]);

  if (loading && !stats) {
    return (
      <div className="admin-stats-page">
        <h1>{t('adminStats.title')}</h1>
        <p>{t('adminStats.loading')}</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="admin-stats-page">
        <h1>{t('adminStats.title')}</h1>
        <p className="admin-stats-error">{error}</p>
        <button className="btn btn-secondary" onClick={fetchStats}>{t('adminStats.retry')}</button>
      </div>
    );
  }

  if (!stats) return null;

  const {
    overview, activity, engagement, retention, plans, maturity, ratings, vintage, trends, library,
    byType, topCountries, topRegions, topGrapes, topProducers, topWines,
    topExpensiveBottles, priceByCurrency, holdingTime, byBottleSize, cellarSizeDistribution,
  } = stats;

  const maturityColors = {
    peak:       '#1a7f37',
    early:      '#3fb950',
    notReady:   '#9e9e9e',
    late:       '#bf8a2e',
    declining:  '#dc3545',
    noProfile:  'var(--color-border)',
  };

  return (
    <div className="admin-stats-page">
      <div className="admin-stats-header">
        <h1>{t('adminStats.title')}</h1>
        <div className="admin-stats-meta">
          <label className="admin-stats-toggle">
            <input
              type="checkbox"
              checked={excludeAdmins}
              onChange={(e) => setExcludeAdmins(e.target.checked)}
            />
            <span>{t('adminStats.excludeAdmins')}</span>
            {stats.excludeAdmins && stats.adminsExcludedCount > 0 && (
              <span className="admin-stats-toggle-info"> ({t('adminStats.adminsHidden', { count: stats.adminsExcludedCount })})</span>
            )}
          </label>
          <span className="admin-stats-meta-sep">·</span>
          <span title={stats.fromCache ? t('adminStats.cachedAtTip', { ts: stats.cachedAt ? new Date(stats.cachedAt).toLocaleString() : '' }) : undefined}>
            {t('adminStats.generatedAt')}: {new Date(stats.generatedAt).toLocaleString()}
            {stats.fromCache && <span className="admin-stats-cache-tag"> · {t('adminStats.cached')}</span>}
          </span>
          <button className="btn btn-secondary btn-sm" onClick={() => fetchStats({ force: true })} disabled={loading}>
            {loading ? '…' : t('adminStats.refresh')}
          </button>
        </div>
      </div>

      <p className="admin-stats-note">{t('adminStats.privacyNote')}</p>

      {/* ── Overview ── */}
      <section>
        <h2>{t('adminStats.section.overview')}</h2>
        <div className="admin-stats-cards">
          <StatCard label={t('adminStats.totalUsers')}        value={fmt(overview.totalUsers)} sublabel={t('adminStats.withBottles', { count: overview.usersWithBottles ?? 0 })} />
          <StatCard label={t('adminStats.totalCellars')}      value={fmt(overview.totalCellars)} />
          <StatCard label={t('adminStats.activeBottles')}     value={fmt(overview.activeBottles)} sublabel={t('adminStats.allTime', { count: overview.totalBottles ?? 0 })} />
          <StatCard label={t('adminStats.consumedBottles')}   value={fmt(overview.consumedBottles)} sublabel={[
            t('adminStats.drank', { count: overview.drankBottles ?? 0 }),
            t('adminStats.gifted', { count: overview.giftedBottles ?? 0 }),
            t('adminStats.sold', { count: overview.soldBottles ?? 0 }),
            t('adminStats.other', { count: overview.otherBottles ?? 0 }),
          ].join(' · ')} />
          <StatCard label={t('adminStats.avgPerUser')}        value={fmt(overview.avgBottlesPerUser)} />
          <StatCard label={t('adminStats.avgPerCellar')}      value={fmt(overview.avgBottlesPerCellar)} />
          <StatCard label={t('adminStats.uniqueWines')}       value={fmt(overview.totalWineDefinitions)} sublabel={t('adminStats.inLibrary')} />
        </div>
      </section>

      {/* ── Engagement ── */}
      <section>
        <h2>{t('adminStats.section.engagement')}</h2>
        <p className="admin-stats-section-note">{t('adminStats.engagementNote')}</p>
        <div className="admin-stats-cards">
          <StatCard accent="ok" tooltip={t('adminStats.engagementTooltip')} label={t('adminStats.activeUsers24h')} value={fmt(engagement.activeUsers24h)} sublabel={t('adminStats.dau')} />
          <StatCard tooltip={t('adminStats.engagementTooltip')} label={t('adminStats.activeUsers7d')}  value={fmt(engagement.activeUsers7d)}  sublabel={t('adminStats.wau')} />
          <StatCard tooltip={t('adminStats.engagementTooltip')} label={t('adminStats.activeUsers30d')} value={fmt(engagement.activeUsers30d)} sublabel={t('adminStats.mau')} />
          <StatCard tooltip={t('adminStats.engagementTooltip')} label={t('adminStats.activeUsers90d')} value={fmt(engagement.activeUsers90d)} sublabel={t('adminStats.in90Days')} />
        </div>
      </section>

      {/* ── Retention / returning users ── */}
      {retention && (
        <section>
          <h2>{t('adminStats.section.retention')}</h2>
          <p className="admin-stats-section-note">
            {t('adminStats.retentionNote')}
          </p>
          {/* Do NEW users come back? The ladder below measures the whole
              population at once, so it is dominated by whoever has been here
              longest; this asks the question that tracks growth. */}
          {retention.signupCohorts && retention.signupCohorts.length > 0 && (
            <>
              <h3 className="admin-stats-subhead">{t('adminStats.cohortsHead')}</h3>
              <div className="admin-stats-cards">
                <StatCard
                  accent="ok"
                  label={t('adminStats.cohortReturned')}
                  value={fmtPct(retention.cohortReturnedPct)}
                  sublabel={t('adminStats.cohortReturnedSub', {
                    returned: retention.cohortReturned ?? 0,
                    total: retention.cohortSignups ?? 0,
                  })}
                  tooltip={t('adminStats.cohortReturnedTooltip')}
                />
              </div>
              <div className="admin-stats-panel">
                {/* Own class, not just admin-stats-table: this table's right
                    cell holds "7 · 44%", and on a phone that must never split
                    across lines (it read as broken data when it did). The
                    other admin tables are unaffected. */}
                <table className="admin-stats-table admin-stats-cohorts">
                  <tbody>
                    {retention.signupCohorts.map((c) => (
                      <tr key={c.daysAgoFrom} className={c.tooNew ? 'admin-stats-row-empty' : undefined}>
                        <td className="admin-stats-name">
                          {t('adminStats.cohortRange', { from: c.daysAgoFrom, to: c.daysAgoTo })}
                        </td>
                        <td className="admin-stats-count">{fmt(c.signedUp)}</td>
                        <td className="admin-stats-pct">
                          {/* The newest cohort shows its intake and NO rate:
                              its members are "active in the last 7 days"
                              because they signed up in them. A number here
                              would read as ~97% retention and mean nothing. */}
                          {c.tooNew
                            ? t('adminStats.cohortTooNew')
                            : `${fmt(c.returned)} · ${fmtPct(c.pct)}`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="admin-stats-section-note">{t('adminStats.cohortNote')}</p>
              </div>
            </>
          )}

          <h3 className="admin-stats-subhead">{t('adminStats.retentionByActivity')}</h3>
          <div className="admin-stats-cards">
            <StatCard
              accent="ok"
              label={t('adminStats.returningUsers')}
              value={fmt(retention.returningUsers)}
              sublabel={`${fmtPct(retention.returningPct)} ${t('adminStats.ofActiveUsers')}`}
              tooltip={t('adminStats.returningTooltip')}
            />
            <StatCard
              accent="ok"
              label={t('adminStats.coreUsers')}
              value={fmt(retention.coreUsers)}
              sublabel={`${fmtPct(retention.corePct)} ${t('adminStats.ofActiveUsers')}`}
              tooltip={t('adminStats.coreTooltip')}
            />
            {/* Tiers beyond the two named cards above render generically, so
                adding a threshold to DAY_TIERS on the server needs no change here. */}
            {(retention.activityTiers || [])
              .filter(tier => !NAMED_ACTIVITY_TIERS.includes(tier.days))
              .map(tier => (
                <StatCard
                  key={`activity-${tier.days}`}
                  label={t('adminStats.activityTier', { days: tier.days })}
                  value={fmt(tier.users)}
                  sublabel={`${fmtPct(tier.pct)} ${t('adminStats.ofActiveUsers')}`}
                  tooltip={t('adminStats.activityTierTooltip', { days: tier.days })}
                />
              ))}
            <StatCard
              label={t('adminStats.singleSessionUsers')}
              value={fmt(retention.singleSessionUsers)}
              sublabel={t('adminStats.singleSessionSub')}
              tooltip={t('adminStats.singleSessionTooltip')}
            />
          </div>

        </section>
      )}

      {/* ── Activity (30/90d) ── */}
      <section>
        <h2>{t('adminStats.section.activity')}</h2>
        <div className="admin-stats-cards">
          <StatCard label={t('adminStats.newUsers30')}        value={fmt(activity.newUsers30)} sublabel={t('adminStats.countIn90Days', { count: activity.newUsers90 ?? 0 })} />
          <StatCard label={t('adminStats.bottlesAdded30')}    value={fmt(activity.bottlesAdded30)} sublabel={t('adminStats.countIn90Days', { count: activity.bottlesAdded90 ?? 0 })} />
          <StatCard label={t('adminStats.bottlesConsumed30')} value={fmt(activity.bottlesConsumed30)} sublabel={t('adminStats.countIn90Days', { count: activity.bottlesConsumed90 ?? 0 })} />
        </div>
      </section>

      {/* ── 12-month trends ── */}
      <section>
        <h2>{t('adminStats.section.trends')}</h2>
        <div className="admin-stats-grid">
          <div className="admin-stats-panel">
            <h3>{t('adminStats.trendBottlesAdded')}</h3>
            <BarChart data={trends.bottlesAdded} />
          </div>
          <div className="admin-stats-panel">
            <h3>{t('adminStats.trendBottlesConsumed')}</h3>
            <BarChart data={trends.bottlesConsumed} />
          </div>
          <div className="admin-stats-panel">
            <h3>{t('adminStats.trendNewUsers')}</h3>
            <BarChart data={trends.newUsers} />
          </div>
          <div className="admin-stats-panel">
            <h3>{t('adminStats.trendNewCellars')}</h3>
            <BarChart data={trends.newCellars} />
          </div>
        </div>
      </section>

      {/* ── Subscriptions ── */}
      <section>
        <h2>{t('adminStats.section.subscriptions')}</h2>
        <div className="admin-stats-cards">
          <StatCard
            accent="ok"
            label={t('adminStats.paidUsers')}
            value={fmt(plans.paidUsers)}
            sublabel={t('adminStats.newSupporters30', { count: plans.newSupporters30d ?? 0 })}
            tooltip={t('adminStats.paidUsersTooltip')}
          />
          {/* The churn number, and the only place on this page it appears. */}
          <StatCard
            label={t('adminStats.formerSupporters')}
            value={fmt(plans.formerSupporters)}
            sublabel={t('adminStats.formerSupportersSub')}
            accent={plans.formerSupporters > 0 ? 'warn' : null}
            tooltip={t('adminStats.formerSupportersTooltip')}
          />
          <StatCard
            label={t('adminStats.newSupporters90')}
            value={fmt(plans.newSupporters90d)}
            tooltip={t('adminStats.newSupportersTooltip')}
          />
          <StatCard label={t('adminStats.withStripeCustomer')} value={fmt(plans.withStripeCustomer)} />
          {/* Only meaningful when a tier actually has an end date. A live
              Stripe subscription renews instead of expiring, so this reads 0
              for every ordinary supporter and would otherwise be a card that
              says nothing on every single load. */}
          {(plans.expiringIn30d > 0 || plans.expiringIn7d > 0) && (
            <StatCard
              label={t('adminStats.expiringIn7d')}
              value={fmt(plans.expiringIn7d)}
              sublabel={t('adminStats.in30Days', { count: plans.expiringIn30d ?? 0 })}
              accent={plans.expiringIn7d > 0 ? 'warn' : null}
            />
          )}
        </div>
        {plans.distribution && plans.distribution.length > 0 && (
          <div className="admin-stats-panel">
            <h3>{t('adminStats.byPlan')}</h3>
            <table className="admin-stats-table">
              <tbody>
                {plans.distribution.map((p, i) => {
                  const pp = overview.totalUsers > 0 ? Math.round((p.count / overview.totalUsers) * 100) : 0;
                  return (
                    // A configured tier with nobody on it renders dimmed rather
                    // than being absent — "nobody chose benefactor" and
                    // "benefactor doesn't exist" are different answers, and
                    // only one of them is worth acting on.
                    <tr
                      key={`${p.plan || 'unknown'}-${i}`}
                      className={p.count === 0 ? 'admin-stats-row-empty' : undefined}
                    >
                      <td className="admin-stats-name">
                        {p.plan || '—'}
                        {/* A plan value in the data that the config doesn't
                            define — retired, or set by hand. Shown, not
                            dropped: it's still real users. */}
                        {p.unconfigured && <span className="admin-stats-tag"> {t('adminStats.planUnconfigured')}</span>}
                      </td>
                      <td className="admin-stats-count">{fmt(p.count)}</td>
                      <td className="admin-stats-pct">{pp}%</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── Maturity & drink windows (Cellarion's USP) ── */}
      <section>
        <h2>{t('adminStats.section.maturity')}</h2>
        <p className="admin-stats-section-note">
          {t('adminStats.maturityNote', { coverage: maturity.coveragePct })}
        </p>
        <div className="admin-stats-cards">
          <StatCard
            accent="ok"
            label={t('adminStats.maturityHave')}
            value={fmt(maturity.bottlesWithProfile)}
            sublabel={`${fmtPct(maturity.coveragePct)} ${t('adminStats.ofActiveBottles')}`}
            tooltip={t('adminStats.maturityHaveTooltip')}
          />
          <StatCard
            accent={maturity.noProfile > maturity.bottlesWithProfile ? 'warn' : null}
            label={t('adminStats.maturityMissing')}
            value={fmt(maturity.noProfile)}
            sublabel={t('adminStats.maturityMissingSub')}
            tooltip={t('adminStats.maturityMissingTooltip')}
          />
        </div>
        <div className="admin-stats-panel">
          {maturity.bottlesWithProfile > 0 ? (
            <>
              <HorizontalBar label={t('adminStats.maturityPeak')}      count={maturity.peak}      total={maturity.bottlesWithProfile} color={maturityColors.peak} />
              <HorizontalBar label={t('adminStats.maturityEarly')}     count={maturity.early}     total={maturity.bottlesWithProfile} color={maturityColors.early} />
              <HorizontalBar label={t('adminStats.maturityNotReady')}  count={maturity.notReady}  total={maturity.bottlesWithProfile} color={maturityColors.notReady} />
              <HorizontalBar label={t('adminStats.maturityLate')}      count={maturity.late}      total={maturity.bottlesWithProfile} color={maturityColors.late} />
              <HorizontalBar label={t('adminStats.maturityDeclining')} count={maturity.declining} total={maturity.bottlesWithProfile} color={maturityColors.declining} />
            </>
          ) : (
            <p className="admin-stats-empty">{t('adminStats.maturityEmpty')}</p>
          )}
          <p className="admin-stats-sub" style={{ marginTop: '0.75rem' }}>
            {t('adminStats.maturityNoProfile', { count: fmt(maturity.noProfile) })}
          </p>
        </div>
      </section>

      {/* ── Quality & ratings ── */}
      <section>
        <h2>{t('adminStats.section.ratings')}</h2>
        <div className="admin-stats-cards">
          <StatCard label={t('adminStats.avgRating')}    value={ratings.avgNormalized != null ? `${ratings.avgNormalized}/100` : '—'} sublabel={t('adminStats.ratedBottles', { count: ratings.ratedCount ?? 0 })} />
        </div>
        <div className="admin-stats-grid">
          {ratings.distribution && ratings.distribution.length > 0 && (
            <div className="admin-stats-panel">
              <h3>{t('adminStats.ratingDistribution')}</h3>
              {ratings.distribution.filter(r => r.count > 0).map((r, i) => (
                <HorizontalBar key={`${r.band}-${i}`} label={r.band} count={r.count} total={ratings.ratedCount} color="var(--color-accent)" />
              ))}
            </div>
          )}
          {ratings.byType && ratings.byType.length > 0 && (
            <div className="admin-stats-panel">
              <h3>{t('adminStats.avgRatingByType')}</h3>
              <table className="admin-stats-table">
                <thead>
                  <tr>
                    <th>{t('adminStats.type')}</th>
                    <th>{t('adminStats.avg')}</th>
                    <th>{t('adminStats.priceCount')}</th>
                  </tr>
                </thead>
                <tbody>
                  {ratings.byType.map((r, i) => (
                    <tr key={`${r.type || 'unknown'}-${i}`}>
                      <td className="admin-stats-name">{r.type || '—'}</td>
                      <td className="admin-stats-count">{r.avg}</td>
                      <td className="admin-stats-count">{fmt(r.count)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      {/* ── Vintage ── */}
      <section>
        <h2>{t('adminStats.section.vintage')}</h2>
        <div className="admin-stats-cards">
          <StatCard label={t('adminStats.avgVintageAge')}  value={vintage.avgAge != null ? t('adminStats.years', { count: vintage.avgAge }) : '—'} />
          <StatCard label={t('adminStats.oldestVintage')}  value={fmtYear(vintage.oldest)} />
          <StatCard label={t('adminStats.newestVintage')}  value={fmtYear(vintage.newest)} />
          <StatCard label={t('adminStats.withVintage')}    value={fmt(vintage.withVintageCount)} sublabel={t('adminStats.bottlesUnit')} />
        </div>
        {vintage.byDecade && vintage.byDecade.length > 0 && (
          <div className="admin-stats-panel">
            <h3>{t('adminStats.byDecade')}</h3>
            <table className="admin-stats-table">
              <tbody>
                {vintage.byDecade.map(d => (
                  <tr key={d.decade}>
                    <td className="admin-stats-name">{fmtYear(d.decade)}s</td>
                    <td className="admin-stats-count">{fmt(d.count)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── Composition ── */}
      <section>
        <h2>{t('adminStats.section.composition')}</h2>
        <div className="admin-stats-grid">
          <RankedList title={t('adminStats.topCountries')} items={topCountries} total={overview.activeBottles} />
          <RankedList title={t('adminStats.topRegions')}   items={topRegions}   total={overview.activeBottles} />
          <RankedList title={t('adminStats.topGrapes')}    items={topGrapes}    total={overview.activeBottles} />
          <RankedList title={t('adminStats.topProducers')} items={topProducers} total={overview.activeBottles} />
          {byType && byType.length > 0 && (
            <div className="admin-stats-panel">
              <h3>{t('adminStats.byType')}</h3>
              <table className="admin-stats-table">
                <tbody>
                  {byType.map((b, i) => {
                    const p = overview.activeBottles > 0 ? Math.round((b.count / overview.activeBottles) * 100) : 0;
                    return (
                      <tr key={`${b.type || 'unknown'}-${i}`}>
                        <td className="admin-stats-name">{b.type || 'unknown'}</td>
                        <td className="admin-stats-count">{fmt(b.count)}</td>
                        <td className="admin-stats-pct">{p}%</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      {/* ── Top wines (most-collected) ── */}
      {topWines && topWines.length > 0 && (
        <section>
          <h2>{t('adminStats.section.topWines')}</h2>
          <div className="admin-stats-panel">
            <table className="admin-stats-table">
              <tbody>
                {topWines.map((w, i) => (
                  <tr key={`${w.name}-${w.producer}-${i}`}>
                    <td className="admin-stats-rank">{i + 1}</td>
                    <td className="admin-stats-name">
                      <span>{w.name}</span>
                      {w.producer && <span className="admin-stats-sub">{w.producer}</span>}
                    </td>
                    <td className="admin-stats-count">{fmt(w.count)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* ── Top expensive bottles ── */}
      {topExpensiveBottles && topExpensiveBottles.length > 0 && (
        <section>
          <h2>{t('adminStats.section.topExpensive')}</h2>
          {topExpensiveBottles[0]?.redacted && (
            <p className="admin-stats-section-note">{t('adminStats.topExpensiveRedacted')}</p>
          )}
          <div className="admin-stats-panel">
            <table className="admin-stats-table">
              <tbody>
                {topExpensiveBottles.map((w, i) => (
                  <tr key={`${w.name || 'redacted'}-${w.vintage || i}-${i}`}>
                    <td className="admin-stats-rank">{i + 1}</td>
                    <td className="admin-stats-name">
                      {w.redacted ? (
                        <span className="admin-stats-sub">{t('adminStats.bottleRedacted')}</span>
                      ) : (
                        <>
                          <span>{w.name}</span>
                          {w.producer && <span className="admin-stats-sub">{w.producer} · {w.vintage}</span>}
                        </>
                      )}
                    </td>
                    <td className="admin-stats-count">{fmt(w.price)} {w.currency || ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* ── Money ── */}
      {priceByCurrency && priceByCurrency.length > 0 && (
        <section>
          <h2>{t('adminStats.section.value')}</h2>
          <div className="admin-stats-panel">
            <table className="admin-stats-table">
              <thead>
                <tr>
                  <th>{t('adminStats.currency')}</th>
                  <th>{t('adminStats.priceCount')}</th>
                  <th>{t('adminStats.avgPrice')}</th>
                  <th>{t('adminStats.medianPrice')}</th>
                  <th>{t('adminStats.totalValue')}</th>
                  <th>{t('adminStats.maxPrice')}</th>
                </tr>
              </thead>
              <tbody>
                {priceByCurrency.map(p => (
                  <tr key={p.currency}>
                    <td className="admin-stats-name">{p.currency || '—'}</td>
                    <td className="admin-stats-count">{fmt(p.count)}</td>
                    <td className="admin-stats-count">{fmt(p.avgPrice)}</td>
                    <td className="admin-stats-count">{fmt(p.medianPrice)}</td>
                    <td className="admin-stats-count">{fmt(p.totalValue)}</td>
                    <td className="admin-stats-count">{fmt(p.maxPrice)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* ── Library health ── */}
      <section>
        <h2>{t('adminStats.section.library')}</h2>
        <div className="admin-stats-cards">
          <StatCard label={t('adminStats.totalWineDefs')}    value={fmt(library.totalWineDefinitions)} sublabel={t('adminStats.withBottlesShort', { count: library.wineDefinitionsWithBottles ?? 0 })} />
          <StatCard label={t('adminStats.profilesReviewed')} value={fmt(library.profilesReviewed)} sublabel={t('adminStats.profilesTotal', { count: library.profilesTotal ?? 0 })} />
          <StatCard label={t('adminStats.profilesPending')}  value={fmt(library.profilesPending)} accent={library.profilesPending > 50 ? 'warn' : null} />
          <StatCard label={t('adminStats.pendingWineRequests')} value={fmt(library.pendingWineRequests)} accent={library.pendingWineRequests > 5 ? 'warn' : null} />
          <StatCard label={t('adminStats.pendingImageReviews')} value={fmt(library.pendingImageReviews)} accent={library.pendingImageReviews > 10 ? 'warn' : null} />
          <StatCard label={t('adminStats.totalImages')}      value={fmt(library.totalImages)} />
          <StatCard label={t('adminStats.totalRacks')}       value={fmt(library.totalRacks)} />
        </div>
      </section>

      {/* ── Distributions ── */}
      <section>
        <h2>{t('adminStats.section.patterns')}</h2>
        <div className="admin-stats-grid">
          {holdingTime && holdingTime.length > 0 && (
            <div className="admin-stats-panel">
              <h3>{t('adminStats.holdingTime')}</h3>
              <p className="admin-stats-sub">{t('adminStats.holdingTimeNote')}</p>
              <table className="admin-stats-table">
                <tbody>
                  {holdingTime.filter(h => h.count > 0).map((h, i) => (
                    <tr key={`${h.bucket}-${i}`}>
                      <td className="admin-stats-name">{h.bucket}</td>
                      <td className="admin-stats-count">{fmt(h.count)}</td>
                      <td className="admin-stats-pct">{fmtPct(h.pct)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {cellarSizeDistribution && cellarSizeDistribution.length > 0 && (
            <div className="admin-stats-panel">
              <h3>{t('adminStats.cellarSize')}</h3>
              <p className="admin-stats-sub">{t('adminStats.cellarSizeNote')}</p>
              <table className="admin-stats-table">
                <tbody>
                  {cellarSizeDistribution.filter(c => c.cellars > 0).map((c, i) => (
                    <tr key={`${c.bucket}-${i}`}>
                      <td className="admin-stats-name">
                        {c.bucket === 'other' ? t('adminStats.cellarSizeOther') : t('adminStats.cellarSizeBucket', { bucket: c.bucket })}
                      </td>
                      <td className="admin-stats-count">{t('adminStats.cellarsUnit', { count: c.cellars ?? 0 })}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {byBottleSize && byBottleSize.length > 0 && (
            <div className="admin-stats-panel">
              <h3>{t('adminStats.bottleSize')}</h3>
              <table className="admin-stats-table">
                <tbody>
                  {byBottleSize.map((b, i) => (
                    <tr key={`${b.size || 'unknown'}-${i}`}>
                      <td className="admin-stats-name">{b.size || '—'}</td>
                      <td className="admin-stats-count">{fmt(b.count)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

export default AdminStats;
