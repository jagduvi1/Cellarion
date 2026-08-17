import { useTranslation } from 'react-i18next';

// The one frontend copy of the shared type list (backend authority:
// utils/personalDataTypes.js TYPES) — both cards and the key-proposal
// modal import it from here so a 7th type lands everywhere at once.
export const TYPES = ['text', 'integer', 'decimal', 'boolean', 'date', 'enum'];

/**
 * The one display formatter for typed values: boolean → Yes/No, numeric →
 * value + the key's unit, everything else as-is. Shared by the personal-data
 * card and the wine-record section.
 */
export function formatTypedValue(keyDef, value, t) {
  if (value === null || value === undefined) return null;
  if (keyDef?.type === 'boolean') {
    return value ? t('personalData.yes', 'Yes') : t('personalData.no', 'No');
  }
  const s = String(value);
  return keyDef?.unit ? `${s} ${keyDef.unit}` : s;
}

/**
 * One value input driven by a typed key (#985/#986 shared type system):
 * text / integer / decimal (unit suffix) / boolean (yes-no select) /
 * date / enum (select of the key's options). Controlled: (value, onChange).
 * The backend re-validates against the key's stored type — this only shapes
 * the affordance.
 */
function TypedValueInput({ id, keyDef, value, onChange }) {
  const { t } = useTranslation();
  const type = keyDef?.type || 'text';

  if (type === 'boolean') {
    return (
      <select id={id} className="pd-select" value={value} onChange={(e) => onChange(e.target.value)} required>
        <option value="">{t('personalData.choose', 'Choose…')}</option>
        <option value="true">{t('personalData.yes', 'Yes')}</option>
        <option value="false">{t('personalData.no', 'No')}</option>
      </select>
    );
  }

  if (type === 'enum') {
    const options = keyDef?.enumOptions || [];
    return (
      <select id={id} className="pd-select" value={value} onChange={(e) => onChange(e.target.value)} required>
        <option value="">{t('personalData.choose', 'Choose…')}</option>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  }

  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <input
        id={id}
        type={type === 'date' ? 'date' : (type === 'integer' || type === 'decimal') ? 'number' : 'text'}
        step={type === 'decimal' ? 'any' : undefined}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        maxLength={type === 'text' ? 500 : undefined}
        required
        style={{ flex: 1 }}
      />
      {keyDef?.unit && (
        <span style={{ color: 'var(--color-text-muted)', fontSize: '0.85rem' }}>{keyDef.unit}</span>
      )}
    </span>
  );
}

export default TypedValueInput;
