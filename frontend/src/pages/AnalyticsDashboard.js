import React, { Suspense, useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { lazy } from '../utils/lazyWithReload';
import { useAuth } from '../contexts/AuthContext';
import { listDashboards, createDashboard, updateDashboard, deleteDashboard, runAnalyticsQuery } from '../api/analytics';
import AnalyticsCharts from '../components/AnalyticsCharts';
import { humanMeasureLabel } from '../utils/analyticsLabels';
// Shares .at-chip / .at-beta with the analytics table so the two surfaces
// stay visually one feature.
import '../components/AnalyticsTable.css';
import './AnalyticsDashboard.css';

// The analytics table lives here since it moved off the cellar page (support
// ticket 2026-09-05: the cellar page's search bar and filters sat above a
// table they did not filter). Lazy — it ships its own catalogue fetch, query
// client and CSV assembly, none of which the boards pay for.
const AnalyticsTable = lazy(() => import('../components/AnalyticsTable'));

/**
 * The analytics dashboards (#987) — cube.dev-style "pages you just look at",
 * SEVERAL of them since the saved-views slice: a dropdown switches between
 * named boards, each a grid of widgets running in parallel through the same
 * bounded engine as the table. A user with no saved board sees the DEFAULT
 * set below (client-side, no DB row until they customize). One column on
 * mobile — the phone-first surface the wide table can never be.
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
              {humanMeasureLabel(label, null, t)}
              {label.includes('purchase.price') && data.currency ? ` (${data.currency.target})` : ''}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function RowsWidget({ data, t }) {
  if (!data.rows.length) return <div className="ad-empty">{t('analytics.empty', 'No bottles match this scope and these filters.')}</div>;
  const cols = Object.keys(data.rows[0].values);
  return (
    <div className="ad-mini-scroll">
      <table>
        <tbody>
          {data.rows.map((r) => (
            <tr key={r.id}>
              {cols.map((k) => {
                const v = r.values[k];
                return <td key={k}>{v === null || v === undefined ? '—' : Array.isArray(v) ? v.join(', ') : String(v)}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {data.total > data.rows.length && (
        <div className="ad-more">{t('analytics.andMore', '…and {{n}} more', { n: data.total - data.rows.length })}</div>
      )}
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
        const q = widget.query?.mode === 'rows' || (!widget.query?.mode && widget.query?.columns)
          ? { ...widget.query, mode: 'rows', limit: 8 }
          : widget.query;
        const res = await runAnalyticsQuery(apiFetch, q);
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
      {!error && data && data.mode === 'rows' && <RowsWidget data={data} t={t} />}
      {!error && data && data.mode === 'grouped' && widget.viz === 'kpi' && <KpiWidget data={data} t={t} />}
      {!error && data && data.mode === 'grouped' && widget.viz === 'table' && (
        // A grouped view pinned AS A TABLE renders as a table (UX-1: no
        // silent coercion to bars).
        data.buckets.length
          ? (
            <div className="ad-mini-scroll">
              <table>
                <tbody>
                  {data.buckets.slice(0, 8).map((b, i) => (
                    <tr key={i}>
                      {b.dimensions.map((d, j) => <td key={`d${j}`}>{d ?? '—'}</td>)}
                      {b.measures.map((m, j) => <td key={`m${j}`}>{m == null ? '—' : typeof m === 'number' ? Math.round(m * 100) / 100 : String(m)}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
              {data.buckets.length > 8 && <div className="ad-more">{t('analytics.andMore', '…and {{n}} more', { n: data.buckets.length - 8 })}</div>}
            </div>
          )
          : <div className="ad-empty">{t('analytics.empty', 'No bottles match this scope and these filters.')}</div>
      )}
      {!error && data && data.mode === 'grouped' && widget.viz !== 'kpi' && widget.viz !== 'table' && (
        data.buckets.length
          ? <AnalyticsCharts data={data} chartType={widget.viz} measureIndex={data.measureLabels.length > 1 ? 1 : 0} />
          : <div className="ad-empty">{t('analytics.empty', 'No bottles match this scope and these filters.')}</div>
      )}
    </div>
  );
}

export default function AnalyticsDashboard() {
  const { t } = useTranslation();
  const { apiFetch } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  // ?view=table opens the Table tab; ?cellar=<id> preselects that cellar's
  // scope — the link on a cellar page passes both.
  const tab = searchParams.get('view') === 'table' ? 'table' : 'boards';
  const cellarParam = /^[a-f0-9]{24}$/i.test(searchParams.get('cellar') || '') ? searchParams.get('cellar') : null;
  const showTab = (next) => {
    const sp = new URLSearchParams(searchParams);
    if (next === 'table') sp.set('view', 'table');
    else { sp.delete('view'); sp.delete('cellar'); }
    setSearchParams(sp, { replace: true });
  };
  const [boards, setBoards] = useState(null);   // null = loading; [] = none saved
  const [activeId, setActiveId] = useState(null); // null = the client-side default
  const [saveState, setSaveState] = useState(null);

  const reload = useCallback(async () => {
    try {
      const res = await listDashboards(apiFetch);
      const body = await res.json();
      if (res.ok) {
        setBoards(body.dashboards);
        setActiveId((cur) => (cur && body.dashboards.some((d) => d.id === cur) ? cur : (body.dashboards[0]?.id ?? null)));
      } else setBoards([]);
    } catch {
      setBoards([]);
    }
  }, [apiFetch]);

  useEffect(() => { reload(); }, [reload]);

  // With saved boards present, one of them is ALWAYS the active board — the
  // client-side default only exists for zero-board users (audit F2).
  const active = boards?.length ? (boards.find((d) => d.id === activeId) || boards[0]) : null;
  const widgets = active ? active.widgets : DEFAULT_WIDGETS;

  const mutate = useCallback(async (fn) => {
    setSaveState('saving');
    try {
      const res = await fn();
      setSaveState(res && res.ok === false ? 'error' : 'saved');
      await reload();
    } catch {
      setSaveState('error');
    }
  }, [reload]);

  const removeWidget = (i) => {
    const next = widgets.filter((_, j) => j !== i);
    if (active) {
      mutate(() => updateDashboard(apiFetch, active.id, { widgets: next }));
      return;
    }
    // Removing from the client-side default materializes it as a saved board.
    // The default pseudo-board only renders when NO boards exist (audit F2:
    // with a saved 'My cellar' present, this create 409'd forever), but a
    // board created in another tab can still collide — fall back to UPDATING
    // the same-named board instead of failing.
    mutate(async () => {
      const res = await createDashboard(apiFetch, t('analytics.defaultBoardName', 'My cellar'), next);
      if (res.status === 409) {
        const listRes = await listDashboards(apiFetch);
        const body = await listRes.json();
        const twin = (body.dashboards || []).find((d) => d.name === t('analytics.defaultBoardName', 'My cellar'));
        if (twin) {
          setActiveId(twin.id);
          return updateDashboard(apiFetch, twin.id, { widgets: next });
        }
      } else if (res.ok) {
        const body = await res.json();
        setActiveId(body.dashboard.id);
      }
      return res;
    });
  };

  const newBoard = async () => {
    const name = window.prompt(t('analytics.newDashboardPrompt', 'Name the new dashboard:'), '');
    if (!name || !name.trim()) return;
    await mutate(async () => {
      const res = await createDashboard(apiFetch, name.trim(), []);
      const body = await res.json();
      if (res.ok) setActiveId(body.dashboard.id);
      return res;
    });
  };

  const deleteBoard = async () => {
    if (!active) return;
    if (!window.confirm(t('analytics.deleteDashboardConfirm', 'Delete the dashboard "{{name}}"? Its widgets are gone for good.', { name: active.name }))) return;
    await mutate(() => deleteDashboard(apiFetch, active.id));
    setActiveId(null);
  };

  return (
    <div className="analytics-dashboard">
      <div className="ad-tabs" role="tablist" aria-label={t('analytics.tabsAria', 'Analytics sections')}>
        <button type="button" role="tab" className={`ad-tab${tab === 'boards' ? ' active' : ''}`} aria-selected={tab === 'boards'} onClick={() => showTab('boards')}>
          {t('analytics.tabs.boards', 'Boards')}
        </button>
        <button type="button" role="tab" className={`ad-tab${tab === 'table' ? ' active' : ''}`} aria-selected={tab === 'table'} onClick={() => showTab('table')}>
          {t('analytics.tabs.table', 'Table')}
        </button>
      </div>
      {tab === 'table' ? (
        <Suspense fallback={<div className="ad-empty">{t('analytics.loading', 'Loading…')}</div>}>
          <AnalyticsTable cellarId={cellarParam} />
        </Suspense>
      ) : (
      <>
      <div className="ad-head">
        <h1>
          {boards && boards.length > 0 ? (
            <select
              className="ad-board-select"
              value={activeId ?? boards[0].id}
              onChange={(e) => setActiveId(e.target.value)}
            >
              {boards.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          ) : (
            t('analytics.dashboardTitle', 'Dashboard')
          )}
          <span className="at-beta" title={t('analytics.betaHint', 'Analytics is new and still settling in. If a number looks wrong or something misbehaves, please tell us via Support — it helps more than you would think.')}>
            {t('analytics.beta', 'Beta')}
          </span>
        </h1>
        <div className="ad-head-actions">
          {saveState === 'saving' && <span className="ad-save-note">{t('analytics.saving', 'Saving…')}</span>}
          {saveState === 'error' && <span className="ad-save-note ad-save-error">{t('analytics.saveFailed', 'Could not save')}</span>}
          <button className="at-chip" onClick={newBoard}>{t('analytics.newDashboard', '+ New dashboard')}</button>
          {active && (
            <button className="at-chip" onClick={deleteBoard}>{t('analytics.deleteDashboard', 'Delete')}</button>
          )}
        </div>
      </div>
      <p className="ad-hint">
        {t('analytics.dashboardHint', 'Widgets come from the Table tab: group something interesting there and press "Add to dashboard".')}
      </p>
      <div className="ad-grid">
        {boards === null && <div className="ad-empty">{t('analytics.loading', 'Loading…')}</div>}
        {boards !== null && widgets.map((w, i) => (
          <Widget key={`${w.title}-${i}`} widget={w} onRemove={() => removeWidget(i)} />
        ))}
        {boards !== null && active && !widgets.length && (
          <div className="ad-empty">{t('analytics.emptyBoard', 'This dashboard is empty — pin views to it from the Table tab.')}</div>
        )}
      </div>
      </>
      )}
    </div>
  );
}

export { DEFAULT_WIDGETS };
