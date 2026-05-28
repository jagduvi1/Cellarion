import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { adminGetGlobalStats } from '../api/admin';
import './AdminStats.css';

function StatCard({ label, value, sublabel }) {
  return (
    <div className="admin-stats-card">
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

function fmt(n) {
  if (n == null) return '—';
  return Number(n).toLocaleString();
}

function AdminStats() {
  const { t } = useTranslation();
  const { apiFetch } = useAuth();
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const fetchStats = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await adminGetGlobalStats(apiFetch);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setStats(data);
    } catch (err) {
      setError(err.message || 'Failed to load stats');
    } finally {
      setLoading(false);
    }
  }, [apiFetch]);

  useEffect(() => { fetchStats(); }, [fetchStats]);

  if (loading) {
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

  const { overview, activity, vintage, byType, topCountries, topRegions, topGrapes, topProducers, topWines, priceByCurrency, holdingTime, byBottleSize, cellarSizeDistribution } = stats;

  return (
    <div className="admin-stats-page">
      <div className="admin-stats-header">
        <h1>{t('adminStats.title')}</h1>
        <div className="admin-stats-meta">
          <span>{t('adminStats.generatedAt')}: {new Date(stats.generatedAt).toLocaleString()}</span>
          <button className="btn btn-secondary btn-sm" onClick={fetchStats}>{t('adminStats.refresh')}</button>
        </div>
      </div>

      <p className="admin-stats-note">{t('adminStats.privacyNote')}</p>

      {/* ── Overview ── */}
      <section>
        <h2>{t('adminStats.section.overview')}</h2>
        <div className="admin-stats-cards">
          <StatCard label={t('adminStats.totalUsers')}        value={fmt(overview.totalUsers)} sublabel={`${fmt(overview.usersWithBottles)} ${t('adminStats.withBottles')}`} />
          <StatCard label={t('adminStats.totalCellars')}      value={fmt(overview.totalCellars)} />
          <StatCard label={t('adminStats.activeBottles')}     value={fmt(overview.activeBottles)} sublabel={`${fmt(overview.totalBottles)} ${t('adminStats.allTime')}`} />
          <StatCard label={t('adminStats.consumedBottles')}   value={fmt(overview.consumedBottles)} sublabel={`${fmt(overview.drankBottles)} ${t('adminStats.drank')}`} />
          <StatCard label={t('adminStats.avgPerUser')}        value={fmt(overview.avgBottlesPerUser)} />
          <StatCard label={t('adminStats.avgPerCellar')}      value={fmt(overview.avgBottlesPerCellar)} />
          <StatCard label={t('adminStats.uniqueWines')}       value={fmt(overview.totalWineDefinitions)} sublabel={t('adminStats.inLibrary')} />
        </div>
      </section>

      {/* ── Activity ── */}
      <section>
        <h2>{t('adminStats.section.activity')}</h2>
        <div className="admin-stats-cards">
          <StatCard label={t('adminStats.newUsers30')}        value={fmt(activity.newUsers30)} sublabel={`${fmt(activity.newUsers90)} ${t('adminStats.in90Days')}`} />
          <StatCard label={t('adminStats.bottlesAdded30')}    value={fmt(activity.bottlesAdded30)} sublabel={`${fmt(activity.bottlesAdded90)} ${t('adminStats.in90Days')}`} />
          <StatCard label={t('adminStats.bottlesConsumed30')} value={fmt(activity.bottlesConsumed30)} sublabel={`${fmt(activity.bottlesConsumed90)} ${t('adminStats.in90Days')}`} />
        </div>
      </section>

      {/* ── Vintage ── */}
      <section>
        <h2>{t('adminStats.section.vintage')}</h2>
        <div className="admin-stats-cards">
          <StatCard label={t('adminStats.avgVintageAge')}  value={vintage.avgAge != null ? `${vintage.avgAge} ${t('adminStats.years')}` : '—'} />
          <StatCard label={t('adminStats.oldestVintage')}  value={fmt(vintage.oldest)} />
          <StatCard label={t('adminStats.newestVintage')}  value={fmt(vintage.newest)} />
          <StatCard label={t('adminStats.withVintage')}    value={fmt(vintage.withVintageCount)} sublabel={t('adminStats.bottlesUnit')} />
        </div>
        {vintage.byDecade && vintage.byDecade.length > 0 && (
          <div className="admin-stats-panel">
            <h3>{t('adminStats.byDecade')}</h3>
            <table className="admin-stats-table">
              <tbody>
                {vintage.byDecade.map(d => (
                  <tr key={d.decade}>
                    <td className="admin-stats-name">{d.decade}s</td>
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

      {/* ── Top wines (most-collected individual wines) ── */}
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
                    <td className="admin-stats-count">{fmt(p.totalValue)}</td>
                    <td className="admin-stats-count">{fmt(p.maxPrice)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

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
                  {holdingTime.map((h, i) => (
                    <tr key={`${h.bucket}-${i}`}>
                      <td className="admin-stats-name">{h.bucket}</td>
                      <td className="admin-stats-count">{fmt(h.count)}</td>
                      <td className="admin-stats-pct">{h.pct}%</td>
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
                  {cellarSizeDistribution.map((c, i) => (
                    <tr key={`${c.bucket}-${i}`}>
                      <td className="admin-stats-name">{c.bucket} {t('adminStats.bottlesUnit')}</td>
                      <td className="admin-stats-count">{fmt(c.cellars)} {t('adminStats.cellarsUnit')}</td>
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
