import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import './CellarScopePicker.css';

/**
 * Multi-select "which cellars am I looking at" control. Lets the user combine
 * several cellars into one searchable view (bottles + history). Default is the
 * cellar they're currently in; "Select all" / "This cellar only" are one-click
 * shortcuts. At least one cellar always stays selected.
 *
 * Props:
 *   cellars          – [{ _id, name, userColor }] all accessible cellars
 *   value            – string[] currently-selected cellar ids
 *   currentCellarId  – the cellar the user navigated into
 *   onChange(ids)    – called with the new selection (order follows `cellars`)
 */
export default function CellarScopePicker({ cellars, value, currentCellarId, onChange }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  const selected = new Set(value);
  const total = cellars.length;
  const isThisCellarOnly = value.length === 1 && value[0] === currentCellarId;
  const allSelected = total > 0 && value.length === total;

  const label = isThisCellarOnly
    ? t('cellarScope.thisCellar')
    : allSelected
      ? t('cellarScope.allCellars')
      : t('cellarScope.nCellars', { count: value.length });

  const emit = (idSet) => onChange(cellars.filter(c => idSet.has(c._id)).map(c => c._id));

  const toggle = (id) => {
    const next = new Set(selected);
    if (next.has(id)) {
      if (next.size === 1) return; // keep at least one selected
      next.delete(id);
    } else {
      next.add(id);
    }
    emit(next);
  };

  const selectAll = () => onChange(cellars.map(c => c._id));
  const thisOnly = () => onChange([currentCellarId]);

  return (
    <div className="cellar-scope">
      <button
        type="button"
        className={`cellar-scope-btn${!isThisCellarOnly ? ' cellar-scope-btn--active' : ''}`}
        onClick={() => setOpen(o => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={t('cellarScope.title')}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>
        </svg>
        <span className="cellar-scope-label">{label}</span>
        <svg className="cellar-scope-caret" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
      </button>

      {open && (
        <>
          <div className="cellar-scope-backdrop" onClick={() => setOpen(false)} aria-hidden="true" />
          <div className="cellar-scope-dropdown" role="menu">
            <div className="cellar-scope-quick">
              <button type="button" onClick={selectAll} disabled={allSelected}>
                {t('cellarScope.selectAll')}
              </button>
              <button type="button" onClick={thisOnly} disabled={isThisCellarOnly}>
                {t('cellarScope.thisCellarOnly')}
              </button>
            </div>
            <ul className="cellar-scope-list">
              {cellars.map(c => {
                const checked = selected.has(c._id);
                const lockOff = checked && selected.size === 1;
                return (
                  <li key={c._id}>
                    <label className={`cellar-scope-item${checked ? ' checked' : ''}${lockOff ? ' locked' : ''}`}>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={lockOff}
                        onChange={() => toggle(c._id)}
                      />
                      <span
                        className="cellar-scope-dot"
                        style={c.userColor ? { background: c.userColor } : undefined}
                        aria-hidden="true"
                      />
                      <span className="cellar-scope-name">{c.name}</span>
                      {c._id === currentCellarId && (
                        <span className="cellar-scope-current">{t('cellarScope.current')}</span>
                      )}
                    </label>
                  </li>
                );
              })}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}
