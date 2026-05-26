const ANCHOR_OPTIONS = [
  { value: 'top-left',     label: 'Top-left',     sub: 'Default for most apps' },
  { value: 'top-right',    label: 'Top-right',    sub: '' },
  { value: 'bottom-left',  label: 'Bottom-left',  sub: 'Oeno / Vintec' },
  { value: 'bottom-right', label: 'Bottom-right', sub: '' },
];

export default function AnchorPicker({ value, onChange }) {
  return (
    <div className="anchor-picker">
      <div className="anchor-picker-label">Where does slot 1 sit in your physical rack?</div>
      <div className="anchor-picker-grid">
        {ANCHOR_OPTIONS.map(opt => (
          <button
            key={opt.value}
            type="button"
            className={`anchor-btn anchor-btn-${opt.value} ${value === opt.value ? 'active' : ''}`}
            onClick={() => onChange(opt.value)}
          >
            <span className="anchor-dot" aria-hidden="true" />
            <span className="anchor-label">{opt.label}</span>
            {opt.sub && <span className="anchor-sub">{opt.sub}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
