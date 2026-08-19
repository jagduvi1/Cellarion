import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { getDashboard, saveDashboard, runAnalyticsQuery } from '../api/analytics';
import AnalyticsCharts from '../components/AnalyticsCharts';
// Shares .at-chip / .at-beta with the analytics table so the two surfaces
// stay visually one feature.
import '../components/AnalyticsTable.css';
import './AnalyticsDashboard.css';

/**
 * The analytics dashboard (#987 R-E) — cube.dev-style "a page you just look
 * at". Each widget is one stored analytics query + a visualization; the page
 * runs them in parallel through the same bounded engine as the table. Until
 * the user customizes, the DEFAULT set below renders (no DB row exists) —
 * analytics opens as answers, not as an empty tool. Widgets stack to one
 * column on mobile, which is the point: this is the phone-first surface the
 * wide table can never be.
 */

const DEFAULT_WIDGETS = [
  {
    title: 'My cellar',
    viz: 'kpi',
    size: 'full',
    query: {
      mode: 'grouped',
      dimensions: [],
      measures: [
        { field: '*', agg: 'count' },
        { field: 'purchase.price', agg: 'sum' },
        { field: 'rating.current', agg: 'avg' },
      ],
    },
  },
  {
    title: 'Where my money sits',
    viz: 'bar',
    size: 'full',
    query: {
      mode: 'grouped',
      dimensions: ['wine.region'],
      measures: [{ field: '*', agg: 'count' }, { field: 'purchase.price', agg: 'sum' }],
    },
  },
  {
    title: 'What I buy (by type)',
    viz: 'donut',
    size: 'half',
    query: { mode: 'grouped', dimensions: ['wine.type'], measures: [{ field: '*', agg: 'count' }] },
  },
  {
    title: 'How bottles leave',
    viz: 'donut',
    size: 'half',
    query: {
      mode: 'grouped',
      scope: { bottles: 'consumed' },
      dimensions: ['consumption.reason'],
      measures: [{ field: '*', agg: 'count' }, { field: 'purchase.price', agg: 'sum' }],
    },
  },
  {
    title: 'Aging runway',
    viz: 'line',
    size: 'full',
    query: { mode: 'grouped', dimensions: ['maturity.drinkTo'], measures: [{ field: '*', agg: 'count' }] },
  },
];

function KpiWidget({ data, t }) {
  const bucket = data.buckets[0];
  if (!bucket) return <div className="ad-empty">{t('analytics.empty', 'No bottles match this scope and these filters.')}</div>;
  return (
    <div className="ad-kpis">
      {data.measureLabels.map((label, i) => {
        const v = bucket.measures[i];
        return (
          <div key={label} className="ad-kpi">
            <div className="ad-kpi-value">
              {v === null || v === undefined ? '—' : typeof v === 'number' ? Math.round(v * 100) / 100 : String(v)}
            </div>
            <div className="ad-kpi-label">
              {label === 'count' ? t('analytics.count', 'Bottles') : label}
              {label.includes('purchase.price') && data.currency ? ` (${data.currency.target})` : ''}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Widget({ widget, onRemove }) {
  const { t } = useTranslation();
  const { apiFetch } = useAuth();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const res = await runAnalyticsQuery(apiFetch, widget.query);
        const body = await res.json();
        if (!live) return;
        if (!res.ok) setError(body.error || 'Query failed');
        else setData(body);
      } catch {
        if (live) setError(t('analytics.networkError', 'Could not reach the server'));
      }
    })();
    return () => { live = false; };
  }, [apiFetch, widget, t]);

  const scopeNote = data?.scope && data.scope.bottles !== 'active'
    ? t(`analytics.scope.${data.scope.bottles}`, data.scope.bottles)
    : null;

  return (
    <div className={`ad-widget ad-${widget.size || 'half'}`}>
      <div className="ad-widget-head">
        <span className="ad-widget-title">{widget.title}{scopeNote ? <em> · {scopeNote}</em> : null}</span>
        {onRemove && (
          <button className="ad-x" onClick={onRemove} aria-label={t('analytics.removeWidget', 'Remove widget')}>×</button>
        )}
      </div>
      {error && <div className="ad-error">{error}</div>}
      {!error && !data && <div className="ad-empty">{t('analytics.loading', 'Loading…')}</div>}
      {!error && data && widget.viz === 'kpi' && <KpiWidget data={data} t={t} />}
      {!error && data && widget.viz !== 'kpi' && data.mode === 'grouped' && (
        data.buckets.length
          ? <AnalyticsCharts data={data} chartType={widget.viz === 'table' ? 'bar' : widget.viz} measureIndex={data.measureLabels.length > 1 ? 1 : 0} />
          : <div className="ad-empty">{t('analytics.empty', 'No bottles match this scope and these filters.')}</div>
      )}
    </div>
  );
}

export default function AnalyticsDashboard() {
  const { t } = useTranslation();
  const { apiFetch } = useAuth();
  const [widgets, setWidgets] = useState(null); // null = loading
  const [customized, setCustomized] = useState(false);
  const [saveState, setSaveState] = useState(null);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const res = await getDashboard(apiFetch);
        const body = await res.json();
        if (!live) return;
        if (res.ok && body.dashboard && body.dashboard.widgets.length) {
          setWidgets(body.dashboard.widgets);
          setCustomized(true);
        } else {
          setWidgets(DEFAULT_WIDGETS);
        }
      } catch {
        if (live) setWidgets(DEFAULT_WIDGETS);
      }
    })();
    return () => { live = false; };
  }, [apiFetch]);

  const persist = useCallback(async (next) => {
    setWidgets(next);
    setCustomized(true);
    setSaveState('saving');
    try {
      const res = await saveDashboard(apiFetch, next);
      setSaveState(res.ok ? 'saved' : 'error');
    } catch {
      setSaveState('error');
    }
  }, [apiFetch]);

  const removeWidget = (i) => persist(widgets.filter((_, j) => j !== i));
  const resetDefault = () => persist(DEFAULT_WIDGETS);

  const grid = useMemo(() => widgets || [], [widgets]);

  return (
    <div className="analytics-dashboard">
      <div className="ad-head">
        <h1>
          {t('analytics.dashboardTitle', 'Dashboard')}
          <span className="at-beta" title={t('analytics.betaHint', 'Analytics is new and still settling in. If a number looks wrong or something misbehaves, please tell us via Support — it helps more than you would think.')}>
            {t('analytics.beta', 'Beta')}
          </span>
        </h1>
        <div className="ad-head-actions">
          {saveState === 'saving' && <span className="ad-save-note">{t('analytics.saving', 'Saving…')}</span>}
          {saveState === 'error' && <span className="ad-save-note ad-save-error">{t('analytics.saveFailed', 'Could not save')}</span>}
          {customized && (
            <button className="at-chip" onClick={resetDefault}>{t('analytics.resetDashboard', 'Reset to default')}</button>
          )}
        </div>
      </div>
      <p className="ad-hint">
        {t('analytics.dashboardHint', 'Widgets come from the analytics table: open a cellar, switch to the table view, group something interesting, and press "Add to dashboard".')}
      </p>
      <div className="ad-grid">
        {widgets === null && <div className="ad-empty">{t('analytics.loading', 'Loading…')}</div>}
        {grid.map((w, i) => (
          <Widget key={`${w.title}-${i}`} widget={w} onRemove={() => removeWidget(i)} />
        ))}
      </div>
    </div>
  );
}

export { DEFAULT_WIDGETS };
