import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth, usePlan } from '../contexts/AuthContext';
import { getDrinkStatus, formatDrinkDate, toInputDate, toMonthInput, monthToLastDay } from '../utils/drinkStatus';
import { fetchRates, convertAmount, convertAmountHistorical } from '../utils/currency';
import ImageUpload from '../components/ImageUpload';
import './BottleDetail.css';

const CURRENT_YEAR = new Date().getFullYear();

// Derive the current maturity phase from a 3-phase reviewed WineVintageProfile
function getMaturityStatus(profile) {
  if (!profile || profile.status !== 'reviewed') return null;
  const { earlyFrom, earlyUntil, peakFrom, peakUntil, lateFrom, lateUntil } = profile;
  if (!earlyFrom) return null;

  if (CURRENT_YEAR < earlyFrom)                              return { status: 'not-ready', label: `Not yet mature — from ${earlyFrom}` };
  if (earlyUntil && CURRENT_YEAR <= earlyUntil)              return { status: 'early',     label: 'Early drinking' };
  if (peakFrom   && CURRENT_YEAR <  peakFrom)                return { status: 'early',     label: `Early drinking — peak from ${peakFrom}` };
  if (peakUntil  && CURRENT_YEAR <= peakUntil)               return { status: 'peak',      label: 'Optimal maturity ⭐' };
  if (lateFrom   && CURRENT_YEAR <  lateFrom)                return { status: 'peak',      label: `Optimal maturity — late phase from ${lateFrom}` };
  if (lateUntil  && CURRENT_YEAR <= lateUntil)               return { status: 'late',      label: 'Late maturity' };
  if ((lateUntil && CURRENT_YEAR >  lateUntil) ||
      (peakUntil && CURRENT_YEAR >  peakUntil && !lateFrom)) return { status: 'declining', label: 'Past prime' };
  if (peakFrom   && CURRENT_YEAR >= peakFrom)                return { status: 'peak',      label: 'Optimal maturity ⭐' };
  return { status: 'early', label: 'Early drinking' };
}

function BottleDetail() {
  const { t } = useTranslation();
  const { id: cellarId, bottleId } = useParams();
  const { apiFetch, user } = useAuth();
  const navigate = useNavigate();
  const [bottle, setBottle] = useState(null);
  const [userRole, setUserRole] = useState(null);
  const [cellarColor, setCellarColor] = useState(null);
  const [rackInfo, setRackInfo] = useState(null);
  const [vintageProfile, setVintageProfile] = useState(null);
  const [priceHistory, setPriceHistory] = useState(null);
  const [rates, setRates] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(false);
  const [consumeOpen, setConsumeOpen] = useState(false);
  const [pendingImage, setPendingImage] = useState(null);


  useEffect(() => {
    fetchBottle();
    fetchRackInfo();
  }, [bottleId]); // eslint-disable-line react-hooks/exhaustive-deps

  const fetchBottle = async () => {
    try {
      const res = await apiFetch(`/api/bottles/${bottleId}`);
      const data = await res.json();
      if (res.ok) {
        setBottle(data.bottle);
        setUserRole(data.userRole);
        setCellarColor(data.cellarColor || null);
        if (data.pendingImageUrl) {
          const API_URL = process.env.REACT_APP_API_URL || '';
          const url = data.pendingImageUrl.startsWith('http')
            ? data.pendingImageUrl
            : `${API_URL}${data.pendingImageUrl}`;
          setPendingImage(url);
        }
        // Fetch the sommelier maturity profile for this wine+vintage
        const wine = data.bottle?.wineDefinition;
        const vintage = data.bottle?.vintage;
        if (wine?._id && vintage && vintage !== 'NV') {
          fetchVintageProfile(wine._id, vintage);
          fetchPriceHistory(wine._id, vintage);
          fetchRates().then(r => { if (r) setRates(r); });
        }
      } else {
        setError(data.error || 'Failed to load bottle');
      }
    } catch {
      setError('Network error');
    } finally {
      setLoading(false);
    }
  };

  const fetchVintageProfile = async (wineId, vintage) => {
    try {
      const res = await apiFetch(
        `/api/somm/maturity/lookup?wine=${wineId}&vintage=${vintage}`
      );
      const data = await res.json();
      if (res.ok) setVintageProfile(data.profile);
    } catch {
      // Non-critical — silently ignore
    }
  };

  const fetchPriceHistory = async (wineId, vintage) => {
    try {
      const res = await apiFetch(
        `/api/somm/prices/lookup?wine=${wineId}&vintage=${vintage}`
      );
      const data = await res.json();
      if (res.ok) setPriceHistory(data.history || []);
      else setPriceHistory([]);
    } catch {
      setPriceHistory([]);
    }
  };

  const fetchRackInfo = async () => {
    try {
      const res = await apiFetch(`/api/racks?cellar=${cellarId}`);
      const data = await res.json();
      if (res.ok) {
        for (const rack of data.racks) {
          for (const slot of rack.slots) {
            const bid = slot.bottle?._id || slot.bottle;
            if (bid && bid.toString() === bottleId) {
              setRackInfo({ rackId: rack._id, rackName: rack.name, position: slot.position });
              return;
            }
          }
        }
      }
    } catch {}
  };

  const handleBottleUpdated = (updated) => {
    setBottle(updated);
    setEditing(false);
  };

  const handleConsumeConfirm = async (reason, note, rating) => {
    try {
      const res = await apiFetch(`/api/bottles/${bottleId}/consume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason, note, rating })
      });
      const data = await res.json();
      if (res.ok) {
        navigate(`/cellars/${cellarId}`);
      } else {
        alert(data.error || 'Failed to remove bottle');
      }
    } catch {
      alert('Network error');
    }
  };

  if (loading) return <div className="loading">{t('bottleDetail.loadingBottle')}</div>;
  if (error)   return <div className="alert alert-error">{error}</div>;

  const wine = bottle.wineDefinition;
  const drinkStatus = getDrinkStatus(bottle);

  return (
    <div className="bottle-detail-page">
      <Link to={`/cellars/${cellarId}`} className="back-link">{t('bottleDetail.backToCellar')}</Link>

      {/* Wine header */}
      <div className="bd-wine-header card">
        <div className="bd-wine-identity">
          {(pendingImage || wine?.image) ? (
            <div className="bd-wine-image-wrap">
              <img
                src={pendingImage || wine.image}
                alt={wine?.name}
                className="bd-wine-image"
                onError={e => { e.target.style.display = 'none'; }}
              />
              {pendingImage && !wine?.image && (
                <span className="bd-pending-badge">{t('bottleDetail.pendingReview', 'Pending review')}</span>
              )}
            </div>
          ) : (
            <div className={`bd-wine-placeholder ${wine?.type}`} />
          )}
          <div className="bd-wine-meta">
            <h1 style={cellarColor ? { borderLeft: `4px solid ${cellarColor}`, paddingLeft: '0.75rem' } : {}}>
              {wine?.name || t('common.unknownWine')}
            </h1>
            <p className="bd-producer">
              {wine?.producer}
              {wine?.country?.name && <span className="bd-country"> · {wine.country.name}</span>}
            </p>
            {wine?.type && (
              <span className={`wine-type-pill ${wine.type}`}>{wine.type}</span>
            )}
          </div>
        </div>
      </div>

      {/* Bottle details or edit form */}
      {editing ? (
        <EditForm
          bottle={bottle}
          onSaved={handleBottleUpdated}
          onCancel={() => setEditing(false)}
          onImageUploaded={(url) => setPendingImage(url)}
        />
      ) : (
        <ViewDetails
          bottle={bottle}
          rackInfo={rackInfo}
          cellarId={cellarId}
          drinkStatus={drinkStatus}
          vintageProfile={vintageProfile}
          priceHistory={priceHistory}
          rates={rates}
          userCurrency={user?.preferences?.currency || 'USD'}
          canEdit={userRole === 'owner' || userRole === 'editor'}
          onEdit={() => setEditing(true)}
          onRemove={() => setConsumeOpen(true)}
        />
      )}

      {consumeOpen && (
        <ConsumeModal
          wineName={wine?.name}
          onConfirm={handleConsumeConfirm}
          onCancel={() => setConsumeOpen(false)}
        />
      )}
    </div>
  );
}

// ── View mode ──
function ViewDetails({ bottle, rackInfo, cellarId, drinkStatus, vintageProfile, priceHistory, rates, userCurrency, canEdit, onEdit, onRemove }) {
  const { t } = useTranslation();
  const { plan, hasFeature } = usePlan();
  const hasAgingMaturity = hasFeature('agingMaturity');
  const hasPriceEvolution = hasFeature('priceEvolution');
  const maturityStatus = getMaturityStatus(vintageProfile);

  return (
    <div className="bd-details card">
      <div className="bd-detail-grid">
        <div className="bd-detail-item">
          <span className="bd-detail-label">{t('bottleDetail.vintage')}</span>
          <span className="bd-detail-value">{bottle.vintage}</span>
        </div>
        {bottle.bottleSize && (
          <div className="bd-detail-item">
            <span className="bd-detail-label">{t('bottleDetail.size')}</span>
            <span className="bd-detail-value">{bottle.bottleSize}</span>
          </div>
        )}
        {bottle.rating && (
          <div className="bd-detail-item">
            <span className="bd-detail-label">{t('bottleDetail.ratingLabel')}</span>
            <span className="bd-detail-value">{'⭐'.repeat(bottle.rating)}</span>
          </div>
        )}
        {bottle.price && (
          <div className="bd-detail-item">
            <span className="bd-detail-label">{t('bottleDetail.pricePaid')}</span>
            <span className="bd-detail-value">
              {bottle.price} {bottle.currency}
              {(() => {
                const c = convertAmountHistorical(bottle.price, bottle.currency, userCurrency, bottle.priceCurrencyRates, rates);
                return c !== null ? (
                  <span
                    className="bd-detail-converted"
                    title={t('bottleDetail.priceAtEntryTooltip')}
                  > ≈ {c.toLocaleString()} {userCurrency}</span>
                ) : null;
              })()}
            </span>
          </div>
        )}
      </div>

      {/* Sommelier maturity section — premium feature, not shown for NV */}
      {bottle.vintage && bottle.vintage !== 'NV' && (
        <div className="bd-section">
          <span className="bd-section-label">{t('bottleDetail.sommMaturity')}</span>
          {hasAgingMaturity ? (
            !vintageProfile ? (
              <span className="bd-no-dates">{t('bottleDetail.loadingMaturity')}</span>
            ) : vintageProfile.status === 'pending' ? (
              <div className="bd-maturity-pending">
                <span className="maturity-badge maturity-badge--pending">{t('bottleDetail.awaitingSommelier')}</span>
                <span className="bd-maturity-note">
                  {t('bottleDetail.sommelierWillSet')}
                </span>
              </div>
            ) : (
              <div className="bd-maturity-reviewed">
                {maturityStatus && (
                  <span className={`maturity-badge maturity-badge--${maturityStatus.status}`}>
                    {maturityStatus.label}
                  </span>
                )}
                <MaturityPhaseTable profile={vintageProfile} />
                {vintageProfile.sommNotes && (
                  <p className="bd-maturity-notes">{vintageProfile.sommNotes}</p>
                )}
              </div>
            )
          ) : (
            <div className="bd-price-evolution bd-price-evolution--locked">
              <span className="bd-price-evolution__icon">🔒</span>
              <div>
                <strong>{t('bottleDetail.premiumFeature')}</strong>
                <p>{t('bottleDetail.agingMaturityPremiumDesc')}</p>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Drink window */}
      <div className="bd-section">
        <span className="bd-section-label">{t('bottleDetail.drinkWindow')}</span>
        <div className="bd-drink-window">
          {(bottle.drinkFrom || bottle.drinkBefore) ? (
            <span className="bd-drink-dates">
              {formatDrinkDate(bottle.drinkFrom)}
              {bottle.drinkFrom && bottle.drinkBefore && ' — '}
              {formatDrinkDate(bottle.drinkBefore)}
            </span>
          ) : (
            <span className="bd-no-dates">{t('bottleDetail.notSet')}</span>
          )}
          {drinkStatus && (
            <span className={`drink-status-badge ${drinkStatus.status}`}>
              {drinkStatus.label}
            </span>
          )}
        </div>
      </div>

      {/* Rack location */}
      {rackInfo && (
        <div className="bd-section">
          <span className="bd-section-label">{t('bottleDetail.rackLocation')}</span>
          <Link
            to={`/cellars/${cellarId}/racks?highlight=${bottle._id}`}
            className="bd-rack-link"
          >
            📍 {rackInfo.rackName} · {t('bottleDetail.rackSlot')} {rackInfo.position}
          </Link>
        </div>
      )}

      {/* Notes */}
      {bottle.notes && (
        <div className="bd-section">
          <span className="bd-section-label">{t('common.notes')}</span>
          <p className="bd-notes">{bottle.notes}</p>
        </div>
      )}

      {/* Purchase info */}
      {(bottle.purchaseDate || bottle.purchaseLocation || bottle.purchaseUrl) && (
        <div className="bd-section">
          <span className="bd-section-label">{t('bottleDetail.purchase')}</span>
          <div className="bd-purchase">
            {bottle.purchaseDate && (
              <span>{new Date(bottle.purchaseDate).toLocaleDateString()}</span>
            )}
            {bottle.purchaseLocation && <span>{bottle.purchaseLocation}</span>}
            {bottle.purchaseUrl && (
              <a href={bottle.purchaseUrl} target="_blank" rel="noreferrer" className="bd-purchase-link">
                🔗 Link
              </a>
            )}
          </div>
        </div>
      )}

      {/* Price Evolution — premium feature, not shown for NV */}
      {bottle.vintage !== 'NV' && (
        <div className="bd-section">
          <span className="bd-section-label">{t('bottleDetail.priceEvolution')}</span>
          {hasPriceEvolution ? (
            <PriceHistoryTimeline history={priceHistory} rates={rates} userCurrency={userCurrency} />
          ) : (
            <div className="bd-price-evolution bd-price-evolution--locked">
              <span className="bd-price-evolution__icon">🔒</span>
              <div>
                <strong>{t('bottleDetail.premiumFeature')}</strong>
                <p>{t('bottleDetail.premiumFeatureDesc')}</p>
              </div>
            </div>
          )}
        </div>
      )}

      {canEdit && (
        <div className="bd-actions">
          <button className="btn btn-secondary" onClick={onEdit}>{t('bottleDetail.editDetails')}</button>
          <button className="btn btn-consume" onClick={onRemove}>{t('bottleDetail.removeBottle')}</button>
        </div>
      )}
    </div>
  );
}

// ── Edit form ──
const API_URL = process.env.REACT_APP_API_URL || '';

function EditForm({ bottle, onSaved, onCancel, onImageUploaded }) {
  const { t } = useTranslation();
  const { apiFetch } = useAuth();
  const [form, setForm] = useState({
    vintage:          bottle.vintage || '',
    rating:           bottle.rating  || '',
    drinkFrom:        toMonthInput(bottle.drinkFrom),
    drinkBefore:      toMonthInput(bottle.drinkBefore),
    notes:            bottle.notes   || '',
    price:            bottle.price   || '',
    currency:         bottle.currency || 'USD',
    bottleSize:       bottle.bottleSize || '750ml',
    purchaseDate:     toInputDate(bottle.purchaseDate),
    purchaseLocation: bottle.purchaseLocation || '',
    purchaseUrl:      bottle.purchaseUrl || '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState(null);

  const hasWineImage = !!bottle.wineDefinition?.image;

  const set = (field) => (e) => setForm(f => ({ ...f, [field]: e.target.value }));

  const handleSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/bottles/${bottle._id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
          price:  form.price  ? parseFloat(form.price)  : null,
          rating: form.rating ? parseInt(form.rating)   : null,
          drinkFrom:    form.drinkFrom   ? `${form.drinkFrom}-01`         : null,
          drinkBefore:  form.drinkBefore ? monthToLastDay(form.drinkBefore) : null,
          purchaseDate: form.purchaseDate || null,
        })
      });
      const data = await res.json();
      if (res.ok) onSaved(data.bottle);
      else setError(data.error || 'Failed to save');
    } catch {
      setError('Network error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="bd-edit-form card" onSubmit={handleSave}>
      <h2>{t('bottleDetail.editBottleTitle')}</h2>
      {error && <div className="alert alert-error">{error}</div>}

      <div className="bd-edit-grid">
        <div className="form-group">
          <label>{t('bottleDetail.vintage')}</label>
          <input type="text" value={form.vintage} onChange={set('vintage')} placeholder={t('bottleDetail.vintagePlaceholder')} />
        </div>

        <div className="form-group">
          <label>{t('bottleDetail.ratingLabel')}</label>
          <select value={form.rating} onChange={set('rating')}>
            <option value="">{t('common.noRating')}</option>
            <option value="5">⭐⭐⭐⭐⭐ 5 stars</option>
            <option value="4">⭐⭐⭐⭐ 4 stars</option>
            <option value="3">⭐⭐⭐ 3 stars</option>
            <option value="2">⭐⭐ 2 stars</option>
            <option value="1">⭐ 1 star</option>
          </select>
        </div>

        <div className="form-group">
          <label>{t('common.price')}</label>
          <input type="number" step="0.01" min="0" value={form.price} onChange={set('price')} placeholder="0.00" />
        </div>

        <div className="form-group">
          <label>{t('common.currency')}</label>
          <select value={form.currency} onChange={set('currency')}>
            <option>USD</option>
            <option>EUR</option>
            <option>GBP</option>
            <option>CAD</option>
          </select>
        </div>

        <div className="form-group">
          <label>{t('addBottle.bottleSize')}</label>
          <select value={form.bottleSize} onChange={set('bottleSize')}>
            <option>375ml (Half)</option>
            <option>750ml (Standard)</option>
            <option>1.5L (Magnum)</option>
            <option>3L (Double Magnum)</option>
          </select>
        </div>

        <div className="form-group">
          <label>{t('addBottle.purchaseDate')}</label>
          <input type="date" value={form.purchaseDate} onChange={set('purchaseDate')} />
        </div>
      </div>

      <div className="form-group drink-window-section">
        <label>{t('bottleDetail.drinkWindow')}</label>
        <div className="drink-window-fields">
          <div>
            <label className="sublabel">{t('addBottle.drinkFrom')}</label>
            <input type="month" value={form.drinkFrom} onChange={set('drinkFrom')} />
          </div>
          <div>
            <label className="sublabel">{t('addBottle.drinkBefore')}</label>
            <input type="month" value={form.drinkBefore} onChange={set('drinkBefore')} />
          </div>
        </div>
      </div>

      <div className="form-group">
        <label>{t('common.notes')}</label>
        <textarea value={form.notes} onChange={set('notes')} rows={4} placeholder={t('addBottle.notesPlaceholder')} />
      </div>

      <div className="form-group">
        <label>{t('addBottle.purchaseLocation')}</label>
        <input type="text" value={form.purchaseLocation} onChange={set('purchaseLocation')} placeholder={t('addBottle.purchaseLocationPlaceholder')} />
      </div>

      <div className="form-group">
        <label>{t('addBottle.purchaseUrl')}</label>
        <input type="url" value={form.purchaseUrl} onChange={set('purchaseUrl')} placeholder="https://…" />
      </div>

      {!hasWineImage && (
        <div className="form-group bd-image-section">
          <label>
            {t('bottleDetail.addWineImage', 'Wine Photo')}
            <span className="bd-label-optional"> ({t('common.optional', 'optional')})</span>
          </label>
          <ImageUpload
            bottleId={bottle._id}
            wineDefinitionId={bottle.wineDefinition?._id}
            onUploadComplete={(img) => {
              if (onImageUploaded && img?.originalUrl) {
                const url = img.originalUrl.startsWith('http')
                  ? img.originalUrl
                  : `${API_URL}${img.originalUrl}`;
                onImageUploaded(url);
              }
            }}
            onProcessingComplete={(url) => onImageUploaded?.(url)}
          />
          <p className="image-public-notice">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0, marginTop: '1px' }}>
              <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            {t('bottleDetail.imageNotice', 'Images are reviewed by an admin before being added to the shared wine registry, where they will be visible to all Cellarion users.')}
          </p>
        </div>
      )}

      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={saving}>
          {saving ? t('common.saving') : t('bottleDetail.saveChanges')}
        </button>
        <button type="button" className="btn btn-secondary" onClick={onCancel}>{t('common.cancel')}</button>
      </div>
    </form>
  );
}

// ── Consume modal ──
function ConsumeModal({ wineName, onConfirm, onCancel }) {
  const { t } = useTranslation();
  const [reason,  setReason]  = useState('drank');
  const [note,    setNote]    = useState('');
  const [rating,  setRating]  = useState('');
  const [saving,  setSaving]  = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    await onConfirm(reason, note || undefined, rating || undefined);
    setSaving(false);
  };

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-box" onClick={e => e.stopPropagation()}>
        <h2>{t('bottleDetail.removeBottleTitle')}</h2>
        {wineName && <p className="modal-wine-name">{wineName}</p>}
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>{t('common.reason')}</label>
            <select value={reason} onChange={e => setReason(e.target.value)}>
              <option value="drank">{t('bottleDetail.drinkReason')}</option>
              <option value="gifted">{t('bottleDetail.giftedReason')}</option>
              <option value="sold">{t('bottleDetail.soldReason')}</option>
              <option value="other">{t('bottleDetail.otherReason')}</option>
            </select>
          </div>
          {reason === 'drank' && (
            <div className="form-group">
              <label>{t('bottleDetail.ratingOptional')}</label>
              <select value={rating} onChange={e => setRating(e.target.value)}>
                <option value="">{t('bottleDetail.noRatingOption')}</option>
                <option value="1">⭐ 1 star</option>
                <option value="2">⭐⭐ 2 stars</option>
                <option value="3">⭐⭐⭐ 3 stars</option>
                <option value="4">⭐⭐⭐⭐ 4 stars</option>
                <option value="5">⭐⭐⭐⭐⭐ 5 stars</option>
              </select>
            </div>
          )}
          <div className="form-group">
            <label>{t('bottleDetail.noteOptional')}</label>
            <textarea
              value={note}
              onChange={e => setNote(e.target.value)}
              rows={3}
              placeholder={t('bottleDetail.notePlaceholder')}
            />
          </div>
          <div className="modal-actions">
            <button type="button" className="btn btn-secondary" onClick={onCancel}>{t('common.cancel')}</button>
            <button type="submit" className="btn btn-consume" disabled={saving}>
              {saving ? t('common.saving') : t('common.confirm')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── 3-phase maturity table shown on bottle detail ──
function MaturityPhaseTable({ profile }) {
  const { t } = useTranslation();
  const vintageInt = parseInt(profile.vintage);

  const phases = [
    {
      label: t('bottleDetail.maturityPhaseEarly'),
      cls:   'early',
      from:  profile.earlyFrom,
      until: profile.earlyUntil,
    },
    {
      label: t('bottleDetail.maturityPhasePeak'),
      cls:   'peak',
      from:  profile.peakFrom,
      until: profile.peakUntil,
    },
    {
      label: t('bottleDetail.maturityPhaseLate'),
      cls:   'late',
      from:  profile.lateFrom,
      until: profile.lateUntil,
    },
  ].filter(p => p.from || p.until);

  if (phases.length === 0) return null;

  return (
    <div className="bd-maturity-table">
      {phases.map(p => {
        const isActive = p.from && p.until
          ? CURRENT_YEAR >= p.from && CURRENT_YEAR <= p.until
          : p.from
            ? CURRENT_YEAR >= p.from
            : false;

        const yrsFrom  = p.from  && !isNaN(vintageInt) ? p.from  - vintageInt : null;
        const yrsUntil = p.until && !isNaN(vintageInt) ? p.until - vintageInt : null;

        return (
          <div key={p.cls} className={`bd-maturity-row ${isActive ? 'bd-maturity-row--active' : ''}`}>
            <div className={`bd-maturity-phase-dot bd-maturity-phase-dot--${p.cls}`} />
            <span className="bd-maturity-phase-name">{p.label}</span>
            <span className="bd-maturity-phase-range">
              {p.from && p.until ? `${p.from}–${p.until}` : p.from ? `from ${p.from}` : `until ${p.until}`}
            </span>
            {(yrsFrom !== null) && (
              <span className="bd-maturity-phase-yrs">
                {yrsUntil !== null ? `${yrsFrom}–${yrsUntil} yrs` : `${yrsFrom}+ yrs`}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Price history timeline (premium feature) ──
function timeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  if (days < 1)  return 'today';
  if (days < 7)  return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

function PriceHistoryTimeline({ history, rates, userCurrency }) {
  const { t } = useTranslation();
  if (history === null) {
    return <span className="bd-no-dates">{t('bottleDetail.loadingMaturity')}</span>;
  }
  if (history.length === 0) {
    return (
      <div className="bd-price-history-empty">
        <span className="bd-no-dates">{t('bottleDetail.noPriceData')}</span>
        <span className="bd-maturity-note">{t('bottleDetail.sommelierAddPricing')}</span>
      </div>
    );
  }

  const latest = history[0];
  const previous = history.length > 1 ? history[1] : null;
  let change = null;
  if (previous && previous.price !== 0) {
    const diff = latest.price - previous.price;
    const pct = ((diff / previous.price) * 100).toFixed(1);
    change = { diff, pct, up: diff >= 0 };
  }

  // Convert latest price using historically-anchored rates (rate at time of recording)
  const latestConverted = convertAmountHistorical(latest.price, latest.currency, userCurrency, latest.exchangeRates, rates);

  return (
    <div className="bd-price-history">
      <div className="bd-price-latest">
        <span className="bd-price-latest__amount">
          {latest.price.toLocaleString()} {latest.currency}
        </span>
        {latestConverted !== null && (
          <span className="bd-price-converted">≈ {latestConverted.toLocaleString()} {userCurrency}</span>
        )}
        {change && (
          <span className={`bd-price-change bd-price-change--${change.up ? 'up' : 'down'}`}>
            {change.up ? '↑' : '↓'} {Math.abs(change.diff).toFixed(2)} ({change.up ? '+' : ''}{change.pct}%)
          </span>
        )}
      </div>
      <div className="bd-price-latest__meta">
        {timeAgo(latest.setAt)}
        {latest.source && <> · <em>{latest.source}</em></>}
        {latest.setBy?.username && <> · {latest.setBy.username}</>}
      </div>

      {history.length > 1 && (
        <div className="bd-price-timeline">
          {history.slice(1).map((entry, i) => {
            const converted = convertAmountHistorical(entry.price, entry.currency, userCurrency, entry.exchangeRates, rates);
            return (
              <div key={i} className="bd-price-entry">
                <span className="bd-price-entry__price">{entry.price.toLocaleString()} {entry.currency}</span>
                {converted !== null && (
                  <span className="bd-price-entry__converted">≈ {converted.toLocaleString()} {userCurrency}</span>
                )}
                <span className="bd-price-entry__date">{timeAgo(entry.setAt)}</span>
                {entry.source && <span className="bd-price-entry__source">{entry.source}</span>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default BottleDetail;
