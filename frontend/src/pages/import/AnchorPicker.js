import { useTranslation } from 'react-i18next';

const ANCHOR_OPTIONS = [
  { value: 'top-left',     labelKey: 'importBottles.anchor.top-left',     subKey: 'importBottles.anchor.subDefault' },
  { value: 'top-right',    labelKey: 'importBottles.anchor.top-right',    subKey: null },
  { value: 'bottom-left',  labelKey: 'importBottles.anchor.bottom-left',  subKey: 'importBottles.anchor.subOeno' },
  { value: 'bottom-right', labelKey: 'importBottles.anchor.bottom-right', subKey: null },
];

export default function AnchorPicker({ value, onChange }) {
  const { t } = useTranslation();
  return (
    <div className="anchor-picker">
      <div className="anchor-picker-label">{t('importBottles.anchor.question')}</div>
      <div className="anchor-picker-grid">
        {ANCHOR_OPTIONS.map(opt => (
          <button
            key={opt.value}
            type="button"
            className={`anchor-btn anchor-btn-${opt.value} ${value === opt.value ? 'active' : ''}`}
            onClick={() => onChange(opt.value)}
          >
            <span className="anchor-dot" aria-hidden="true" />
            <span className="anchor-label">{t(opt.labelKey)}</span>
            {opt.subKey && <span className="anchor-sub">{t(opt.subKey)}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
