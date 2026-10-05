import { useState, useEffect, useMemo } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import WineImage from '../components/WineImage';
import CellarNav from '../components/CellarNav';
import CellarPageHeader from '../components/CellarPageHeader';
import { getCellarOnOrder } from '../api/cellars';
import { markBottleArrived, bulkArriveBottles, bulkUpdateBottles } from '../api/bottles';
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
 * all its bottles at once.
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
                onFailure={handleFailure}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function OnOrderGroup({ group, cellarId, canEdit, onArrived, onMonthChanged, onFailure }) {
  const { t, i18n } = useTranslation();
  const { apiFetch } = useAuth();
  const first = group.bottles[0];
  const count = group.bottles.length;
  const ids = group.bottles.map((b) => b._id);
  const wine = first.wineDefinition;
  const name = wine?.name || first.pendingWineRequest?.wineName || t('common.unknownWine');
  const producer = wine?.producer || first.pendingWineRequest?.producer;
  const month = formatArrivalMonth(first.expectedArrival, i18n.language);
  const late = isArrivalLate(first.expectedArrival);

  // null | 'arrive' | 'month'
  const [panel, setPanel] = useState(null);
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
