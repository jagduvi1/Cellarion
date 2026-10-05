import { useState, useEffect, useMemo } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import WineImage from '../components/WineImage';
import CellarNav from '../components/CellarNav';
import CellarPageHeader from '../components/CellarPageHeader';
import { getCellarOnOrder } from '../api/cellars';
import { markBottleArrived, bulkArriveBottles } from '../api/bottles';
import {
  groupOnOrder, formatArrivalMonth, isArrivalLate, totalsByCurrency, todayInput,
} from '../utils/onOrder';
import './CellarDetail.css';
import './CellarOnOrder.css';

/**
 * Bottles bought for this cellar that have not arrived yet (status
 * 'ordered'): en primeur, pre-orders, deliveries on their way. They stay out
 * of the cellar's counts, racks and drinking suggestions until they are
 * marked as arrived here (or on the bottle page), which makes them ordinary
 * unplaced bottles.
 */
function CellarOnOrder() {
  const { t, i18n } = useTranslation();
  const { id } = useParams();
  const { apiFetch, user } = useAuth();
  const [cellar, setCellar] = useState(null);
  const [bottles, setBottles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // { count } after a delivery was marked — the "now in your cellar" note.
  const [arrived, setArrived] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await getCellarOnOrder(apiFetch, id);
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok) { setError(data.error || t('onOrder.loadFailed')); return; }
        setCellar(data.cellar);
        setBottles(data.bottles || []);
      } catch {
        if (!cancelled) setError(t('onOrder.loadFailed'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // Load once per cellar: re-running on every new `t` or apiFetch identity
    // would reload the list and undo a delivery just marked as arrived.
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const groups = useMemo(() => groupOnOrder(bottles), [bottles]);
  const totals = useMemo(() => totalsByCurrency(bottles), [bottles]);
  const canEdit = !!cellar && ['owner', 'editor'].includes(cellar.userRole) && !user?.isDemo;

  const handleArrived = (ids) => {
    const gone = new Set(ids.map(String));
    setBottles((prev) => prev.filter((b) => !gone.has(String(b._id))));
    setArrived({ count: ids.length });
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
                onError={setError}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function OnOrderGroup({ group, cellarId, canEdit, onArrived, onError }) {
  const { t, i18n } = useTranslation();
  const { apiFetch } = useAuth();
  const first = group.bottles[0];
  const count = group.bottles.length;
  const wine = first.wineDefinition;
  const name = wine?.name || first.pendingWineRequest?.wineName || t('common.unknownWine');
  const producer = wine?.producer || first.pendingWineRequest?.producer;
  const month = formatArrivalMonth(first.expectedArrival, i18n.language);
  const late = isArrivalLate(first.expectedArrival);

  const [open, setOpen] = useState(false);
  const [howMany, setHowMany] = useState(count);
  const [date, setDate] = useState(todayInput);
  const [busy, setBusy] = useState(false);

  const confirm = async () => {
    const n = Math.min(Math.max(1, Number(howMany) || 1), count);
    const ids = group.bottles.slice(0, n).map((b) => b._id);
    setBusy(true);
    try {
      const res = n === 1
        ? await markBottleArrived(apiFetch, ids[0], date)
        : await bulkArriveBottles(apiFetch, ids, date);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { onError(data.error || t('onOrder.arriveFailed')); return; }
      const done = n === 1 ? ids : (data.doneIds || ids);
      // Part of a delivery arrived: the rest stays listed, panel closed.
      setOpen(false);
      setHowMany(Math.max(1, count - done.length));
      onArrived(done);
    } catch {
      onError(t('onOrder.arriveFailed'));
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
        {canEdit && !open && (
          <button type="button" className="btn btn-primary btn-small on-order-arrive-btn" onClick={() => setOpen(true)}>
            {t('onOrder.markArrived')}
          </button>
        )}
      </div>

      {canEdit && open && (
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
            <button type="button" className="btn btn-primary btn-small" onClick={confirm} disabled={busy}>
              {busy ? t('common.saving', 'Saving…') : t('onOrder.confirmArrived')}
            </button>
            <button type="button" className="btn btn-secondary btn-small" onClick={() => setOpen(false)} disabled={busy}>
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default CellarOnOrder;
