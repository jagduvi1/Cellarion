import { useState, useEffect, useMemo } from 'react';
import { useParams, Link } from 'react-router-dom';
import useHandedOverState from '../hooks/useHandedOverState';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import WineImage from '../components/WineImage';
import CellarNav from '../components/CellarNav';
import CellarPageHeader from '../components/CellarPageHeader';
import BottleUndoNotice, { bottleNoticeName } from '../components/BottleUndoNotice';
import { getCellarOnOrder } from '../api/cellars';
import { markBottleArrived, bulkArriveBottles, bulkUpdateBottles, createBottle, bulkDeleteBottles } from '../api/bottles';
import { TRASH_DAYS } from '../utils/trash';
import {
  groupOnOrder, formatArrivalMonth, isArrivalLate, totalsByCurrency, todayInput, toMonthInput,
} from '../utils/onOrder';
import './CellarDetail.css';
import './CellarOnOrder.css';

/**
 * Bottles bought for this cellar that have not arrived yet (status
 * 'ordered'): en primeur, pre-orders, deliveries on their way. They stay out
 * of the cellar's counts, racks and drinking suggestions until they are
 * marked as arrived here (or on the bottle page), which makes them ordinary
 * unplaced bottles. A delivery's expected month is changed here too, for
 * all its bottles at once, and so is how many bottles it holds (more bought,
 * or fewer delivered than ordered).
 */
function CellarOnOrder() {
  const { t, i18n } = useTranslation();
  const { id } = useParams();
  const { apiFetch } = useAuth();
  const [cellar, setCellar] = useState(null);
  const [bottles, setBottles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // { count } after a delivery was marked — the "now in your cellar" note.
  const [arrived, setArrived] = useState(null);
  // An order the bottle page just cancelled (it went to Recently deleted),
  // said here with Undo — handed over once (hooks/useHandedOverState).
  const [bottleNotice, setBottleNotice] = useHandedOverState('bottleNotice');

  const load = async () => {
    try {
      const res = await getCellarOnOrder(apiFetch, id);
      const data = await res.json();
      if (!res.ok) { setError(data.error || t('onOrder.loadFailed')); return; }
      setCellar(data.cellar);
      setBottles(data.bottles || []);
    } catch {
      setError(t('onOrder.loadFailed'));
    } finally {
      setLoading(false);
    }
  };

  // Load once per cellar: re-running on every new `t` or apiFetch identity
  // would reload the list and undo a delivery just marked as arrived.
  useEffect(() => { load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const groups = useMemo(() => groupOnOrder(bottles), [bottles]);
  const totals = useMemo(() => totalsByCurrency(bottles), [bottles]);
  // Same rule as the bottle page (and the arrive endpoint): owner or editor.
  const canEdit = !!cellar && ['owner', 'editor'].includes(cellar.userRole);

  // doneIds arrived now; goneIds also leave the list (bottles someone else
  // had already marked as arrived — the server skips them as not_on_order).
  const handleArrived = (doneIds, goneIds = []) => {
    const gone = new Set([...doneIds, ...goneIds].map(String));
    setBottles((prev) => prev.filter((b) => !gone.has(String(b._id))));
    if (doneIds.length > 0) setArrived({ count: doneIds.length });
  };

  // A delivery's new month, mirrored locally the way the server stores it
  // (1st of the month, noon UTC) so the row regroups at once.
  const handleMonthChanged = (ids, month) => {
    const set = new Set(ids.map(String));
    const value = month ? `${month}-01T12:00:00.000Z` : null;
    setBottles((prev) => prev.map((b) => (set.has(String(b._id)) ? { ...b, expectedArrival: value } : b)));
  };

  // Bottles taken off an order went to Recently deleted: off the list, and
  // said with Undo (which brings them back on order).
  const handleTakenOff = (ids, notice) => {
    const gone = new Set(ids.map(String));
    setBottles((prev) => prev.filter((b) => !gone.has(String(b._id))));
    if (ids.length > 0) setBottleNotice({ kind: 'deleted', onOrder: true, ...notice, count: ids.length, at: Date.now() });
  };

  // An action failed — perhaps because the list was out of date (another
  // member already marked bottles as arrived): say so and re-read it.
  const handleFailure = (message) => {
    setError(message);
    load();
  };

  const totalText = totals
    .map(({ currency, total }) => `${total.toLocaleString(i18n.language, { maximumFractionDigits: 2 })} ${currency}`)
    .join(' + ');

  return (
    <div className="cellar-detail-page on-order-page">
      {error && (
        <div className="alert alert-error" role="alert">
          {error}
          <button type="button" className="btn btn-small btn-secondary" style={{ marginLeft: '0.75rem' }} onClick={() => setError(null)}>
            ✕
          </button>
        </div>
      )}
      {bottleNotice && (
        <BottleUndoNotice notice={bottleNotice} cellarId={id} onUndone={load} onDismiss={() => setBottleNotice(null)} />
      )}
      <CellarPageHeader
        backTo={`/cellars/${id}`}
        backLabel={t('history.backTo', { cellarName: cellar?.name || '…' })}
        title={t('onOrder.title')}
        loading={loading}
        userColor={cellar?.userColor}
        subtitle={bottles.length > 0 ? t('onOrder.bottleCount', { count: bottles.length }) : null}
      />

      <CellarNav cellarId={id} />

      {arrived && (
        <div className="alert alert-success on-order-arrived" role="status">
          <span>{t('onOrder.arrivedNote', { count: arrived.count })}</span>
          <Link to={`/cellars/${id}/racks`} className="on-order-arrived-link">{t('onOrder.placeInRack')}</Link>
          <button type="button" className="on-order-arrived-close" aria-label={t('common.close', 'Close')} onClick={() => setArrived(null)}>✕</button>
        </div>
      )}

      {loading ? (
        <div className="loading">{t('common.loading')}</div>
      ) : bottles.length === 0 ? (
        <div className="on-order-empty card">
          <p className="on-order-empty-title">{t('onOrder.emptyTitle')}</p>
          <p className="on-order-empty-text">{t('onOrder.emptyText')}</p>
          <Link to={`/cellars/${id}`} className="btn btn-secondary btn-small">{t('onOrder.backToBottles')}</Link>
        </div>
      ) : (
        <>
          <p className="on-order-intro">{t('onOrder.intro')}</p>
          {totalText && <p className="on-order-total">{t('onOrder.paidTotal', { amount: totalText })}</p>}
          <div className="on-order-list">
            {groups.map((g) => (
              <OnOrderGroup
                key={g.key}
                group={g}
                cellarId={id}
                canEdit={canEdit}
                onArrived={handleArrived}
                onMonthChanged={handleMonthChanged}
                onAdded={load}
                onTakenOff={handleTakenOff}
                onFailure={handleFailure}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// How many bottles an order can be raised to here at once.
const MAX_ORDER_QTY = 200;

function OnOrderGroup({ group, cellarId, canEdit, onArrived, onMonthChanged, onAdded, onTakenOff, onFailure }) {
  const { t, i18n } = useTranslation();
  const { apiFetch, user } = useAuth();
  const first = group.bottles[0];
  const count = group.bottles.length;
  const ids = group.bottles.map((b) => b._id);
  const wine = first.wineDefinition;
  const name = wine?.name || first.pendingWineRequest?.wineName || t('common.unknownWine');
  const producer = wine?.producer || first.pendingWineRequest?.producer;
  const month = formatArrivalMonth(first.expectedArrival, i18n.language);
  const late = isArrivalLate(first.expectedArrival);

  // null | 'arrive' | 'month' | 'qty'
  const [panel, setPanel] = useState(null);
  const [newQty, setNewQty] = useState(count);
  // More bottles copy a registry wine (one still waiting for review has none
  // yet) and need an account that may add bottles (not the demo's).
  const canAdd = !!wine?._id && !user?.isDemo;
  const [howMany, setHowMany] = useState(count);
  const [date, setDate] = useState(todayInput);
  const [newMonth, setNewMonth] = useState(() => toMonthInput(first.expectedArrival));
  const [busy, setBusy] = useState(false);

  const confirmArrived = async () => {
    const n = Math.min(Math.max(1, Number(howMany) || 1), count);
    const chosen = ids.slice(0, n);
    setBusy(true);
    try {
      const res = n === 1
        ? await markBottleArrived(apiFetch, chosen[0], date)
        : await bulkArriveBottles(apiFetch, chosen, date);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { onFailure(data.error || t('onOrder.arriveFailed')); return; }
      const done = n === 1 ? chosen : (data.doneIds || chosen);
      const alreadyArrived = (data.skipped || []).filter((s) => s.reason === 'not_on_order').map((s) => s.id);
      // Part of a delivery arrived: the rest stays listed, panel closed.
      setPanel(null);
      setHowMany(Math.max(1, count - done.length - alreadyArrived.length));
      onArrived(done, alreadyArrived);
    } catch {
      onFailure(t('onOrder.arriveFailed'));
    } finally {
      setBusy(false);
    }
  };

  const saveMonth = async () => {
    setBusy(true);
    try {
      const res = await bulkUpdateBottles(apiFetch, ids, { expectedArrival: newMonth || null });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { onFailure(data.error || t('onOrder.monthFailed')); return; }
      setPanel(null);
      onMonthChanged(data.doneIds || ids, newMonth);
    } catch {
      onFailure(t('onOrder.monthFailed'));
    } finally {
      setBusy(false);
    }
  };

  // Change how many bottles this order holds. More: new bottles on order with
  // this order's wine, size, price, shop and expected month. Fewer: the most
  // recently added go to Recently deleted (Undo brings them back on order).
  const target = Math.min(Math.max(1, Math.floor(Number(newQty)) || 1), canAdd ? MAX_ORDER_QTY : count);
  const saveQty = async () => {
    if (target === count) { setPanel(null); return; }
    setBusy(true);
    try {
      if (target > count) {
        const payload = {
          cellar: cellarId,
          wineDefinition: wine._id,
          vintage: first.vintage,
          bottleSize: first.bottleSize || undefined,
          onOrder: true,
          expectedArrival: toMonthInput(first.expectedArrival) || undefined,
        };
        if (first.currency) payload.currency = first.currency;
        if (first.price != null && first.price !== '') payload.price = first.price;
        if (first.purchaseDate) payload.purchaseDate = first.purchaseDate;
        if (first.purchaseLocation) payload.purchaseLocation = first.purchaseLocation;
        if (first.purchaseUrl) payload.purchaseUrl = first.purchaseUrl;
        const wanted = target - count;
        let added = 0;
        for (; added < wanted; added += 1) {
          const res = await createBottle(apiFetch, payload);
          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            const msg = data.error || t('onOrder.qtyFailed', 'Could not change how many bottles are on order. Please try again.');
            onFailure(added > 0 ? t('addBottle.partialAdded', { msg, count: added, total: wanted, remaining: wanted - added }) : msg);
            return;
          }
        }
        setPanel(null);
        onAdded();
      } else {
        const surplus = [...group.bottles]
          .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
          .slice(0, count - target)
          .map((b) => b._id);
        const res = await bulkDeleteBottles(apiFetch, surplus);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) { onFailure(data.error || t('onOrder.qtyFailed', 'Could not change how many bottles are on order. Please try again.')); return; }
        setPanel(null);
        onTakenOff(data.deletedIds || surplus, { batchId: data.batchId, name: bottleNoticeName(first), bottleId: surplus[0] });
      }
    } catch {
      onFailure(t('onOrder.qtyFailed', 'Could not change how many bottles are on order. Please try again.'));
    } finally {
      setBusy(false);
    }
  };
  const qtyHint = target > count
    ? t('onOrder.qtyAddHint', 'The new bottles get this order’s price, shop and expected month.')
    : target < count
      ? t('onOrder.qtyRemoveHint', 'The bottles taken off go to Recently deleted. You can bring them back for {{days}} days.', { days: TRASH_DAYS })
      : (!canAdd ? t('onOrder.qtyOnlyFewer', 'Bottles can only be taken off this order here.') : null);

  return (
    <div className={`on-order-card${late ? ' is-late' : ''}`}>
      <div className="on-order-main">
        <WineImage image={wine?.image} alt={name} className="on-order-image" />
        <div className="on-order-info">
          <h3>
            <Link to={`/cellars/${cellarId}/bottles/${first._id}`}>{name}</Link>
          </h3>
          {producer && <p className="on-order-producer">{producer}</p>}
          <div className="on-order-meta">
            <span>{first.vintage || 'NV'}</span>
            {first.bottleSize && first.bottleSize !== '750ml' && <span>· {first.bottleSize}</span>}
            <span className="on-order-qty">· {t('onOrder.qty', { count })}</span>
            {first.price != null && first.price !== '' && (
              <span>· {t('onOrder.pricePerBottle', { price: `${first.price} ${first.currency || ''}`.trim() })}</span>
            )}
            {first.purchaseLocation && <span>· {first.purchaseLocation}</span>}
          </div>
          <p className={`on-order-expected${late ? ' is-late' : ''}`}>
            {month
              ? (late ? t('onOrder.expectedLate', { month }) : t('onOrder.expected', { month }))
              : t('onOrder.noDate')}
          </p>
        </div>
        {canEdit && !panel && (
          <div className="on-order-actions">
            <button type="button" className="btn btn-primary btn-small on-order-arrive-btn" onClick={() => setPanel('arrive')}>
              {t('onOrder.markArrived')}
            </button>
            <button type="button" className="btn btn-secondary btn-small" onClick={() => setPanel('month')}>
              {t('onOrder.changeMonth')}
            </button>
            <button type="button" className="btn btn-secondary btn-small" onClick={() => { setNewQty(count); setPanel('qty'); }}>
              {t('onOrder.changeQty', 'Change quantity')}
            </button>
          </div>
        )}
      </div>

      {canEdit && panel === 'arrive' && (
        <div className="on-order-arrive-panel">
          {count > 1 && (
            <label className="on-order-field">
              <span>{t('onOrder.howMany')}</span>
              <input
                type="number"
                min={1}
                max={count}
                value={howMany}
                onChange={(e) => setHowMany(e.target.value)}
              />
              <span className="on-order-field-hint">{t('onOrder.ofCount', { count })}</span>
            </label>
          )}
          <label className="on-order-field">
            <span>{t('onOrder.arrivedOn')}</span>
            <input type="date" value={date} max={todayInput()} onChange={(e) => setDate(e.target.value)} />
          </label>
          <div className="on-order-arrive-actions">
            <button type="button" className="btn btn-primary btn-small" onClick={confirmArrived} disabled={busy}>
              {busy ? t('common.saving', 'Saving…') : t('onOrder.confirmArrived')}
            </button>
            <button type="button" className="btn btn-secondary btn-small" onClick={() => setPanel(null)} disabled={busy}>
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}

      {canEdit && panel === 'qty' && (
        <div className="on-order-arrive-panel">
          <label className="on-order-field">
            <span>{t('onOrder.qtyLabel', 'Bottles on this order')}</span>
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={canAdd ? MAX_ORDER_QTY : count}
              value={newQty}
              onChange={(e) => setNewQty(e.target.value)}
            />
            {qtyHint && <span className="on-order-field-hint">{qtyHint}</span>}
          </label>
          <div className="on-order-arrive-actions">
            <button type="button" className="btn btn-primary btn-small" onClick={saveQty} disabled={busy}>
              {busy ? t('common.saving', 'Saving…') : t('onOrder.saveQty', 'Save')}
            </button>
            <button type="button" className="btn btn-secondary btn-small" onClick={() => setPanel(null)} disabled={busy}>
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}

      {canEdit && panel === 'month' && (
        <div className="on-order-arrive-panel">
          <label className="on-order-field">
            <span>{t('addBottle.expectedArrival')}</span>
            <input
              type="month"
              placeholder="YYYY-MM"
              pattern="\d{4}-\d{2}"
              value={newMonth}
              onChange={(e) => setNewMonth(e.target.value)}
            />
            {count > 1 && <span className="on-order-field-hint">{t('onOrder.monthAppliesTo', { count })}</span>}
          </label>
          <div className="on-order-arrive-actions">
            <button type="button" className="btn btn-primary btn-small" onClick={saveMonth} disabled={busy}>
              {busy ? t('common.saving', 'Saving…') : t('onOrder.saveMonth')}
            </button>
            <button type="button" className="btn btn-secondary btn-small" onClick={() => setPanel(null)} disabled={busy}>
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default CellarOnOrder;
