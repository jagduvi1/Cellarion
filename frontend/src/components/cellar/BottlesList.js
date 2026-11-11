import { useState, useEffect, Suspense, Fragment } from 'react';
import { lazy } from '../../utils/lazyWithReload';
import { Link, useNavigate } from 'react-router-dom';
import { useBackHere } from '../../utils/useBackHere';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../contexts/AuthContext';
import BottleCard from '../BottleCard';
import { readBottleViewMode, storeBottleViewMode } from '../../utils/bottleViewMode';
import JournalPrompt, { journalPromptOptedOut } from '../JournalPrompt';
import { useFeature } from '../../utils/featureFlags';
import { bottleNoticeName } from '../BottleUndoNotice';
import { CARD_FIELDS, cardDetails, readCardFields, storeCardFields } from '../../utils/cardDetails';
import { summarizeSelection } from '../../utils/bulkSelection';
import { formatVintage } from '../../utils/vintage';

// Lazy: each dialog is loaded when its action is first used.
const MoveBottleModal = lazy(() => import('../MoveBottleModal'));
const BulkPurchaseModal = lazy(() => import('../BulkPurchaseModal'));
const BulkConsumeModal = lazy(() => import('../BulkConsumeModal'));
const BulkReserveModal = lazy(() => import('../BulkReserveModal'));
const BulkDrinkWindowModal = lazy(() => import('../BulkDrinkWindowModal'));
const BulkAddToListModal = lazy(() => import('../BulkAddToListModal'));
const AddToPickListModal = lazy(() => import('../AddToPickListModal'));
const BulkDeleteModal = lazy(() => import('../BulkDeleteModal'));
const DrinkOneModal = lazy(() => import('../DrinkOneModal'));

// The select-mode bar's actions, in display order. Each opens one modal; all
// of them reuse the single-bottle operations server-side and report skipped
// bottles instead of failing the batch. Delete sits last, set apart: it moves
// the bottles to "Recently deleted" for 30 days behind its own confirm step.
const BULK_ACTIONS = [
  { key: 'move',     icon: '📦', label: 'bulk.moveAction' },
  { key: 'purchase', icon: '🧾', label: 'bulk.purchaseAction' },
  { key: 'consume',  icon: '🍷', label: 'bulk.consumeAction' },
  { key: 'reserve',  icon: '🔖', label: 'bulk.reserveAction' },
  { key: 'window',   icon: '⏳', label: 'bulk.windowAction' },
  // Early access (flag pickLists): the bottles go on a pick list that shows
  // where each one sits. Shown only to members with the feature on.
  { key: 'pick',     icon: '📍', label: 'bulk.pickAction', feature: 'pickLists' },
  { key: 'list',     icon: '📋', label: 'bulk.listAction' },
  { key: 'delete',   icon: '🗑️', label: 'bulk.deleteAction', danger: true },
];

// The bottle list of the cellar page, in the list view or the card view.
// `multi` = cross-cellar view: each bottle carries its own `cellar` id +
// `cellarName` so it links to and is badged with the right cellar. Items are
// grouped ({ key, count, bottles }) in both views — cross-cellar groups never
// span two cellars — with a flat-bottle fallback for ungrouped responses.
// `canBulkMove` (owner of this one cellar) enables select mode and its bulk
// actions; `onBulkDone` refreshes the parent's list, stats and racks after
// one; `onSelectModeChange` tells the parent to hide the FAB meanwhile.
export default function BottlesList({ bottles, rackMap, cellarId, hasMore, loadingMore, onLoadMore, multi = false, rackKnown = false, placesKnown = false, canBulkMove = false, canConsume = false, onBulkDone, onSelectModeChange, onTakenOut }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { user } = useAuth();
  // A bottle opened from this list comes back to it — this cellar's page, with
  // "all my cellars" still chosen if it was — on Back and after Drink, Delete
  // or Move, even when the bottle itself lives in another cellar.
  const backHere = useBackHere('cellar');
  // The vintage page an entry opens hands the same place on to its bottles.
  const openVintage = (href) => navigate(href, { state: { cellarList: backHere.backTo } });
  // "Show on cards": extra details the user picks for every card — rating,
  // price, size, region, purchase date — per device.
  const [cardFields, setCardFields] = useState(readCardFields);
  const [fieldsOpen, setFieldsOpen] = useState(false);
  const toggleCardField = (field) => {
    setCardFields(prev => {
      const next = prev.includes(field) ? prev.filter(f => f !== field) : CARD_FIELDS.filter(f => f === field || prev.includes(f));
      storeCardFields(next);
      return next;
    });
  };
  // "Drink one" on a stacked card: the group
  // whose bottle is being picked, then — after the server logged it — the
  // journal prompt the bottle page offers for a bottle drunk, unless the
  // user opted out of it. The list refreshes through onBulkDone either way.
  const [drinkGroup, setDrinkGroup] = useState(null);
  const [journalBottle, setJournalBottle] = useState(null);
  // One page per wine and vintage: a tap on ANY entry — one bottle or a
  // stack — opens the vintage page, so the last bottle of a vintage looks and
  // behaves like the ones before it, and "Drink one" sits on every entry. A
  // stack still expands from the ⊕ in select mode. An entry still waiting on
  // a wine request has no registry wine: a tap opens the bottle (one) or
  // expands the stack.
  const pickListsOn = useFeature('pickLists');
  const vintageHref = (rep, inCellar) => (rep?.wineDefinition?._id
    ? `/cellars/${inCellar}/vintages/${rep.wineDefinition._id}/${encodeURIComponent(rep.vintage || 'NV')}`
    : null);
  const handleDrunk = (bottle, reason) => {
    setDrinkGroup(null);
    // Said at the top of the list, with Undo: a drink from a card must not
    // just change the count and say nothing.
    onTakenOut?.({ kind: 'consumed', reason, bottleId: bottle._id, name: bottleNoticeName(bottle), at: Date.now(), floating: true });
    if (reason === 'drank' && !journalPromptOptedOut()) setJournalBottle(bottle);
    else onBulkDone?.();
  };
  const [viewMode, setViewMode] = useState(readBottleViewMode);
  const [density, setDensity] = useState(() => {
    try { return localStorage.getItem('cellarion_bottle_density') || 'comfortable'; } catch { return 'comfortable'; }
  });
  const [showNotes, setShowNotes] = useState(() => {
    try { return localStorage.getItem('cellarion_bottle_notes') === '1'; } catch { return false; }
  });
  const [expandedGroups, setExpandedGroups] = useState(() => new Set());

  // ── Multi-select → "Move to cellar" (a whole delivery logged in a storage
  // cellar goes home in one step, not one bottle at a time). Owner-only and
  // single-cellar — the parent gates canBulkMove. A
  // collapsed group toggles all of its bottles at once, which is exactly the
  // delivery case; expand the group to pick individual bottles.
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [bulkAction, setBulkAction] = useState(null); // a BULK_ACTIONS key, or null
  const idsOf = (item) => (Array.isArray(item?.bottles) ? item.bottles.map(b => b._id) : [item._id]);
  // Long-press on a card: enter select mode with that card already ticked.
  const enterSelectWith = (ids) => {
    if (!canBulkMove) return;
    setSelectMode(true);
    setSelectedIds(prev => { const next = new Set(prev); ids.forEach(x => next.add(x)); return next; });
  };
  const closeAction = () => setBulkAction(null);
  const finishAction = () => { setBulkAction(null); setSelectMode(false); setSelectedIds(new Set()); onBulkDone?.(); };
  const allLoadedIds = bottles.flatMap(idsOf);
  const isSelected = (ids) => ids.length > 0 && ids.every(x => selectedIds.has(x));
  const toggleIds = (ids) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      const allOn = ids.every(x => next.has(x));
      ids.forEach(x => (allOn ? next.delete(x) : next.add(x)));
      return next;
    });
  };
  const exitSelect = () => { setSelectMode(false); setSelectedIds(new Set()); };
  // Leaving the owner/single-cellar case (scope widened, cellar changed) ends
  // select mode rather than leaving checked cards nothing can act on.
  useEffect(() => {
    if (!canBulkMove) { setSelectMode(false); setSelectedIds(new Set()); }
  }, [canBulkMove, cellarId]);
  const selectableNow = selectMode && canBulkMove;
  useEffect(() => { onSelectModeChange?.(selectableNow); }, [selectableNow, onSelectModeChange]);

  const setView = (mode) => {
    setViewMode(mode);
    storeBottleViewMode(mode);
  };

  const setDens = (mode) => {
    setDensity(mode);
    try { localStorage.setItem('cellarion_bottle_density', mode); } catch {}
  };

  const toggleNotes = () => {
    setShowNotes(on => {
      try { localStorage.setItem('cellarion_bottle_notes', on ? '0' : '1'); } catch {}
      return !on;
    });
  };

  // Compact only applies to list view — the grid's height is driven by the image.
  const compact = viewMode === 'list' && density === 'compact';
  // Notes preview likewise: the grid tiles have no room for a text line.
  const notesOn = viewMode === 'list' && showNotes;
  // One line of the picked details for a card's bottles (one, or a stack).
  // A string, so the memoized BottleCard compares it by value. The grid card
  // already shows the region (a wine with only a country still gets it here).
  const ratingScale = user?.preferences?.ratingScale || '5';
  const detailsOf = (list) => cardDetails(list, cardFields, { ratingScale, locale: i18n.language, cardShowsRegion: viewMode !== 'list' })
    .map(d => (d.field === 'purchased' ? t('cellarDetail.cardPurchased', { date: d.text, defaultValue: 'Bought {{date}}' }) : d.text))
    .join(' · ');

  const toggleGroup = (key) => {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  return (
    <>
      <div className="bottles-view-toggle">
        {canBulkMove && (
          <button
            type="button"
            className={`view-toggle-btn select-toggle-btn ${selectMode ? 'active' : ''}`}
            onClick={() => (selectMode ? exitSelect() : setSelectMode(true))}
            aria-pressed={selectMode}
            title={t('cellarDetail.selectBottlesTitle')}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><polyline points="7 12 11 16 17 8"/></svg>
            {t('cellarDetail.selectBottles')}
          </button>
        )}
        <div className="more-menu-wrap card-fields-wrap">
          <button
            type="button"
            className={`view-toggle-btn card-fields-btn ${cardFields.length ? 'active' : ''}`}
            onClick={() => setFieldsOpen(o => !o)}
            aria-haspopup="true"
            aria-expanded={fieldsOpen}
            aria-label={t('cellarDetail.cardFields', 'Show on cards')}
            title={t('cellarDetail.cardFields', 'Show on cards')}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/><circle cx="9" cy="6" r="2" fill="currentColor"/><circle cx="15" cy="12" r="2" fill="currentColor"/><circle cx="7" cy="18" r="2" fill="currentColor"/></svg>
          </button>
          {fieldsOpen && (
            <>
              <div className="more-menu-backdrop" onClick={() => setFieldsOpen(false)} aria-hidden="true" />
              <div className="more-menu-dropdown card-fields-menu" role="group" aria-label={t('cellarDetail.cardFields', 'Show on cards')}>
                <div className="card-fields-title">{t('cellarDetail.cardFields', 'Show on cards')}</div>
                {CARD_FIELDS.map(field => (
                  <label key={field} className="more-menu-item card-fields-item">
                    <input type="checkbox" checked={cardFields.includes(field)} onChange={() => toggleCardField(field)} />
                    {t(`cellarDetail.cardField.${field}`)}
                  </label>
                ))}
              </div>
            </>
          )}
        </div>
        {viewMode === 'list' && (
          <button
            className={`view-toggle-btn notes-toggle-btn ${showNotes ? 'active' : ''}`}
            onClick={toggleNotes}
            aria-label={t('cellarDetail.showNotes', 'Show notes')}
            aria-pressed={showNotes}
            title={t('cellarDetail.showNotes', 'Show notes')}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
          </button>
        )}
        {viewMode === 'list' && (
          <button
            className={`view-toggle-btn density-toggle-btn ${density === 'compact' ? 'active' : ''}`}
            onClick={() => setDens(density === 'compact' ? 'comfortable' : 'compact')}
            aria-label={t('cellarDetail.compactView', 'Compact view')}
            aria-pressed={density === 'compact'}
            title={t('cellarDetail.compactView', 'Compact view')}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="3" y1="14" x2="21" y2="14"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
          </button>
        )}
        <button
          className={`view-toggle-btn ${viewMode === 'list' ? 'active' : ''}`}
          onClick={() => setView('list')}
          aria-label="List view"
          aria-pressed={viewMode === 'list'}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
        </button>
        <button
          className={`view-toggle-btn ${viewMode === 'card' ? 'active' : ''}`}
          onClick={() => setView('card')}
          aria-label="Card view"
          aria-pressed={viewMode === 'card'}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
        </button>
        {/* The analytics table lives on the Dashboard page (this page's
            search bar and filters would sit above a table they do not
            filter); the shortcut opens it with this cellar's scope
            preselected. */}
        <Link
          to={multi ? '/dashboard?view=table' : `/dashboard?view=table&cellar=${cellarId}`}
          className="view-toggle-btn view-toggle-link"
          aria-label={t('analytics.openTable', 'Open the analytics table')}
          title={t('analytics.openTable', 'Open the analytics table')}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="1"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/></svg>
        </Link>
      </div>

      {selectableNow && (
        <div className="bulk-bar" role="region" aria-label={t('cellarDetail.bulkBarAria')}>
          <div className="bulk-bar-head">
            <span className="bulk-bar-count" aria-live="polite">
              {t('cellarDetail.selectedCount', { count: selectedIds.size })}
            </span>
            <button
              type="button"
              className="bulk-bar-link"
              onClick={() => setSelectedIds(new Set(allLoadedIds))}
              disabled={allLoadedIds.length === 0 || isSelected(allLoadedIds)}
            >
              {t('cellarDetail.selectAllLoaded', { count: allLoadedIds.length })}
            </button>
            <button type="button" className="bulk-bar-close" onClick={exitSelect} aria-label={t('common.cancel')} title={t('common.cancel')}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
          <div className="bulk-bar-actions">
            {BULK_ACTIONS.filter(a => !a.feature || (a.feature === 'pickLists' && pickListsOn)).map(a => (
              <button
                key={a.key}
                type="button"
                className={`bulk-action-btn${a.danger ? ' bulk-action-btn--danger' : ''}`}
                onClick={() => setBulkAction(a.key)}
                disabled={selectedIds.size === 0}
              >
                <span className="bulk-action-icon" aria-hidden="true">{a.icon}</span>
                <span className="bulk-action-label">{t(a.label)}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className={viewMode === 'list' ? 'bottles-list' : 'bottles-grid'}>
        {bottles.map(item => {
          // Cross-cellar view, flat (ungrouped) item: linked to + badged with its cellar.
          if (multi && !Array.isArray(item?.bottles)) {
            return (
              <BottleCard linkState={backHere}
                key={item._id}
                bottle={item}
                details={detailsOf([item])}
                rackMap={rackMap}
                cellarId={item.cellar || cellarId}
                viewMode={viewMode}
                showCellarBadge
                compact={compact}
                rackKnown={rackKnown}
                showNotes={notesOn}
              />
            );
          }
          // Grouped response: item = { key, count, bottles: [...] }
          if (item && Array.isArray(item.bottles)) {
            const rep = item.bottles[0];
            // Cross-cellar groups live in one cellar: link + badge with it.
            const groupCellarId = multi ? (rep.cellar || cellarId) : cellarId;
            // The vintage page every entry opens (null while the entry has
            // no registry wine yet).
            const pageHref = vintageHref(rep, groupCellarId);
            if (item.count === 1) {
              return (
                <BottleCard linkState={backHere}
                  key={rep._id} bottle={rep} details={detailsOf([rep])} rackMap={rackMap} cellarId={groupCellarId} showCellarBadge={multi} viewMode={viewMode} compact={compact} rackKnown={rackKnown} showNotes={notesOn} selectable={selectableNow} selected={isSelected(idsOf(item))} onToggleSelect={() => toggleIds(idsOf(item))} onLongPress={canBulkMove ? () => enterSelectWith(idsOf(item)) : undefined}
                  onClick={pageHref ? () => openVintage(pageHref) : undefined}
                  onDrinkOne={canConsume ? () => setDrinkGroup(item) : undefined}
                  actionsInline
                />
              );
            }
            if (!expandedGroups.has(item.key)) {
              return (
                <BottleCard linkState={backHere}
                  key={item.key}
                  bottle={rep}
                  rackMap={rackMap}
                  cellarId={groupCellarId}
                  showCellarBadge={multi}
                  viewMode={viewMode}
                  groupCount={item.count}
                  details={detailsOf(item.bottles)}
                  onClick={pageHref ? () => openVintage(pageHref) : () => toggleGroup(item.key)}
                  onExpand={pageHref ? () => toggleGroup(item.key) : undefined}
                  actionsInline
                  onDrinkOne={canConsume ? () => setDrinkGroup(item) : undefined}
                  selectable={selectableNow}
                  selected={isSelected(idsOf(item))}
                  onToggleSelect={() => toggleIds(idsOf(item))}
                  onLongPress={canBulkMove ? () => enterSelectWith(idsOf(item)) : undefined}
                  compact={compact}
                  rackKnown={rackKnown}
                  showNotes={notesOn}
                />
              );
            }
            const wineName = rep.wineDefinition?.name || rep.pendingWineRequest?.wineName || t('common.unknownWine');
            return (
              <Fragment key={item.key}>
                <div className="bottle-group-bar">
                  <span><strong>{wineName}</strong> · {formatVintage(rep.vintage || 'NV', t)} · {t('cellarDetail.groupBottleCount', { count: item.count })}</span>
                  <button type="button" className="bottle-group-collapse" onClick={() => toggleGroup(item.key)}>
                    {t('cellarDetail.collapseGroup')}
                  </button>
                </div>
                {item.bottles.map(b => (
                  <BottleCard linkState={backHere} key={b._id} bottle={b} details={detailsOf([b])} rackMap={rackMap} cellarId={groupCellarId} showCellarBadge={multi} viewMode={viewMode} compact={compact} rackKnown={rackKnown} showNotes={notesOn} selectable={selectableNow} selected={isSelected([b._id])} onToggleSelect={() => toggleIds([b._id])} onLongPress={canBulkMove ? () => enterSelectWith([b._id]) : undefined} />
                ))}
              </Fragment>
            );
          }
          // Defensive fallback: a plain bottle item (responses are always grouped)
          return (
            <BottleCard linkState={backHere} key={item._id} bottle={item} details={detailsOf([item])} rackMap={rackMap} cellarId={cellarId} viewMode={viewMode} compact={compact} rackKnown={rackKnown} showNotes={notesOn} selectable={selectableNow} selected={isSelected([item._id])} onToggleSelect={() => toggleIds([item._id])} onLongPress={canBulkMove ? () => enterSelectWith([item._id]) : undefined} />
          );
        })}
      </div>

      {hasMore && (
        <div className="load-more-wrap">
          <button
            className="btn btn-secondary"
            onClick={onLoadMore}
            disabled={loadingMore}
          >
            {loadingMore ? t('common.loading') : t('cellarDetail.loadMore')}
          </button>
        </div>
      )}

      <Suspense fallback={null}>
        {bulkAction === 'move' && (
          <MoveBottleModal bottleIds={[...selectedIds]} currentCellarId={cellarId} onClose={closeAction} onMoved={finishAction} />
        )}
        {bulkAction === 'purchase' && (
          <BulkPurchaseModal bottleIds={[...selectedIds]} onClose={closeAction} onDone={finishAction} />
        )}
        {bulkAction === 'consume' && (
          <BulkConsumeModal bottleIds={[...selectedIds]} onClose={closeAction} onDone={finishAction} />
        )}
        {bulkAction === 'reserve' && (
          <BulkReserveModal bottleIds={[...selectedIds]} onClose={closeAction} onDone={finishAction} />
        )}
        {bulkAction === 'window' && (
          <BulkDrinkWindowModal bottleIds={[...selectedIds]} onClose={closeAction} onDone={finishAction} />
        )}
        {bulkAction === 'pick' && (
          <AddToPickListModal bottleIds={[...selectedIds]} onClose={closeAction} onDone={finishAction} />
        )}
        {bulkAction === 'list' && (
          <BulkAddToListModal bottleIds={[...selectedIds]} cellarId={cellarId} onClose={closeAction} onDone={finishAction} />
        )}
        {bulkAction === 'delete' && (
          <BulkDeleteModal
            bottleIds={[...selectedIds]}
            cellarId={cellarId}
            summary={summarizeSelection(bottles, selectedIds, t('common.unknownWine'))}
            rackedCount={[...selectedIds].filter(x => rackMap.has(String(x))).length}
            onClose={closeAction}
            onDone={finishAction}
          />
        )}
        {drinkGroup && (
          <DrinkOneModal
            bottles={drinkGroup.bottles}
            rackMap={rackMap}
            wineName={bottleNoticeName(drinkGroup.bottles[0])}
            placesKnown={placesKnown}
            onClose={() => setDrinkGroup(null)}
            onDone={handleDrunk}
          />
        )}
      </Suspense>
      {journalBottle && (
        <JournalPrompt bottle={journalBottle} onDone={() => { setJournalBottle(null); onBulkDone?.(); }} />
      )}
    </>
  );
}
