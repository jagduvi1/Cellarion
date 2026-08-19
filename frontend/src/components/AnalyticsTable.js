import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { getAnalyticsCatalogue, runAnalyticsQuery } from '../api/analytics';
import { listCellars } from '../api/cellars';
import { csvEscape } from '../utils/importReport';
import downloadBlob from '../utils/downloadBlob';
import './AnalyticsTable.css';

/**
 * The self-service analytics table (#987 Phase 1) — a third view mode on the
 * cellar page. Columns come from the field catalogue (including the user's
 * own typed personal keys and the public registry vocabulary), filters and
 * sorting run server-side through /api/analytics/query, and the CSV export
 * is exactly the current query.
 *
 * The scope pill is a design requirement, not decoration: whether consumed
 * bottles count changes nearly every number, so the active scope must be
 * visible at all times, never applied invisibly.
 */

const DEFAULT_COLUMNS = ['wine.producer', 'wine.name', 'bottle.vintage', 'wine.region', 'purchase.price', 'bottle.status'];
const PAGE_SIZE = 50;
const CSV_MAX_ROWS = 10000;

const loadStoredColumns = () => {
  try {
    const raw = localStorage.getItem('cellarion_analytics_columns');
    const arr = raw ? JSON.parse(raw) : null;
    return Array.isArray(arr) && arr.length ? arr : DEFAULT_COLUMNS;
  } catch {
    return DEFAULT_COLUMNS;
  }
};

const OP_LABELS = {
  eq: '=', neq: '≠', gt: '>', gte: '≥', lt: '<', lte: '≤',
  between: 'between', contains: 'contains', in: 'is one of',
};

function formatValue(v, field) {
  if (v === null || v === undefined || v === '') return '—';
  if (Array.isArray(v)) return v.join(', ');
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (field && field.unit && field.unit !== 'currency' && typeof v === 'number') return `${v} ${field.unit}`;
  return String(v);
}

function FilterValueInput({ field, op, value, onChange }) {
  if (op === 'between') {
    const pair = Array.isArray(value) ? value : ['', ''];
    const set = (i, v) => { const next = [...pair]; next[i] = v; onChange(next); };
    const type = field.type === 'date' ? 'date' : 'number';
    return (
      <span className="at-between">
        <input type={type} value={pair[0]} onChange={(e) => set(0, e.target.value)} />
        <span>–</span>
        <input type={type} value={pair[1]} onChange={(e) => set(1, e.target.value)} />
      </span>
    );
  }
  if (field.type === 'enum') {
    if (op === 'in') {
      const arr = Array.isArray(value) ? value : [];
      const toggle = (opt) => onChange(arr.includes(opt) ? arr.filter((x) => x !== opt) : [...arr, opt]);
      return (
        <span className="at-enum-multi">
          {(field.enumOptions || []).map((opt) => (
            <label key={opt}><input type="checkbox" checked={arr.includes(opt)} onChange={() => toggle(opt)} />{opt}</label>
          ))}
        </span>
      );
    }
    return (
      <select value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
        <option value="" disabled>…</option>
        {(field.enumOptions || []).map((opt) => <option key={opt} value={opt}>{opt}</option>)}
      </select>
    );
  }
  if (field.type === 'boolean') {
    return (
      <select value={value === true ? 'true' : value === false ? 'false' : ''} onChange={(e) => onChange(e.target.value === 'true')}>
        <option value="" disabled>…</option>
        <option value="true">Yes</option>
        <option value="false">No</option>
      </select>
    );
  }
  const inputType = field.type === 'date' ? 'date' : (field.type === 'integer' || field.type === 'decimal') ? 'number' : 'text';
  return <input type={inputType} value={value ?? ''} onChange={(e) => onChange(e.target.value)} />;
}

export default function AnalyticsTable({ cellarId }) {
  const { t } = useTranslation();
  const { apiFetch } = useAuth();

  const [catalogue, setCatalogue] = useState([]);
  const [cellars, setCellars] = useState([]);
  const [columns, setColumns] = useState(loadStoredColumns);
  const [filters, setFilters] = useState([]);          // applied
  const [draftFilters, setDraftFilters] = useState([]); // being edited
  const [sort, setSort] = useState(null);
  const [scopeCellars, setScopeCellars] = useState(() => (cellarId ? [cellarId] : 'all'));
  const [bottleScope, setBottleScope] = useState('active');
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [scopeOpen, setScopeOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const queryRef = useRef(0);

  const byKey = useMemo(() => new Map(catalogue.map((f) => [f.key, f])), [catalogue]);
  const domains = useMemo(() => {
    const order = ['wine', 'inventory', 'purchase', 'rating', 'consumption', 'open', 'maturity', 'personal', 'registry'];
    const grouped = new Map();
    for (const f of catalogue) {
      if (!grouped.has(f.domain)) grouped.set(f.domain, []);
      grouped.get(f.domain).push(f);
    }
    return [...grouped.entries()].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
  }, [catalogue]);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const [catRes, celRes] = await Promise.all([getAnalyticsCatalogue(apiFetch), listCellars(apiFetch)]);
        if (!live) return;
        if (catRes.ok) setCatalogue((await catRes.json()).fields || []);
        if (celRes.ok) {
          const body = await celRes.json();
          setCellars(Array.isArray(body) ? body : body.cellars || []);
        }
      } catch { /* the query error path reports */ }
    })();
    return () => { live = false; };
  }, [apiFetch]);

  const query = useMemo(() => ({
    scope: { cellars: scopeCellars, bottles: bottleScope },
    columns,
    filters: filters.length ? filters : undefined,
    sort: sort || undefined,
    limit: PAGE_SIZE,
    offset,
  }), [scopeCellars, bottleScope, columns, filters, sort, offset]);

  useEffect(() => {
    let live = true;
    const seq = ++queryRef.current;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const res = await runAnalyticsQuery(apiFetch, query);
        if (!live || seq !== queryRef.current) return;
        const body = await res.json();
        if (!res.ok) { setError(body.error || 'Query failed'); setData(null); }
        else setData(body);
      } catch {
        if (live && seq === queryRef.current) setError(t('analytics.networkError', 'Could not reach the server'));
      } finally {
        if (live && seq === queryRef.current) setLoading(false);
      }
    })();
    return () => { live = false; };
  }, [apiFetch, query, t]);

  const toggleColumn = (key) => {
    setColumns((prev) => {
      const next = prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key];
      if (!next.length) return prev; // never zero columns
      try { localStorage.setItem('cellarion_analytics_columns', JSON.stringify(next)); } catch {}
      return next;
    });
    setOffset(0);
  };

  const headerSort = (field) => {
    if (!field.sortable) return;
    setSort((prev) => {
      if (prev && prev.field === field.key) {
        return prev.dir === 'asc' ? { field: field.key, dir: 'desc' } : null;
      }
      return { field: field.key, dir: 'asc' };
    });
    setOffset(0);
  };

  const addDraftFilter = () => {
    const first = catalogue.find((f) => f.filterable);
    if (!first) return;
    setDraftFilters((prev) => [...prev, { field: first.key, op: first.ops[0], value: '' }]);
  };
  const applyFilters = () => {
    const ready = draftFilters.filter((f) => f.value !== '' && f.value !== undefined && f.value !== null
      && !(Array.isArray(f.value) && (!f.value.length || f.value.some((v) => v === ''))));
    setFilters(ready);
    setOffset(0);
  };
  const clearFilters = () => { setDraftFilters([]); setFilters([]); setOffset(0); };

  const exportCsv = useCallback(async () => {
    setExporting(true);
    try {
      const rows = [];
      let at = 0;
      let total = Infinity;
      while (at < Math.min(total, CSV_MAX_ROWS)) {
        const res = await runAnalyticsQuery(apiFetch, { ...query, limit: 200, offset: at });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || 'export failed');
        total = body.total;
        rows.push(...body.rows);
        if (!body.rows.length) break;
        at += body.rows.length;
      }
      const header = columns.map((k) => csvEscape(byKey.get(k)?.label || k)).join(',');
      const lines = rows.map((r) => columns.map((k) => {
        const v = r.values[k];
        return csvEscape(Array.isArray(v) ? v.join('; ') : v ?? '');
      }).join(','));
      const truncated = total > CSV_MAX_ROWS ? `\n"— truncated at ${CSV_MAX_ROWS} of ${total} rows"` : '';
      // UTF-8 BOM so Excel opens Swedish/French characters correctly.
      downloadBlob('﻿' + header + '\n' + lines.join('\n') + truncated, 'cellarion-analytics.csv', 'text/csv;charset=utf-8');
    } catch {
      setError(t('analytics.exportFailed', 'Export failed — try again'));
    } finally {
      setExporting(false);
    }
  }, [apiFetch, query, columns, byKey, t]);

  const scopeNames = data?.scope?.cellars?.map((c) => c.name) || [];
  const shownColumns = columns.filter((k) => byKey.has(k));

  return (
    <div className="analytics-table">
      {/* Scope pill + toolbar — the scope is ALWAYS visible */}
      <div className="at-toolbar">
        <div className="at-scope">
          <button className="at-chip" onClick={() => setScopeOpen((o) => !o)} aria-expanded={scopeOpen}>
            {t(`analytics.scope.${bottleScope}`, bottleScope === 'active' ? 'Active bottles' : bottleScope === 'consumed' ? 'Consumed bottles' : 'All bottles')}
            {' · '}
            {scopeNames.length ? scopeNames.join(', ') : t('analytics.scope.allCellars', 'All cellars')}
          </button>
          {scopeOpen && (
            <div className="at-popover">
              <div className="at-popover-section">
                <strong>{t('analytics.scope.bottlesTitle', 'Bottles')}</strong>
                {['active', 'consumed', 'all'].map((s) => (
                  <label key={s}>
                    <input type="radio" name="at-bottle-scope" checked={bottleScope === s} onChange={() => { setBottleScope(s); setOffset(0); }} />
                    {t(`analytics.scope.${s}`, s)}
                  </label>
                ))}
              </div>
              <div className="at-popover-section">
                <strong>{t('analytics.scope.cellarsTitle', 'Cellars')}</strong>
                <label>
                  <input
                    type="checkbox"
                    checked={scopeCellars === 'all'}
                    onChange={() => { setScopeCellars('all'); setOffset(0); }}
                  />
                  {t('analytics.scope.allCellars', 'All cellars')}
                </label>
                {cellars.map((c) => {
                  const list = scopeCellars === 'all' ? [] : scopeCellars;
                  const on = list.includes(c._id);
                  return (
                    <label key={c._id}>
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() => {
                          const next = on ? list.filter((x) => x !== c._id) : [...list, c._id];
                          setScopeCellars(next.length ? next : 'all');
                          setOffset(0);
                        }}
                      />
                      {c.name}
                    </label>
                  );
                })}
              </div>
            </div>
          )}
        </div>
        <div className="at-actions">
          <button className="at-chip" onClick={() => setPickerOpen((o) => !o)} aria-expanded={pickerOpen}>
            {t('analytics.columns', 'Columns')} ({shownColumns.length})
          </button>
          <button className="at-chip" onClick={exportCsv} disabled={exporting || !data}>
            {exporting ? t('analytics.exporting', 'Exporting…') : t('analytics.exportCsv', 'Export CSV')}
          </button>
        </div>
      </div>

      {pickerOpen && (
        <div className="at-picker">
          {domains.map(([domain, fields]) => (
            <div key={domain} className="at-picker-domain">
              <strong>{t(`analytics.domain.${domain}`, domain)}</strong>
              {fields.map((f) => (
                <label key={f.key} title={f.type + (f.unit ? ` · ${f.unit}` : '')}>
                  <input type="checkbox" checked={columns.includes(f.key)} onChange={() => toggleColumn(f.key)} />
                  {f.label}
                </label>
              ))}
            </div>
          ))}
        </div>
      )}

      {/* Filter builder */}
      <div className="at-filters">
        {draftFilters.map((f, i) => {
          const field = byKey.get(f.field);
          if (!field) return null;
          return (
            <div key={i} className="at-filter-row">
              <select
                value={f.field}
                onChange={(e) => {
                  const nf = byKey.get(e.target.value);
                  setDraftFilters((prev) => prev.map((x, j) => (j === i ? { field: nf.key, op: nf.ops[0], value: '' } : x)));
                }}
              >
                {catalogue.filter((c) => c.filterable).map((c) => (
                  <option key={c.key} value={c.key}>{c.label}</option>
                ))}
              </select>
              <select
                value={f.op}
                onChange={(e) => setDraftFilters((prev) => prev.map((x, j) => (j === i ? { ...x, op: e.target.value, value: '' } : x)))}
              >
                {field.ops.map((op) => <option key={op} value={op}>{OP_LABELS[op] || op}</option>)}
              </select>
              <FilterValueInput
                field={field}
                op={f.op}
                value={f.value}
                onChange={(v) => setDraftFilters((prev) => prev.map((x, j) => (j === i ? { ...x, value: v } : x)))}
              />
              <button className="at-x" onClick={() => setDraftFilters((prev) => prev.filter((_, j) => j !== i))} aria-label={t('analytics.removeFilter', 'Remove filter')}>×</button>
            </div>
          );
        })}
        <div className="at-filter-actions">
          <button className="at-chip" onClick={addDraftFilter}>{t('analytics.addFilter', '+ Filter')}</button>
          {draftFilters.length > 0 && (
            <>
              <button className="at-chip at-apply" onClick={applyFilters}>{t('analytics.apply', 'Apply')}</button>
              <button className="at-chip" onClick={clearFilters}>{t('analytics.clear', 'Clear')}</button>
            </>
          )}
          {filters.length > 0 && draftFilters.length === 0 && (
            <button className="at-chip" onClick={clearFilters}>{t('analytics.clearApplied', 'Clear filters')}</button>
          )}
        </div>
      </div>

      {error && <div className="at-error">{error}</div>}

      <div className="at-scroll">
        <table>
          <thead>
            <tr>
              {shownColumns.map((k) => {
                const f = byKey.get(k);
                const sorted = sort && sort.field === k;
                return (
                  <th
                    key={k}
                    className={f.sortable ? 'at-sortable' : ''}
                    onClick={() => headerSort(f)}
                    title={f.sortable ? t('analytics.sortHint', 'Click to sort') : t('analytics.notSortable', 'Not sortable yet')}
                  >
                    {f.label}{f.unit && f.unit !== 'currency' ? ` (${f.unit})` : ''}
                    {sorted ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {(data?.rows || []).map((r) => (
              <tr key={r.id}>
                {shownColumns.map((k) => (
                  <td key={k} data-label={byKey.get(k)?.label}>{formatValue(r.values[k], byKey.get(k))}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {loading && <div className="at-loading">{t('analytics.loading', 'Loading…')}</div>}
        {!loading && data && !data.rows.length && (
          <div className="at-empty">{t('analytics.empty', 'No bottles match this scope and these filters.')}</div>
        )}
      </div>

      {data && (
        <div className="at-pager">
          <button className="at-chip" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
            {t('analytics.prev', '‹ Previous')}
          </button>
          <span>
            {t('analytics.pageInfo', '{{from}}–{{to}} of {{total}}', {
              from: data.total === 0 ? 0 : offset + 1,
              to: offset + (data.rows?.length || 0),
              total: data.total,
            })}
          </span>
          <button className="at-chip" disabled={offset + PAGE_SIZE >= data.total} onClick={() => setOffset(offset + PAGE_SIZE)}>
            {t('analytics.next', 'Next ›')}
          </button>
        </div>
      )}
    </div>
  );
}
