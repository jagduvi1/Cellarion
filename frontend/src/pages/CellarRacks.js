import { useState, useEffect, useMemo } from 'react';
import { useParams, Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { getCellar } from '../api/cellars';
import { getRacks, deleteRack, updateSlot, clearSlot } from '../api/racks';
import { consumeBottle } from '../api/bottles';
import RatingInput from '../components/RatingInput';
import './CellarRacks.css';

function CellarRacks() {
  const { t } = useTranslation();
  const { id } = useParams();
  const { apiFetch, user } = useAuth();
  const [searchParams] = useSearchParams();
  const highlightBottleId = searchParams.get('highlight');
  const [highlightPos, setHighlightPos] = useState(null); // { rackId, position }

  const [cellar, setCellar]   = useState(null);
  const [racks, setRacks]     = useState([]);
  const [bottles, setBottles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);

  // "new rack" form
  const [showNewRack, setShowNewRack] = useState(false);
  const [newRack, setNewRack]         = useState({ name: '', rows: 4, cols: 8 });
  const [saving, setSaving]           = useState(false);

  // which rack tab is selected
  const [selectedRackId, setSelectedRackId] = useState(null);

  // active popup: { rackId, position, slot: slotData|null } — rendered as fixed modal
  const [activePopup, setActivePopup] = useState(null);

  // consume modal: { bottleId } or null
  const [consumeModal, setConsumeModal] = useState(null);

  useEffect(() => {
    fetchAll();
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  // When racks load and a highlight param is set, find and select that slot
  useEffect(() => {
    if (!highlightBottleId || racks.length === 0) return;
    for (const rack of racks) {
      const slot = rack.slots.find(s => {
        const bid = s.bottle?._id || s.bottle;
        return bid && bid.toString() === highlightBottleId;
      });
      if (slot) {
        setSelectedRackId(rack._id);
        setHighlightPos({ rackId: rack._id, position: slot.position });
        return;
      }
    }
  }, [highlightBottleId, racks]); // eslint-disable-line react-hooks/exhaustive-deps

  // Compute set of bottle IDs already placed in any rack
  const placedBottleIds = useMemo(() => {
    const ids = new Set();
    racks.forEach(rack => rack.slots.forEach(s => {
      if (s.bottle?._id) ids.add(s.bottle._id);
    }));
    return ids;
  }, [racks]);

  // Bottles available for placement (not in any rack)
  const availableBottles = useMemo(
    () => bottles.filter(b => !placedBottleIds.has(b._id)),
    [bottles, placedBottleIds]
  );


  const fetchAll = async () => {
    try {
      const [cellarRes, racksRes] = await Promise.all([
        getCellar(apiFetch, id),
        getRacks(apiFetch, id)
      ]);
      const cellarData = await cellarRes.json();
      const racksData  = await racksRes.json();

      if (!cellarRes.ok) { setError(cellarData.error || 'Failed to load cellar'); return; }
      if (!racksRes.ok)  { setError(racksData.error  || 'Failed to load racks');  return; }

      setCellar(cellarData.cellar);
      const loadedRacks = racksData.racks || [];
      setRacks(loadedRacks);
      setBottles(cellarData.bottles?.items || []);
      if (loadedRacks.length > 0) setSelectedRackId(r => r || loadedRacks[0]._id);
    } catch {
      setError('Network error');
    } finally {
      setLoading(false);
    }
  };

  // --- create rack ---
  const handleCreateRack = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await apiFetch('/api/racks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cellar: id, ...newRack })
      });
      const data = await res.json();
      if (res.ok) {
        setRacks([...racks, data.rack]);
        setSelectedRackId(data.rack._id);
        setNewRack({ name: '', rows: 4, cols: 8 });
        setShowNewRack(false);
      } else {
        alert(data.error || 'Failed to create rack');
      }
    } finally {
      setSaving(false);
    }
  };

  // --- delete rack ---
  const handleDeleteRack = async (rackId) => {
    if (!window.confirm(t('racks.deleteRackConfirm'))) return;
    const res = await deleteRack(apiFetch, rackId);
    if (res.ok) {
      const remaining = racks.filter(r => r._id !== rackId);
      setRacks(remaining);
      if (selectedRackId === rackId) {
        setSelectedRackId(remaining.length > 0 ? remaining[0]._id : null);
      }
    }
  };

  // --- assign bottle to slot ---
  const handleAssign = async (rackId, position, bottleId) => {
    const res = await updateSlot(apiFetch, rackId, position, { bottleId });
    const data = await res.json();
    if (res.ok) {
      setRacks(racks.map(r => r._id === rackId ? data.rack : r));
    } else {
      alert(data.error || 'Failed to assign');
    }
    setActivePopup(null);
  };

  // --- remove bottle from slot (keep bottle in cellar) ---
  const handleRemoveFromRack = async (rackId, position) => {
    const res = await clearSlot(apiFetch, rackId, position);
    const data = await res.json();
    if (res.ok) {
      setRacks(racks.map(r => r._id === rackId ? data.rack : r));
    }
    setActivePopup(null);
  };

  // --- soft-remove bottle via the shared consume endpoint ---
  const handleConsumeSubmit = async (reason, note, rating, consumedRatingScale) => {
    const { bottleId } = consumeModal;
    const res = await consumeBottle(apiFetch, bottleId, { reason, note, rating, consumedRatingScale });
    const data = await res.json();
    if (res.ok) {
      // Server already cleared the rack slot; update local racks state
      setRacks(prev => prev.map(r => ({
        ...r,
        slots: r.slots.filter(s => {
          const bid = s.bottle?._id || s.bottle;
          return bid?.toString() !== bottleId;
        })
      })));
      // Remove from available bottles list
      setBottles(prev => prev.filter(b => b._id !== bottleId));
      setConsumeModal(null);
    } else {
      alert(data.error || 'Failed to remove bottle');
    }
  };

  if (loading) return <div className="loading">{t('racks.loadingRacks')}</div>;
  if (error)   return <div className="alert alert-error">{error}</div>;

  const rack = racks.find(r => r._id === selectedRackId) || racks[0];
  const canEdit = cellar?.userRole !== 'viewer';

  return (
    <div className="cellar-racks-page">
      <div className="page-header">
        <div>
          <Link to={`/cellars/${id}`} className="back-link">{t('racks.backToCellar')}</Link>
          <h1 style={cellar?.userColor ? { borderLeft: `4px solid ${cellar.userColor}`, paddingLeft: '0.75rem' } : {}}>
            {cellar?.name}
          </h1>
          <p className="cellar-description">{t('racks.title')}</p>
        </div>
        {canEdit && (
          <button className="btn btn-primary" onClick={() => setShowNewRack(v => !v)}>
            {showNewRack ? t('common.cancel') : t('racks.newRack')}
          </button>
        )}
      </div>

      {canEdit && showNewRack && (
        <form className="card new-rack-form" onSubmit={handleCreateRack}>
          <h3>{t('racks.newRackTitle')}</h3>
          <div className="new-rack-fields">
            <div className="form-group">
              <label>{t('racks.nameLabel')}</label>
              <input
                type="text"
                value={newRack.name}
                onChange={e => setNewRack({ ...newRack, name: e.target.value })}
                placeholder={t('racks.namePlaceholder')}
                required
              />
            </div>
            <div className="form-group">
              <label>{t('racks.rowsLabel')}</label>
              <input
                type="number"
                min={1} max={20}
                value={newRack.rows}
                onChange={e => setNewRack({ ...newRack, rows: parseInt(e.target.value) || 4 })}
              />
            </div>
            <div className="form-group">
              <label>{t('racks.colsLabel')}</label>
              <input
                type="number"
                min={1} max={20}
                value={newRack.cols}
                onChange={e => setNewRack({ ...newRack, cols: parseInt(e.target.value) || 8 })}
              />
            </div>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? t('racks.creating') : t('racks.createRack')}
            </button>
          </div>
        </form>
      )}

      {racks.length === 0 ? (
        <div className="empty-state">
          <p>{t('racks.noRacks')}</p>
        </div>
      ) : (
        <>
          <div className="rack-tabs">
            {racks.map(r => (
              <button
                key={r._id}
                className={`rack-tab ${r._id === rack._id ? 'active' : ''}`}
                onClick={() => { setSelectedRackId(r._id); setActivePopup(null); }}
              >
                {r.name}
                <span className="rack-tab-count">{r.slots.length}/{r.rows * r.cols}</span>
              </button>
            ))}
          </div>
          <RackGrid
            rack={rack}
            canEdit={canEdit}
            activeRackId={activePopup?.rackId}
            activePosition={activePopup?.position}
            highlightPos={highlightPos?.rackId === rack._id ? highlightPos.position : null}
            onSlotClick={(pos, slotData) => {
              // Viewers can only inspect filled slots, not interact with empty ones
              if (!canEdit && !slotData) return;
              if (activePopup?.rackId === rack._id && activePopup?.position === pos) {
                setActivePopup(null);
              } else {
                setActivePopup({ rackId: rack._id, position: pos, slot: slotData || null });
              }
            }}
            onDelete={() => handleDeleteRack(rack._id)}
          />
        </>
      )}

      {/* Page-level fixed slot modal */}
      {activePopup && (
        <div className="slot-modal-overlay" onClick={() => setActivePopup(null)}>
          <div className="slot-modal" onClick={e => e.stopPropagation()}>
            {activePopup.slot ? (
              <FilledSlotContent
                position={activePopup.position}
                slot={activePopup.slot}
                canEdit={canEdit}
                onRemoveFromRack={() => handleRemoveFromRack(activePopup.rackId, activePopup.position)}
                onConsume={() => {
                  setConsumeModal({ bottleId: activePopup.slot.bottle._id });
                  setActivePopup(null);
                }}
                onClose={() => setActivePopup(null)}
              />
            ) : (
              <EmptySlotContent
                position={activePopup.position}
                bottles={availableBottles}
                onAssign={(pos, bottleId) => handleAssign(activePopup.rackId, pos, bottleId)}
                onClose={() => setActivePopup(null)}
              />
            )}
          </div>
        </div>
      )}

      {/* Consume/remove modal */}
      {consumeModal && (
        <ConsumeModal
          defaultRatingScale={user?.preferences?.ratingScale || '5'}
          onSubmit={handleConsumeSubmit}
          onCancel={() => setConsumeModal(null)}
        />
      )}
    </div>
  );
}

// ---- Sub-component: rack grid (no popup rendering, just slots) ----
function RackGrid({ rack, canEdit, activeRackId, activePosition, highlightPos, onSlotClick, onDelete }) {
  const { t } = useTranslation();
  const total = rack.rows * rack.cols;

  const slotMap = {};
  rack.slots.forEach(s => { slotMap[s.position] = s; });

  const activePos = activeRackId === rack._id ? activePosition : null;

  return (
    <div className="rack-container card">
      <div className="rack-header">
        <div>
          <h2>{rack.name}</h2>
          <span className="rack-dims">{rack.rows} rows &times; {rack.cols} cols &mdash; {rack.slots.length}/{total} filled</span>
        </div>
        {canEdit && <button className="btn btn-danger btn-small" onClick={onDelete}>{t('racks.deleteRack')}</button>}
      </div>

      <div
        className="rack-grid"
        style={{ gridTemplateColumns: `repeat(${rack.cols}, 44px)` }}
      >
        {Array.from({ length: total }, (_, i) => {
          const pos  = i + 1;
          const slot = slotMap[pos];
          const wine = slot?.bottle?.wineDefinition;
          const wineType = wine?.type || 'red';
          const isOpen = activePos === pos;
          const isHighlighted = highlightPos === pos;

          return (
            <div
              key={pos}
              className={`rack-slot ${slot ? `filled type-${wineType}` : 'empty'} ${isOpen ? 'active' : ''} ${isHighlighted ? 'highlighted' : ''}`}
              onClick={() => onSlotClick(pos, slot || null)}
              title={slot ? `${wine?.name || '?'} (${slot.bottle?.vintage || ''})` : `Empty slot ${pos}`}
            >
              {!slot && <span className="slot-num">{pos}</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---- Content for empty slot: pick a bottle to place ----
function EmptySlotContent({ position, bottles, onAssign, onClose }) {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');

  const filtered = bottles.filter(b => {
    if (!search) return true;
    const term = search.toLowerCase();
    const name = (b.wineDefinition?.name || '').toLowerCase();
    const producer = (b.wineDefinition?.producer || '').toLowerCase();
    return name.includes(term) || producer.includes(term);
  });

  return (
    <>
      <div className="slot-popup-header">
        <span className="slot-popup-title">{t('racks.slotPlaceBottle', { position })}</span>
        <button className="slot-popup-close" onClick={onClose}>&times;</button>
      </div>
      <input
        type="text"
        className="slot-search"
        placeholder={t('racks.searchWines')}
        value={search}
        onChange={e => setSearch(e.target.value)}
        autoFocus
      />
      <div className="slot-bottle-list">
        {filtered.length === 0 ? (
          <p className="slot-empty-msg">{t('racks.noUnplacedBottles')}</p>
        ) : (
          filtered.map(b => (
            <div
              key={b._id}
              className="slot-bottle-item"
              onClick={() => onAssign(position, b._id)}
            >
              <span className={`slot-bottle-type-dot type-${b.wineDefinition?.type || 'red'}`} />
              <div className="slot-bottle-info">
                <strong>{b.wineDefinition?.name || 'Unknown'}</strong>
                <span className="slot-bottle-meta">
                  {b.wineDefinition?.producer} &middot; {b.vintage}
                  {b.wineDefinition?.country?.name ? ` \u00B7 ${b.wineDefinition.country.name}` : ''}
                </span>
              </div>
            </div>
          ))
        )}
      </div>
    </>
  );
}

// ---- Content for filled slot: show bottle info + actions ----
function FilledSlotContent({ position, slot, canEdit, onRemoveFromRack, onConsume, onClose }) {
  const { t } = useTranslation();
  const bottle = slot.bottle;
  const wine = bottle?.wineDefinition;

  return (
    <>
      <div className="slot-popup-header">
        <span className="slot-popup-title">{t('racks.slotTitle', { position })}</span>
        <button className="slot-popup-close" onClick={onClose}>&times;</button>
      </div>

      <div className="slot-bottle-detail">
        {wine?.image && (
          <img src={wine.image} alt={wine.name} className="slot-detail-img" onError={e => e.target.style.display = 'none'} />
        )}
        <div className="slot-detail-info">
          <h4>{wine?.name || 'Unknown'}</h4>
          {wine?.producer && <p className="slot-detail-producer">{wine.producer}</p>}
          <p className="slot-detail-meta">
            <span className={`slot-bottle-type-dot type-${wine?.type || 'red'}`} />
            {wine?.type} &middot; {bottle?.vintage}
          </p>
          {wine?.country?.name && (
            <p className="slot-detail-meta">
              {wine.country.name}{wine?.region?.name ? `, ${wine.region.name}` : ''}
            </p>
          )}
          {bottle?.notes && <p className="slot-detail-notes">{bottle.notes}</p>}
        </div>
      </div>

      {canEdit && (
        <div className="slot-popup-actions">
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

// ---- Consume / remove modal ----
function ConsumeModal({ defaultRatingScale, onSubmit, onCancel }) {
  const { t } = useTranslation();
  const [reason,       setReason]      = useState('drank');
  const [note,         setNote]        = useState('');
  const [rating,       setRating]      = useState('');
  const [ratingScale,  setRatingScale] = useState(defaultRatingScale || '5');
  const [saving,       setSaving]      = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    await onSubmit(reason, note || undefined, rating || undefined, ratingScale);
    setSaving(false);
  };

  return (
    <div className="slot-modal-overlay" onClick={onCancel}>
      <div className="slot-modal consume-modal-box" onClick={e => e.stopPropagation()}>
        <div className="slot-popup-header">
          <span className="slot-popup-title">{t('bottleDetail.removeBottleTitle')}</span>
          <button className="slot-popup-close" onClick={onCancel}>&times;</button>
        </div>
        <form onSubmit={handleSubmit} className="consume-modal-form">
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
              <RatingInput
                value={rating}
                scale={ratingScale}
                onChange={v => setRating(v ?? '')}
                onScaleChange={s => { setRatingScale(s); setRating(''); }}
                allowScaleOverride
              />
            </div>
          )}
          <div className="form-group">
            <label>{t('bottleDetail.noteOptional')}</label>
            <textarea
              value={note}
              onChange={e => setNote(e.target.value)}
              rows={2}
              placeholder="How was it?"
            />
          </div>
          <div className="consume-modal-actions">
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

export default CellarRacks;
