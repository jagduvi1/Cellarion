import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from './Modal';
import './BottleFilterModal.css';

const COLLAPSED_LIMIT = 8;

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

function BottleFilterModal({ filters, onApply, onClose, facets, baseFacets, facetMeta, bottlesTotal }) {
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
      type: [], country: [], region: [], grapes: [], vintage: [],
      minRating: '', maturity: ''
    });
  };

  const activeCount = (filters.type?.length || 0) + (filters.country?.length || 0) +
    (filters.region?.length || 0) + (filters.grapes?.length || 0) +
    (filters.vintage?.length || 0) + (filters.minRating ? 1 : 0) + (filters.maturity ? 1 : 0);

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

        {/* Rating + Maturity — side by side */}
        <div className="bfm-dropdowns-row">
          <div className="bfm-dropdown-group">
            <label className="bfm-dropdown-label">{t('cellarDetail.allRatings')}</label>
            <select
              value={filters.minRating}
              onChange={e => onApply({ ...filters, minRating: e.target.value })}
              className="bfm-select"
            >
              <option value="">{t('cellarDetail.allRatings')}</option>
              <option value="80">{t('cellarDetail.stars4Plus')}</option>
              <option value="60">{t('cellarDetail.stars3Plus')}</option>
              <option value="40">{t('cellarDetail.stars2Plus')}</option>
            </select>
          </div>
          <div className="bfm-dropdown-group">
            <label className="bfm-dropdown-label">{t('cellarDetail.allMaturity')}</label>
            <select
              value={filters.maturity}
              onChange={e => onApply({ ...filters, maturity: e.target.value })}
              className="bfm-select"
            >
              <option value="">{t('cellarDetail.allMaturity')}</option>
              <option value="peak">{t('maturity.peak')}</option>
              <option value="early">{t('maturity.early')}</option>
              <option value="late">{t('maturity.late')}</option>
              <option value="declining">{t('maturity.declining')}</option>
              <option value="not-ready">{t('maturity.notReady')}</option>
              <option value="none">{t('maturity.noData')}</option>
            </select>
          </div>
        </div>
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
