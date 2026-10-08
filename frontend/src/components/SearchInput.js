import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import './SearchInput.css';

/**
 * A search box with a clear (×) button once it holds text. The cellar and
 * history searches are kept with the cellar's filters, so a term typed last
 * visit is still there; the button clears it in one tap instead of deleting
 * it by hand. Clearing gives the field focus back so typing can continue.
 */
export default function SearchInput({ value, onChange, placeholder, ariaLabel, className = 'search-input' }) {
  const { t } = useTranslation();
  const inputRef = useRef(null);
  const hasText = typeof value === 'string' && value.length > 0;

  const clear = () => {
    onChange('');
    if (inputRef.current) inputRef.current.focus();
  };

  return (
    <div className="search-input-clearable">
      <input
        ref={inputRef}
        type="text"
        className={`${className}${hasText ? ' search-input-clearable__input--has-text' : ''}`}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Escape' && hasText) { e.preventDefault(); clear(); } }}
        aria-label={ariaLabel || placeholder}
      />
      {hasText && (
        <button
          type="button"
          className="search-input-clearable__clear"
          onClick={clear}
          aria-label={t('common.clearSearch')}
          title={t('common.clearSearch')}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
      )}
    </div>
  );
}
