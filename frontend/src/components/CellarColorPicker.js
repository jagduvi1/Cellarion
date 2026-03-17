import { CELLAR_COLORS } from '../utils/cellarColors';

/**
 * Swatch picker for cellar accent color.
 * Props:
 *   value    — currently selected hex string, or null
 *   onChange — called with hex string or null
 */
function CellarColorPicker({ value, onChange }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center' }}>
      {/* None option */}
      <button
        type="button"
        aria-label="No color"
        onClick={() => onChange(null)}
        style={{
          width: 28,
          height: 28,
          borderRadius: '50%',
          background: 'var(--color-surface)',
          border: '1px solid var(--color-border)',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--color-text-muted)',
          fontSize: '0.75rem',
          boxShadow: !value ? '0 0 0 2px var(--color-primary)' : 'none',
          flexShrink: 0
        }}
      >
        ✕
      </button>

      {CELLAR_COLORS.map(color => (
        <button
          key={color}
          type="button"
          aria-label={`Color ${color}`}
          onClick={() => onChange(color)}
          style={{
            width: 28,
            height: 28,
            borderRadius: '50%',
            background: color,
            border: 'none',
            cursor: 'pointer',
            boxShadow: value === color ? '0 0 0 2px var(--color-primary)' : 'none',
            flexShrink: 0
          }}
        />
      ))}
    </div>
  );
}

export default CellarColorPicker;
