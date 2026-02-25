import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useAuth, usePlan } from '../contexts/AuthContext';
import { getDrinkStatus, formatDrinkDate, toInputDate } from '../utils/drinkStatus';
import { fetchRates, convertAmount } from '../utils/currency';
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
  const { id: cellarId, bottleId } = useParams();
  const { token, user } = useAuth();
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

  const auth = () => ({ 'Authorization': `Bearer ${token}` });

  useEffect(() => {
    fetchBottle();
    fetchRackInfo();
  }, [bottleId]); // eslint-disable-line react-hooks/exhaustive-deps

  const fetchBottle = async () => {
    try {
      const res = await fetch(`/api/bottles/${bottleId}`, { headers: auth() });
      const data = await res.json();
      if (res.ok) {
        setBottle(data.bottle);
        setUserRole(data.userRole);
        setCellarColor(data.cellarColor || null);
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
      const res = await fetch(
        `/api/somm/maturity/lookup?wine=${wineId}&vintage=${vintage}`,
        { headers: auth() }
      );
      const data = await res.json();
      if (res.ok) setVintageProfile(data.profile);
    } catch {
      // Non-critical — silently ignore
    }
  };

  const fetchPriceHistory = async (wineId, vintage) => {
    try {
      const res = await fetch(
        `/api/somm/prices/lookup?wine=${wineId}&vintage=${vintage}`,
        { headers: auth() }
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
      const res = await fetch(`/api/racks?cellar=${cellarId}`, { headers: auth() });
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
      const res = await fetch(`/api/bottles/${bottleId}/consume`, {
        method: 'POST',
        headers: { ...auth(), 'Content-Type': 'application/json' },
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

  if (loading) return <div className="loading">Loading bottle...</div>;
  if (error)   return <div className="alert alert-error">{error}</div>;

  const wine = bottle.wineDefinition;
  const drinkStatus = getDrinkStatus(bottle);

  return (
    <div className="bottle-detail-page">
      <Link to={`/cellars/${cellarId}`} className="back-link">← Back to Cellar</Link>

      {/* Wine header */}
      <div className="bd-wine-header card">
        <div className="bd-wine-identity">
          {wine?.image ? (
            <img
              src={wine.image}
              alt={wine.name}
              className="bd-wine-image"
              onError={e => { e.target.style.display = 'none'; }}
            />
          ) : (
            <div className={`bd-wine-placeholder ${wine?.type}`} />
          )}
          <div className="bd-wine-meta">
            <h1 style={cellarColor ? { borderLeft: `4px solid ${cellarColor}`, paddingLeft: '0.75rem' } : {}}>
              {wine?.name || 'Unknown Wine'}
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
          token={token}
          onSaved={handleBottleUpdated}
          onCancel={() => setEditing(false)}
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
  const { plan, hasFeature } = usePlan();
  const hasPriceEvolution = hasFeature('priceEvolution');
  const maturityStatus = getMaturityStatus(vintageProfile);

  return (
    <div className="bd-details card">
      <div className="bd-detail-grid">
        <div className="bd-detail-item">
          <span className="bd-detail-label">Vintage</span>
          <span className="bd-detail-value">{bottle.vintage}</span>
        </div>
        {bottle.bottleSize && (
          <div className="bd-detail-item">
            <span className="bd-detail-label">Size</span>
            <span className="bd-detail-value">{bottle.bottleSize}</span>
          </div>
        )}
        {bottle.rating && (
          <div className="bd-detail-item">
            <span className="bd-detail-label">Rating</span>
            <span className="bd-detail-value">{'⭐'.repeat(bottle.rating)}</span>
          </div>
        )}
        {bottle.price && (
          <div className="bd-detail-item">
            <span className="bd-detail-label">Price paid</span>
            <span className="bd-detail-value">
              {bottle.price} {bottle.currency}
              {(() => {
                const c = convertAmount(bottle.price, bottle.currency, userCurrency, rates);
                return c !== null ? <span className="bd-detail-converted"> ≈ {c.toLocaleString()} {userCurrency}</span> : null;
              })()}
            </span>
          </div>
        )}
      </div>

      {/* Sommelier maturity section — shown when a profile exists for this wine+vintage */}
      {bottle.vintage && bottle.vintage !== 'NV' && (
        <div className="bd-section">
          <span className="bd-section-label">Sommelier Maturity</span>
          {!vintageProfile ? (
            <span className="bd-no-dates">Loading…</span>
          ) : vintageProfile.status === 'pending' ? (
            <div className="bd-maturity-pending">
              <span className="maturity-badge maturity-badge--pending">Awaiting sommelier review</span>
              <span className="bd-maturity-note">
                Our sommeliers will set the aging window for this vintage soon.
              </span>
            </div>
          ) : (
            <div className="bd-maturity-reviewed">
              {/* Current status badge */}
              {maturityStatus && (
                <span className={`maturity-badge maturity-badge--${maturityStatus.status}`}>
                  {maturityStatus.label}
                </span>
              )}

              {/* Phase table */}
              <MaturityPhaseTable profile={vintageProfile} />

              {vintageProfile.sommNotes && (
                <p className="bd-maturity-notes">{vintageProfile.sommNotes}</p>
              )}
              {vintageProfile.setBy && (
                <span className="bd-maturity-attribution">
                  — {vintageProfile.setBy.username}
                </span>
              )}
            </div>
          )}
        </div>
      )}

      {/* Drink window */}
      <div className="bd-section">
        <span className="bd-section-label">Drink Window</span>
        <div className="bd-drink-window">
          {(bottle.drinkFrom || bottle.drinkBefore) ? (
            <span className="bd-drink-dates">
              {formatDrinkDate(bottle.drinkFrom)}
              {bottle.drinkFrom && bottle.drinkBefore && ' — '}
              {formatDrinkDate(bottle.drinkBefore)}
            </span>
          ) : (
            <span className="bd-no-dates">Not set</span>
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
          <span className="bd-section-label">Rack Location</span>
          <Link
            to={`/cellars/${cellarId}/racks?highlight=${bottle._id}`}
            className="bd-rack-link"
          >
            📍 {rackInfo.rackName} · slot {rackInfo.position}
          </Link>
        </div>
      )}

      {/* Notes */}
      {bottle.notes && (
        <div className="bd-section">
          <span className="bd-section-label">Notes</span>
          <p className="bd-notes">{bottle.notes}</p>
        </div>
      )}

      {/* Purchase info */}
      {(bottle.purchaseDate || bottle.purchaseLocation || bottle.purchaseUrl) && (
        <div className="bd-section">
          <span className="bd-section-label">Purchase</span>
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
          <span className="bd-section-label">Price Evolution</span>
          {hasPriceEvolution ? (
            <PriceHistoryTimeline history={priceHistory} rates={rates} userCurrency={userCurrency} />
          ) : (
            <div className="bd-price-evolution bd-price-evolution--locked">
              <span className="bd-price-evolution__icon">🔒</span>
              <div>
                <strong>Premium feature</strong>
                <p>Track how the market value of this wine changes over time. Available on the Premium plan.</p>
              </div>
            </div>
          )}
        </div>
      )}

      {canEdit && (
        <div className="bd-actions">
          <button className="btn btn-secondary" onClick={onEdit}>✏️ Edit Details</button>
          <button className="btn btn-consume" onClick={onRemove}>🍷 Remove Bottle</button>
        </div>
      )}
    </div>
  );
}

// ── Edit form ──
function EditForm({ bottle, token, onSaved, onCancel }) {
  const [form, setForm] = useState({
    vintage:          bottle.vintage || '',
    rating:           bottle.rating  || '',
    drinkFrom:        toInputDate(bottle.drinkFrom),
    drinkBefore:      toInputDate(bottle.drinkBefore),
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

  const set = (field) => (e) => setForm(f => ({ ...f, [field]: e.target.value }));

  const handleSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/bottles/${bottle._id}`, {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
          price:  form.price  ? parseFloat(form.price)  : null,
          rating: form.rating ? parseInt(form.rating)   : null,
          drinkFrom:    form.drinkFrom    || null,
          drinkBefore:  form.drinkBefore  || null,
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
      <h2>Edit Bottle Details</h2>
      {error && <div className="alert alert-error">{error}</div>}

      <div className="bd-edit-grid">
        <div className="form-group">
          <label>Vintage</label>
          <input type="text" value={form.vintage} onChange={set('vintage')} placeholder="e.g. 2018 or NV" />
        </div>

        <div className="form-group">
          <label>Rating</label>
          <select value={form.rating} onChange={set('rating')}>
            <option value="">Not rated</option>
            <option value="5">⭐⭐⭐⭐⭐ 5 stars</option>
            <option value="4">⭐⭐⭐⭐ 4 stars</option>
            <option value="3">⭐⭐⭐ 3 stars</option>
            <option value="2">⭐⭐ 2 stars</option>
            <option value="1">⭐ 1 star</option>
          </select>
        </div>

        <div className="form-group">
          <label>Price</label>
          <input type="number" step="0.01" min="0" value={form.price} onChange={set('price')} placeholder="0.00" />
        </div>

        <div className="form-group">
          <label>Currency</label>
          <select value={form.currency} onChange={set('currency')}>
            <option>USD</option>
            <option>EUR</option>
            <option>GBP</option>
            <option>CAD</option>
          </select>
        </div>

        <div className="form-group">
          <label>Bottle Size</label>
          <select value={form.bottleSize} onChange={set('bottleSize')}>
            <option>375ml (Half)</option>
            <option>750ml (Standard)</option>
            <option>1.5L (Magnum)</option>
            <option>3L (Double Magnum)</option>
          </select>
        </div>

        <div className="form-group">
          <label>Purchase Date</label>
          <input type="date" value={form.purchaseDate} onChange={set('purchaseDate')} />
        </div>
      </div>

      <div className="form-group drink-window-section">
        <label>Drink Window</label>
        <div className="drink-window-fields">
          <div>
            <label className="sublabel">Drink From</label>
            <input type="date" value={form.drinkFrom} onChange={set('drinkFrom')} />
          </div>
          <div>
            <label className="sublabel">Drink Before</label>
            <input type="date" value={form.drinkBefore} onChange={set('drinkBefore')} />
          </div>
        </div>
      </div>

      <div className="form-group">
        <label>Notes</label>
        <textarea value={form.notes} onChange={set('notes')} rows={4} placeholder="Tasting notes, storage conditions…" />
      </div>

      <div className="form-group">
        <label>Purchase Location</label>
        <input type="text" value={form.purchaseLocation} onChange={set('purchaseLocation')} placeholder="Store or location" />
      </div>

      <div className="form-group">
        <label>Purchase URL</label>
        <input type="url" value={form.purchaseUrl} onChange={set('purchaseUrl')} placeholder="https://…" />
      </div>

      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={saving}>
          {saving ? 'Saving…' : 'Save Changes'}
        </button>
        <button type="button" className="btn btn-secondary" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

// ── Consume modal ──
function ConsumeModal({ wineName, onConfirm, onCancel }) {
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
        <h2>Remove Bottle</h2>
        {wineName && <p className="modal-wine-name">{wineName}</p>}
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>Reason</label>
            <select value={reason} onChange={e => setReason(e.target.value)}>
              <option value="drank">Drank it</option>
              <option value="gifted">Gifted</option>
              <option value="sold">Sold</option>
              <option value="other">Other</option>
            </select>
          </div>
          {reason === 'drank' && (
            <div className="form-group">
              <label>Rating (optional)</label>
              <select value={rating} onChange={e => setRating(e.target.value)}>
                <option value="">— no rating —</option>
                <option value="1">⭐ 1 star</option>
                <option value="2">⭐⭐ 2 stars</option>
                <option value="3">⭐⭐⭐ 3 stars</option>
                <option value="4">⭐⭐⭐⭐ 4 stars</option>
                <option value="5">⭐⭐⭐⭐⭐ 5 stars</option>
              </select>
            </div>
          )}
          <div className="form-group">
            <label>Note (optional)</label>
            <textarea
              value={note}
              onChange={e => setNote(e.target.value)}
              rows={3}
              placeholder="How was it? Any tasting notes?"
            />
          </div>
          <div className="modal-actions">
            <button type="button" className="btn btn-secondary" onClick={onCancel}>Cancel</button>
            <button type="submit" className="btn btn-consume" disabled={saving}>
              {saving ? 'Saving…' : 'Confirm'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── 3-phase maturity table shown on bottle detail ──
function MaturityPhaseTable({ profile }) {
  const vintageInt = parseInt(profile.vintage);

  const phases = [
    {
      label: 'Early drinking',
      cls:   'early',
      from:  profile.earlyFrom,
      until: profile.earlyUntil,
    },
    {
      label: 'Optimal maturity ⭐',
      cls:   'peak',
      from:  profile.peakFrom,
      until: profile.peakUntil,
    },
    {
      label: 'Late maturity',
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
  if (history === null) {
    return <span className="bd-no-dates">Loading…</span>;
  }
  if (history.length === 0) {
    return (
      <div className="bd-price-history-empty">
        <span className="bd-no-dates">No market price data yet.</span>
        <span className="bd-maturity-note">Our sommeliers will add pricing data for this vintage soon.</span>
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

  // Convert latest price to user's preferred currency (null if same or unavailable)
  const latestConverted = convertAmount(latest.price, latest.currency, userCurrency, rates);

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
            const converted = convertAmount(entry.price, entry.currency, userCurrency, rates);
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
