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
        title="No color"
        onClick={() => onChange(null)}
        style={{
          width: 28,
          height: 28,
          borderRadius: '50%',
          background: '#1c1c1c',
          border: '1px solid #3a3a3a',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#9A9484',
          fontSize: '0.75rem',
          boxShadow: !value ? '0 0 0 2px #fff' : 'none',
          flexShrink: 0
        }}
      >
        ✕
      </button>

      {CELLAR_COLORS.map(color => (
        <button
          key={color}
          type="button"
          title={color}
          onClick={() => onChange(color)}
          style={{
            width: 28,
            height: 28,
            borderRadius: '50%',
            background: color,
            border: 'none',
            cursor: 'pointer',
            boxShadow: value === color ? '0 0 0 2px #fff' : 'none',
            flexShrink: 0
          }}
        />
      ))}
    </div>
  );
}

export default CellarColorPicker;
