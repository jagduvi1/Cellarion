// What a rack slot's popup shows, by what is in the slot: a free slot lists
// the cellar's unplaced bottles to place, a position marked unusable offers
// to bring it back, and a slot with a bottle shows the bottle and what can be
// done with it. The racks page (pages/CellarRacks.js) owns the dialog around
// them and what each action does; the free slot's picker loads its own list.

import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { getCellar } from '../../api/cellars';
import { glassesLeft, daysLeft, freshnessStatus, remainingMl } from '../../utils/openBottle';
import WineImage from '../WineImage';
import { swatchType, wineTypeLabel } from '../../utils/wineColour';
import { formatVintage } from '../../utils/vintage';

// ---- Content for empty slot: pick a bottle to place ----
/** Group unplaced bottles by wine + vintage so a case shows as one row ×N. */
function groupBottles(bottles) {
  const map = new Map();
  for (const b of bottles) {
    const key = `${b.wineDefinition?._id || b._id}:${b.vintage || ''}`;
    if (!map.has(key)) map.set(key, { key, sample: b, bottles: [] });
    map.get(key).bottles.push(b);
  }
  return [...map.values()];
}

export function EmptySlotContent({ position, zone, apiFetch, cellarId, canEdit, onAssign, onAssignMany, freeRun, onDisable, onClose }) {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(true);
  // A failed load shows a retry, not "no unplaced bottles".
  const [loadFailed, setLoadFailed] = useState(false);
  // Case placement: the group being quantity-picked, chosen quantity, busy flag
  const [caseGroup, setCaseGroup] = useState(null);
  const [caseQty, setCaseQty] = useState(2);
  const [placing, setPlacing] = useState(false);
  const timerRef = useRef(null);
  // Only the latest request may fill the list: an older search can answer last.
  const seqRef = useRef(0);
  // Retry gives way to the loading line; focus goes here, not to the page.
  const searchRef = useRef(null);

  // Fetch bottles from backend, excluding already-placed bottles server-side
  const fetchBottles = useCallback(async (term) => {
    const seq = ++seqRef.current;
    setLoading(true);
    setLoadFailed(false);
    try {
      const params = new URLSearchParams({ limit: '30' });
      if (term) params.set('search', term);
      // The backend excludes rack-placed bottles itself — sending every placed
      // bottle ID in the query string overflows the URL limit on big cellars.
      params.set('excludePlaced', '1');
      const res = await getCellar(apiFetch, cellarId, params.toString());
      const data = await res.json();
      if (seq !== seqRef.current) return;
      if (res.ok) setResults(data.bottles?.items || []);
      else setLoadFailed(true);
    } catch {
      if (seq !== seqRef.current) return;
      setLoadFailed(true);
    }
    setLoading(false);
  }, [apiFetch, cellarId]);

  // Load initial results on mount
  useEffect(() => { fetchBottles(''); }, [fetchBottles]);

  // Debounced search (300ms)
  const handleSearch = (value) => {
    setSearch(value);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => fetchBottles(value), 300);
  };

  // Cleanup timer on unmount
  useEffect(() => () => clearTimeout(timerRef.current), []);

  return (
    <>
      <div className="slot-popup-header">
        <span className="slot-popup-title" id="slot-popup-heading">
          {t('racks.slotPlaceBottle', { position })}
          {zone && (
            <span className="slot-zone-chip">
              <span className="rack-zone-dot" style={{ background: zone.color || '#888' }} />
              {zone.name}
            </span>
          )}
        </span>
        <button className="slot-popup-close" onClick={onClose} aria-label="Close">&times;</button>
      </div>
      <input
        ref={searchRef}
        type="text"
        className="slot-search"
        placeholder={t('racks.searchWines')}
        value={search}
        onChange={e => handleSearch(e.target.value)}
        aria-label={t('racks.searchWines')}
        autoFocus
      />
      {caseGroup ? (
        /* Quantity picker: place several bottles of the same wine into the
           free slots starting at this position. */
        <div className="slot-case-panel">
          <p className="slot-case-title">
            <strong>{caseGroup.sample.wineDefinition?.name || t('common.unknown')}</strong>
            {caseGroup.sample.vintage ? ` (${formatVintage(caseGroup.sample.vintage, t)})` : ''}
          </p>
          <p className="slot-case-hint">
            {t('racks.caseHint', 'Fills the free slots from here onward, in position order.')}
          </p>
          <div className="slot-case-qty">
            <button
              type="button"
              className="btn btn-secondary btn-small"
              onClick={() => setCaseQty(q => Math.max(2, q - 1))}
              disabled={placing || caseQty <= 2}
              aria-label="−"
            >
              −
            </button>
            <span className="slot-case-count">{caseQty}</span>
            <button
              type="button"
              className="btn btn-secondary btn-small"
              onClick={() => setCaseQty(q => Math.min(caseGroup.max, q + 1))}
              disabled={placing || caseQty >= caseGroup.max}
              aria-label="+"
            >
              +
            </button>
            <span className="slot-case-max">{t('racks.caseMax', 'max {{max}}', { max: caseGroup.max })}</span>
          </div>
          <div className="slot-popup-actions">
            <button className="btn btn-secondary btn-small" onClick={() => setCaseGroup(null)} disabled={placing}>
              {t('common.cancel')}
            </button>
            <button
              className="btn btn-primary btn-small"
              disabled={placing}
              onClick={async () => {
                setPlacing(true);
                // The parent closes the popup once every bottle is placed.
                await onAssignMany(caseGroup.bottles.slice(0, caseQty).map(b => b._id));
              }}
            >
              {placing
                ? t('racks.casePlacing', 'Placing…')
                : t('racks.casePlaceBtn', 'Place {{count}} bottles', { count: caseQty })}
            </button>
          </div>
        </div>
      ) : (
      <div className="slot-bottle-list">
        {loading ? (
          <p className="slot-empty-msg">…</p>
        ) : loadFailed ? (
          <p className="slot-empty-msg">
            <span role="alert">{t('racks.unplacedLoadFailed', "Couldn't load your bottles.")}</span>{' '}
            <button type="button" className="btn btn-secondary btn-small" onClick={() => { searchRef.current?.focus(); fetchBottles(search); }}>
              {t('common.retry', 'Retry')}
            </button>
          </p>
        ) : results.length === 0 ? (
          <p className="slot-empty-msg">{t('racks.noUnplacedBottles')}</p>
        ) : (
          groupBottles(results).map(g => (
            <div
              key={g.key}
              className="slot-bottle-item"
              onClick={() => onAssign(position, g.bottles[0]._id)}
              onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onAssign(position, g.bottles[0]._id)}
              role="button"
              tabIndex={0}
            >
              <span className={`slot-bottle-type-dot type-${swatchType(g.sample.wineDefinition, 'red')}`} aria-hidden="true" />
              <div className="slot-bottle-info">
                <strong>
                  {g.sample.wineDefinition?.name || t('common.unknown')}
                  {g.bottles.length > 1 && <span className="slot-case-badge">×{g.bottles.length}</span>}
                </strong>
                <span className="slot-bottle-meta">
                  {g.sample.wineDefinition?.producer} &middot; {formatVintage(g.sample.vintage, t)}
                  {g.sample.wineDefinition?.country?.name ? ` \u00B7 ${g.sample.wineDefinition.country.name}` : ''}
                </span>
              </div>
              {onAssignMany && g.bottles.length > 1 && Math.min(g.bottles.length, freeRun || 0) > 1 && (
                <button
                  type="button"
                  className="btn btn-secondary btn-small slot-case-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    const max = Math.min(g.bottles.length, freeRun);
                    setCaseGroup({ ...g, max });
                    setCaseQty(Math.min(g.bottles.length, max));
                  }}
                >
                  {t('racks.caseOpenBtn', 'Place several\u2026')}
                </button>
              )}
            </div>
          ))
        )}
      </div>
      )}
      {canEdit && onDisable && (
        <div className="slot-popup-actions">
          <button className="btn btn-secondary btn-small" onClick={onDisable}>
            {t('racks.disableSlot')}
          </button>
        </div>
      )}
    </>
  );
}

// ---- Content for a disabled (unusable) slot ----
export function DisabledSlotContent({ position, canEdit, onEnable, onClose }) {
  const { t } = useTranslation();
  return (
    <>
      <div className="slot-popup-header">
        <span className="slot-popup-title" id="slot-popup-heading">{t('racks.disabledSlotTitle', { position })}</span>
        <button className="slot-popup-close" onClick={onClose} aria-label="Close">&times;</button>
      </div>
      <p className="slot-disabled-note">{t('racks.disabledSlotNote')}</p>
      {canEdit && (
        <div className="slot-popup-actions">
          <button className="btn btn-secondary btn-small" onClick={onEnable}>
            {t('racks.enableSlot')}
          </button>
        </div>
      )}
    </>
  );
}

// ---- Content for filled slot: show bottle info + actions ----
export function FilledSlotContent({ position, slot, zone, canEdit, onRemoveFromRack, onMove, onConsume, onPour, onClose }) {
  const { t } = useTranslation();
  const bottle = slot.bottle;
  const wine = bottle?.wineDefinition;

  return (
    <>
      <div className="slot-popup-header">
        <span className="slot-popup-title" id="slot-popup-heading">
          {t('racks.slotTitle', { position })}
          {zone && (
            <span className="slot-zone-chip">
              <span className="rack-zone-dot" style={{ background: zone.color || '#888' }} />
              {zone.name}
            </span>
          )}
        </span>
        <button className="slot-popup-close" onClick={onClose} aria-label="Close">&times;</button>
      </div>

      <div className="slot-bottle-detail">
        <WineImage image={wine?.image} alt={wine?.name} className="slot-detail-img" />
        <div className="slot-detail-info">
          <h4>{wine?.name || t('common.unknown')}</h4>
          {wine?.producer && <p className="slot-detail-producer">{wine.producer}</p>}
          <p className="slot-detail-meta">
            <span className={`slot-bottle-type-dot type-${swatchType(wine, 'red')}`} />
            {wineTypeLabel(wine, t)} &middot; {formatVintage(bottle?.vintage, t)}
          </p>
          {wine?.country?.name && (
            <p className="slot-detail-meta">
              {wine.country.name}{wine?.region?.name ? `, ${wine.region.name}` : ''}
            </p>
          )}
          {bottle?.notes && <p className="slot-detail-notes">{bottle.notes}</p>}
          {bottle?.openedAt && (
            <p className={`slot-open-info slot-open-info--${freshnessStatus(bottle) || 'ok'}`}>
              🍷 {t('racks.openInfo', 'Open — ≈ {{glasses}} glasses left · drink within {{days}}d', {
                glasses: glassesLeft(bottle),
                days: Math.max(0, daysLeft(bottle) ?? 0),
              })}
            </p>
          )}
        </div>
      </div>

      {canEdit && (
        <div className="slot-popup-actions">
          {bottle?.openedAt && onPour && (
            <button className="btn btn-primary btn-small" onClick={onPour} disabled={remainingMl(bottle) <= 0}>
              {t('racks.pourGlass', 'Pour a glass')}
            </button>
          )}
          {/* Then a tap on the slot it should go to — dragging is mouse/pen only */}
          {onMove && (
            <button className="btn btn-secondary btn-small" onClick={onMove}>
              {t('racks.moveMode.button', 'Move')}
            </button>
          )}
          <button className="btn btn-secondary btn-small" onClick={onRemoveFromRack}>
            {t('racks.removeFromRack')}
          </button>
          <button className="btn btn-consume btn-small" onClick={onConsume}>
            {t('racks.remove')}
          </button>
        </div>
      )}
    </>
  );
}
