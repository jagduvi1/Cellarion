import { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../Modal';
import { computeLayout, computeModularLayout, SLOT_RADIUS } from '../../utils/rackLayouts';

const ZONE_PALETTE = ['#2E7D32', '#1565C0', '#C62828', '#6A1B9A', '#E65100', '#00838F', '#9E9D24', '#AD1457'];
const MAX_ZONES = 12;

/**
 * Zone editor — name colored areas of a rack and paint them onto the slots.
 * Select a zone in the list, then click slots on the map to add/remove them;
 * clicking a slot that belongs to another zone reassigns it (a position can
 * only be in one zone). Saved via PUT /api/racks/:id { zones }.
 */
export default function ZoneEditorModal({ rack, onSave, onClose }) {
  const { t } = useTranslation();
  const [zones, setZones] = useState(() =>
    (rack.zones || []).map(z => ({
      name: z.name,
      color: z.color || ZONE_PALETTE[0],
      positions: [...(z.positions || [])],
    }))
  );
  const [active, setActive] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const isModular = rack.isModular && rack.modules?.length > 0;
  const layout = useMemo(
    () => isModular
      ? computeModularLayout(rack.modules)
      : computeLayout(rack.type || 'grid', rack.rows, rack.cols, rack.typeConfig),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isModular, rack.modules, rack.type, rack.rows, rack.cols, rack.typeConfig]
  );
  const disabledSet = useMemo(() => new Set(rack.disabledPositions || []), [rack.disabledPositions]);

  const zoneByPos = useMemo(() => {
    const m = new Map();
    zones.forEach((z, i) => z.positions.forEach(p => m.set(p, i)));
    return m;
  }, [zones]);

  const togglePosition = (pos) => {
    if (disabledSet.has(pos) || zones.length === 0) return;
    const owner = zoneByPos.get(pos);
    setZones(prev => prev.map((z, i) => {
      let positions = z.positions;
      if (i === owner) positions = positions.filter(p => p !== pos);       // leave old zone (or toggle off)
      if (i === active && owner !== active) positions = [...positions, pos]; // join active zone
      return positions === z.positions ? z : { ...z, positions };
    }));
  };

  const addZone = () => {
    if (zones.length >= MAX_ZONES) return;
    setZones(prev => [...prev, { name: '', color: ZONE_PALETTE[prev.length % ZONE_PALETTE.length], positions: [] }]);
    setActive(zones.length);
  };

  const removeZone = (i) => {
    setZones(prev => prev.filter((_, j) => j !== i));
    setActive(a => (a > i ? a - 1 : Math.min(a, Math.max(0, zones.length - 2))));
  };

  const updateZone = (i, patch) => {
    setZones(prev => prev.map((z, j) => (j === i ? { ...z, ...patch } : z)));
  };

  const handleSave = async () => {
    if (zones.some(z => !z.name.trim() && z.positions.length > 0)) {
      setError(t('zones.nameMissing', 'Give every zone with slots a name (or remove it).'));
      return;
    }
    setSaving(true);
    setError(null);
    const cleaned = zones
      .filter(z => z.name.trim())
      .map(z => ({ name: z.name.trim(), color: z.color, positions: z.positions }));
    const ok = await onSave(cleaned);
    setSaving(false);
    if (ok) onClose();
    else setError(t('zones.saveError', 'Failed to save zones — please try again.'));
  };

  const R = SLOT_RADIUS;

  return (
    <Modal title={t('zones.title', 'Rack zones')} onClose={saving ? undefined : onClose} wide showClose={!saving}>
      <p className="zones-intro">
        {t('zones.intro', 'Name areas of this rack (“Whites”, “Bordeaux”…). Select a zone, then click slots on the map to paint them.')}
      </p>

      <div className="zones-list">
        {zones.map((z, i) => (
          <div key={i} className={`zones-row ${i === active ? 'active' : ''}`} onClick={() => setActive(i)}>
            <input
              type="radio"
              name="active-zone"
              checked={i === active}
              onChange={() => setActive(i)}
              aria-label={t('zones.selectZone', 'Select zone')}
            />
            <input
              type="color"
              className="zones-color"
              value={z.color}
              onChange={e => updateZone(i, { color: e.target.value })}
              aria-label={t('zones.color', 'Zone color')}
            />
            <input
              type="text"
              className="input zones-name"
              placeholder={t('zones.namePlaceholder', 'Zone name…')}
              value={z.name}
              maxLength={40}
              onChange={e => updateZone(i, { name: e.target.value })}
            />
            <span className="zones-count">{z.positions.length}</span>
            <button
              type="button"
              className="zones-remove"
              onClick={(e) => { e.stopPropagation(); removeZone(i); }}
              aria-label={t('common.delete', 'Delete')}
            >
              ×
            </button>
          </div>
        ))}
        {zones.length < MAX_ZONES && (
          <button type="button" className="btn btn-secondary btn-small" onClick={addZone}>
            + {t('zones.addZone', 'Add zone')}
          </button>
        )}
      </div>

      <div className="zones-map">
        <svg viewBox={`0 0 ${layout.viewBox.width} ${layout.viewBox.height}`} className="zones-map-svg">
          <rect x={1} y={1} width={layout.viewBox.width - 2} height={layout.viewBox.height - 2} rx={7}
            fill="var(--color-bg)" stroke="var(--color-border)" strokeWidth={1.5} />
          {layout.slots.map(({ position, cx, cy, isBack }) => {
            const r = isBack ? R * 0.7 : R;
            const zi = zoneByPos.get(position);
            const zone = zi !== undefined ? zones[zi] : null;
            const disabled = disabledSet.has(position);
            return (
              <g
                key={position}
                onClick={() => togglePosition(position)}
                style={{ cursor: disabled || zones.length === 0 ? 'default' : 'pointer' }}
              >
                <circle
                  cx={cx} cy={cy} r={r}
                  fill={disabled ? 'rgba(120,110,95,0.15)' : zone ? zone.color : 'transparent'}
                  fillOpacity={zone ? 0.8 : 1}
                  stroke={zi === active ? 'var(--color-text)' : 'var(--color-border)'}
                  strokeWidth={zi === active ? 2 : 1}
                  strokeDasharray={zone || disabled ? null : '3 2'}
                />
                {!disabled && (
                  <text x={cx} y={cy} textAnchor="middle" dominantBaseline="central"
                    fontSize={r * 0.6} fill={zone ? '#fff' : 'var(--color-text-muted)'} pointerEvents="none">
                    {position}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      <div className="modal-actions">
        <button className="btn btn-secondary" onClick={onClose} disabled={saving}>
          {t('common.cancel', 'Cancel')}
        </button>
        <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? t('common.saving', 'Saving...') : t('common.save', 'Save')}
        </button>
      </div>
    </Modal>
  );
}
