import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from './Modal';
import { SCALE_META, toNormalized, fromNormalized } from '../utils/ratingUtils';
import {
  MATURITY_FILTER_OPTIONS, NEEDS_ATTENTION, MATURITY_I18N_KEY, MATURITY_STATS_KEY, toMaturityArray,
} from '../utils/filterLabels';
import './BottleFilterModal.css';

const COLLAPSED_LIMIT = 8;

// Rating bounds live in the filter state as NORMALISED 0–100 strings (the wire
// format every list endpoint speaks), but the person types in their own scale
// — 3.8★, 16.5/20, 91pts — at the scale's own precision (support ticket
// 2026-09-12: ratings are stored to one decimal, the old 2+/3+/4+ dropdown
// rounded to whole stars). Text is local until blur/Enter so a half-typed
// "3." is never round-tripped through the conversion mid-keystroke.
function RatingRangeInputs({ minNorm, maxNorm, scale, onChange }) {
  const { t } = useTranslation();
  const meta = SCALE_META[scale] || SCALE_META['5'];
  const toScaleText = (n) => (n === '' || n == null || isNaN(Number(n)) ? '' : String(fromNormalized(Number(n), scale)));
  const [minText, setMinText] = useState(() => toScaleText(minNorm));
  const [maxText, setMaxText] = useState(() => toScaleText(maxNorm));
  // Re-sync when a bound changes from outside (chip removed, "clear all").
  useEffect(() => { setMinText(toScaleText(minNorm)); }, [minNorm]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setMaxText(toScaleText(maxNorm)); }, [maxNorm]); // eslint-disable-line react-hooks/exhaustive-deps

  const commit = (which, text) => {
    const trimmed = String(text).trim();
    if (trimmed === '') return onChange(which, '');
    const v = Number(trimmed);
    if (isNaN(v)) return onChange(which, '');
    const clamped = Math.min(meta.max, Math.max(meta.min, v));
    const norm = toNormalized(clamped, scale);
    onChange(which, String(Math.round(norm * 100) / 100));
  };
  const onKey = (which, text) => (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(which, text); } };

  return (
    <>
      <div className="bfm-rating-row">
        <div className="bfm-dropdown-group">
          <label className="bfm-dropdown-label" htmlFor="bfm-rating-min">{t('cellarDetail.ratingFrom', 'From')}</label>
          <div className="bfm-rating-input">
            <input
              id="bfm-rating-min"
              className="bfm-select"
              type="number"
              inputMode="decimal"
              min={meta.min}
              max={meta.max}
              step={meta.step}
              value={minText}
              onChange={e => setMinText(e.target.value)}
              onBlur={() => commit('minRating', minText)}
              onKeyDown={onKey('minRating', minText)}
            />
            <span className="bfm-rating-suffix">{meta.suffix}</span>
          </div>
        </div>
        <div className="bfm-dropdown-group">
          <label className="bfm-dropdown-label" htmlFor="bfm-rating-max">{t('cellarDetail.ratingTo', 'To')}</label>
          <div className="bfm-rating-input">
            <input
              id="bfm-rating-max"
              className="bfm-select"
              type="number"
              inputMode="decimal"
              min={meta.min}
              max={meta.max}
              step={meta.step}
              value={maxText}
              onChange={e => setMaxText(e.target.value)}
              onBlur={() => commit('maxRating', maxText)}
              onKeyDown={onKey('maxRating', maxText)}
            />
            <span className="bfm-rating-suffix">{meta.suffix}</span>
          </div>
        </div>
      </div>
      <div className="bfm-hint">{t('cellarDetail.ratingRangeHint', 'Leave a field empty for no bound')}</div>
    </>
  );
}

function FilterPill({ label, count, selected, dimmed, onClick }) {
  return (
    <button
      type="button"
      className={`filter-pill${selected ? ' filter-pill--selected' : ''}${dimmed ? ' filter-pill--dimmed' : ''}`}
      onClick={onClick}
    >
      {label}
      {count != null && <span className="filter-pill-count">{count}</span>}
    </button>
  );
}

function FilterSection({ label, icon, children, defaultExpanded = true }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [showAll, setShowAll] = useState(false);

  const items = Array.isArray(children) ? children.filter(Boolean) : [children];
  const needsCollapse = items.length > COLLAPSED_LIMIT;
  const visible = expanded ? (showAll ? items : items.slice(0, COLLAPSED_LIMIT)) : [];

  return (
    <div className="bfm-section">
      <button
        type="button"
        className="bfm-section-header"
        onClick={() => setExpanded(e => !e)}
      >
        {icon && <span className="bfm-section-icon">{icon}</span>}
        <span className="bfm-section-label">{label}</span>
        <svg
          className={`bfm-section-chevron${expanded ? ' bfm-section-chevron--open' : ''}`}
          width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {expanded && (
        <>
          <div className="bfm-pills">{visible}</div>
          {needsCollapse && !showAll && (
            <button type="button" className="bfm-show-more" onClick={() => setShowAll(true)}>
              {t('cellarDetail.showMore', { count: items.length - COLLAPSED_LIMIT })}
            </button>
          )}
          {needsCollapse && showAll && (
            <button type="button" className="bfm-show-more" onClick={() => setShowAll(false)}>
              {t('cellarDetail.showLess')}
            </button>
          )}
        </>
      )}
    </div>
  );
}

// showRatingMaturity: pages whose backend endpoint doesn't support the
// rating/maturity filters (e.g. consumed history) hide those controls —
// rendering them would silently do nothing.
// showUnplaced: only the single-cellar active list supports the unplaced
// filter (placement is per-cellar; consumed bottles hold no rack slot), and
// only when the cellar actually has racks.
// showReserved: only the single-cellar active endpoint supports ?reserved=1
// (reserved bottles are active by definition — consumed ones lose relevance).
// storage: the cellar's racks as [{ id, name, group }] — renders the "Stored
// in" section (a rack group or one rack). null/empty hides it; the filter is
// applied server-side after search like Placement, so no facet counts.
// ratingScale: the user's rating scale ('5' | '20' | '100') — the rating range
// is typed in that scale and stored normalised.
// maturityCounts: the cellar statistics' maturity buckets ({ peak, early,
// late, declining, notReady, noProfile }) — rendered beside each maturity
// pill so "Late (4) / Declining (0)" answers the question before the filter
// is applied. null hides the counts (cross-cellar scope has no single stats).
function BottleFilterModal({ filters, onApply, onClose, facets, baseFacets, facetMeta, bottlesTotal, showRatingMaturity = true, showUnplaced = false, showReserved = false, storage = null, ratingScale = '5', maturityCounts = null }) {
  const { t } = useTranslation();

  // baseFacets = all options in the cellar (unfiltered) — used to LIST available pills
  // facets = filtered counts — used to show how many match the current filter combination
  const allFacets = baseFacets || facets;

  const toggle = (key, value) => {
    const current = filters[key] || [];
    const next = current.includes(value)
      ? current.filter(v => v !== value)
      : [...current, value];
    onApply({ ...filters, [key]: next });
  };

  const clearAll = () => {
    onApply({
      ...filters,
      type: [], country: [], region: [], appellation: [], grapes: [], vintage: [],
      minRating: '', maxRating: '', maturity: [], unplaced: '', reserved: '', storage: ''
    });
  };

  const maturitySelected = toMaturityArray(filters.maturity);
  const activeCount = (filters.type?.length || 0) + (filters.country?.length || 0) +
    (filters.region?.length || 0) + (filters.appellation?.length || 0) + (filters.grapes?.length || 0) +
    (filters.vintage?.length || 0) + (filters.minRating || filters.maxRating ? 1 : 0) + (maturitySelected.length ? 1 : 0) +
    (filters.unplaced ? 1 : 0) + (filters.reserved ? 1 : 0) + (filters.storage ? 1 : 0);

  // For a given facet key, decide which counts to use:
  // - If THIS category has active selections, use baseFacets (so you can still add more)
  // - Otherwise use filtered facets (cascading from other categories)
  const countsFor = (facetKey, filterKey) => {
    const hasSelection = Array.isArray(filters[filterKey]) ? filters[filterKey].length > 0 : !!filters[filterKey];
    return hasSelection ? (allFacets?.[facetKey] || {}) : (facets?.[facetKey] || {});
  };

  return (
    <Modal title={t('cellarDetail.filterModalTitle')} onClose={onClose} wide showClose>
      <div className="bfm-content">
        {/* Wine Type */}
        {allFacets?.type && Object.keys(allFacets.type).length > 0 && (() => {
          const counts = countsFor('type', 'type');
          return (
            <FilterSection label={t('cellarDetail.wineType')} icon="🍷">
              {Object.entries(allFacets.type)
                .sort(([, a], [, b]) => b - a)
                .map(([typeName]) => {
                  const count = counts[typeName] || 0;
                  const selected = filters.type?.includes(typeName);
                  return (
                    <FilterPill
                      key={typeName}
                      label={typeName.charAt(0).toUpperCase() + typeName.slice(1)}
                      count={count || null}
                      selected={selected}
                      dimmed={!selected && count === 0}
                      onClick={() => toggle('type', typeName)}
                    />
                  );
                })}
            </FilterSection>
          );
        })()}

        {/* Country */}
        {allFacets?.countryName && facetMeta?.countries && Object.keys(allFacets.countryName).length > 0 && (() => {
          const counts = countsFor('countryName', 'country');
          return (
            <FilterSection label={t('cellarDetail.countryLabel')} icon="🌍">
              {Object.entries(allFacets.countryName)
                .sort(([, a], [, b]) => b - a)
                .map(([name]) => {
                  const id = facetMeta.countries[name];
                  const count = counts[name] || 0;
                  const selected = filters.country?.includes(id);
                  return id ? (
                    <FilterPill
                      key={id}
                      label={name}
                      count={count || null}
                      selected={selected}
                      dimmed={!selected && count === 0}
                      onClick={() => toggle('country', id)}
                    />
                  ) : null;
                })}
            </FilterSection>
          );
        })()}

        {/* Region */}
        {allFacets?.regionName && facetMeta?.regions && Object.keys(allFacets.regionName).length > 0 && (() => {
          const counts = countsFor('regionName', 'region');
          return (
            <FilterSection label={t('cellarDetail.regionLabel')} icon="📍" defaultExpanded={false}>
              {Object.entries(allFacets.regionName)
                .sort(([, a], [, b]) => b - a)
                .map(([name]) => {
                  const id = facetMeta.regions[name];
                  const count = counts[name] || 0;
                  const selected = filters.region?.includes(id);
                  return id ? (
                    <FilterPill
                      key={id}
                      label={name}
                      count={count || null}
                      selected={selected}
                      dimmed={!selected && count === 0}
                      onClick={() => toggle('region', id)}
                    />
                  ) : null;
                })}
            </FilterSection>
          );
        })()}

        {/* Appellation — facet keys are the appellation strings themselves (no
            ID map). Bottles with no appellation index as "" — drop that key so
            it doesn't render an empty, meaningless pill. */}
        {(() => {
          const entries = Object.entries(allFacets?.appellation || {}).filter(([name]) => name !== '');
          if (entries.length === 0) return null;
          const counts = countsFor('appellation', 'appellation');
          return (
            <FilterSection label={t('cellarDetail.appellationLabel', 'Appellation')} icon="🏷️" defaultExpanded={false}>
              {entries
                .sort(([, a], [, b]) => b - a)
                .map(([name]) => {
                  const count = counts[name] || 0;
                  const selected = filters.appellation?.includes(name);
                  return (
                    <FilterPill
                      key={name}
                      label={name}
                      count={count || null}
                      selected={selected}
                      dimmed={!selected && count === 0}
                      onClick={() => toggle('appellation', name)}
                    />
                  );
                })}
            </FilterSection>
          );
        })()}

        {/* Grapes */}
        {facetMeta?.grapes && Object.keys(facetMeta.grapes).length > 0 && (() => {
          const counts = countsFor('grapeIds', 'grapes');
          return (
            <FilterSection label={t('cellarDetail.grapeLabel')} icon="🍇" defaultExpanded={false}>
              {Object.entries(facetMeta.grapes)
                .sort(([a], [b]) => {
                  const ca = allFacets?.grapeIds?.[facetMeta.grapes[a]] || 0;
                  const cb = allFacets?.grapeIds?.[facetMeta.grapes[b]] || 0;
                  return cb - ca;
                })
                .map(([name, grapeId]) => {
                  const count = counts[grapeId] || 0;
                  const selected = filters.grapes?.includes(grapeId);
                  return (
                    <FilterPill
                      key={grapeId}
                      label={name}
                      count={count || null}
                      selected={selected}
                      dimmed={!selected && count === 0}
                      onClick={() => toggle('grapes', grapeId)}
                    />
                  );
                })}
            </FilterSection>
          );
        })()}

        {/* Vintage */}
        {allFacets?.vintage && Object.keys(allFacets.vintage).length > 0 && (() => {
          const counts = countsFor('vintage', 'vintage');
          return (
            <FilterSection label={t('cellarDetail.vintageLabel')} icon="📅">
              {Object.entries(allFacets.vintage)
                .sort(([a], [b]) => b.localeCompare(a))
                .map(([year]) => {
                  const count = counts[year] || 0;
                  const selected = filters.vintage?.includes(year);
                  return (
                    <FilterPill
                      key={year}
                      label={year}
                      count={count || null}
                      selected={selected}
                      dimmed={!selected && count === 0}
                      onClick={() => toggle('vintage', year)}
                    />
                  );
                })}
            </FilterSection>
          );
        })()}

        {/* Placement — single toggle, no facet count (Meilisearch doesn't know
            rack placement; the filter is applied server-side after search, so
            cascading counts in the other sections won't reflect it). */}
        {showUnplaced && (
          <FilterSection label={t('cellarDetail.placementLabel', 'Placement')} icon="📍">
            <FilterPill
              label={t('cellarDetail.unplacedOnly', 'Unplaced only')}
              selected={!!filters.unplaced}
              // "Unplaced" and "Stored in" contradict each other — picking one
              // releases the other instead of yielding a puzzling empty list.
              onClick={() => onApply({ ...filters, unplaced: filters.unplaced ? '' : '1', ...(filters.unplaced ? {} : { storage: '' }) })}
            />
          </FilterSection>
        )}

        {/* Stored in — a rack group (a room, a fridge) or one rack; single
            choice, server-side after search (support ticket 2026-09-06). */}
        {Array.isArray(storage) && storage.length > 0 && (() => {
          const groups = [...new Set(storage.map(r => r.group).filter(Boolean))];
          const current = filters.storage || '';
          const pick = (v) => onApply({ ...filters, storage: current === v ? '' : v, ...(current === v ? {} : { unplaced: '' }) });
          const pills = [
            ...groups.map(g => (
              <FilterPill key={`group:${g}`} label={g} selected={current === `group:${g}`} onClick={() => pick(`group:${g}`)} />
            )),
            ...storage.map(r => (
              <FilterPill
                key={`rack:${r.id}`}
                label={r.group ? `${r.group} · ${r.name}` : r.name}
                selected={current === `rack:${r.id}`}
                onClick={() => pick(`rack:${r.id}`)}
              />
            )),
          ];
          return (
            <FilterSection label={t('cellarDetail.storedInLabel', 'Stored in')} icon="🗄️">
              {pills}
            </FilterSection>
          );
        })()}

        {/* Reservation — single toggle, applied server-side after search (same
            no-facet-count reasoning as Placement above). */}
        {showReserved && (
          <FilterSection label={t('cellarDetail.reservationLabel', 'Reservation')} icon="🔖">
            <FilterPill
              label={t('cellarDetail.reservedOnly', 'Reserved only')}
              selected={!!filters.reserved}
              onClick={() => onApply({ ...filters, reserved: filters.reserved ? '' : '1' })}
            />
          </FilterSection>
        )}

        {/* Maturity — several buckets at once, OR-combined, plus the one
            combination almost every owner asks for: "needs attention" = Late
            + Declining (support ticket 2026-09-12). Counts come from the
            cellar statistics, not the facets (maturity is computed per row,
            so Meilisearch cannot facet it) — they describe the whole cellar,
            not the current filter combination, and a zero still shows so an
            empty bucket reads as "0", not as missing. */}
        {showRatingMaturity && (() => {
          const countFor = (v) => (maturityCounts ? (maturityCounts[MATURITY_STATS_KEY[v]] ?? 0) : null);
          const toggleMaturity = (v) => {
            const next = maturitySelected.includes(v) ? maturitySelected.filter(x => x !== v) : [...maturitySelected, v];
            onApply({ ...filters, maturity: next });
          };
          const attentionOn = NEEDS_ATTENTION.every(v => maturitySelected.includes(v));
          const toggleAttention = () => {
            const next = attentionOn
              ? maturitySelected.filter(v => !NEEDS_ATTENTION.includes(v))
              : [...new Set([...maturitySelected, ...NEEDS_ATTENTION])];
            onApply({ ...filters, maturity: next });
          };
          const attentionCount = maturityCounts
            ? NEEDS_ATTENTION.reduce((sum, v) => sum + (maturityCounts[MATURITY_STATS_KEY[v]] || 0), 0)
            : null;
          const pills = [
            <FilterPill
              key="needs-attention"
              label={`${t('cellarDetail.needsAttention', 'Needs attention')} · ${t('cellarDetail.needsAttentionHint', 'Late + Declining')}`}
              count={attentionCount}
              selected={attentionOn}
              onClick={toggleAttention}
            />,
            ...MATURITY_FILTER_OPTIONS.map(v => {
              const count = countFor(v);
              const selected = maturitySelected.includes(v);
              return (
                <FilterPill
                  key={v}
                  label={t(MATURITY_I18N_KEY[v])}
                  count={count}
                  selected={selected}
                  dimmed={!selected && count === 0}
                  onClick={() => toggleMaturity(v)}
                />
              );
            }),
          ];
          return (
            <FilterSection label={t('cellarDetail.maturityLabel', 'Maturity')} icon="⏳">
              {pills}
            </FilterSection>
          );
        })()}

        {/* Rating — a range in the user's own scale, one decimal where the
            scale has one; either bound may be left open. */}
        {showRatingMaturity && (
          <div className="bfm-section">
            <div className="bfm-section-header bfm-section-header--static">
              <span className="bfm-section-icon">⭐</span>
              <span className="bfm-section-label">{t('cellarDetail.ratingLabel', 'Rating')}</span>
            </div>
            <RatingRangeInputs
              minNorm={filters.minRating || ''}
              maxNorm={filters.maxRating || ''}
              scale={ratingScale}
              onChange={(which, value) => onApply({ ...filters, [which]: value })}
            />
          </div>
        )}
      </div>

      <div className="bfm-footer">
        {activeCount > 0 && (
          <button type="button" className="bfm-clear-btn" onClick={clearAll}>
            {t('cellarDetail.clearAllFilters')}
          </button>
        )}
        <button type="button" className="bfm-apply-btn" onClick={onClose}>
          {t('cellarDetail.showBottles', { count: bottlesTotal ?? 0 })}
        </button>
      </div>
    </Modal>
  );
}

export default BottleFilterModal;
