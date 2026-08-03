import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { identifyWineByText } from '../api/wines';
import './WinePicker.css';

/**
 * Wine search picker for journal pairings.
 * Flow: type to search → your bottles + wine register → AI identify fallback
 *
 * READ-ONLY by design — this component must never create a registry wine, and
 * must not import findOrCreateWine. A journal pairing does not need a registry
 * id: journalOps keeps `wine` only when it is a valid id and stores `wineName`
 * unconditionally. The trigger here is free-text dinner notes with no
 * confirmation step, often for a wine the user doesn't own, fired before the
 * entry is even saved — so a minted row would frequently outlive a cancelled
 * form. Smart Search therefore resolves to an existing wine when there is one
 * and otherwise just fills the name.
 *
 * Props:
 *  - value:      { bottle, wine, wineName } — current selection
 *  - onChange:   (update) => void — called with { bottle, wine, wineName }
 *  - placeholder: input placeholder text
 */
export default function WinePicker({ value, onChange, placeholder }) {
  const { t } = useTranslation();
  const { apiFetch } = useAuth();
  const [query, setQuery] = useState(value?.wineName || '');
  const [results, setResults] = useState({ bottles: [], wines: [] });
  const [showResults, setShowResults] = useState(false);
  const [searching, setSearching] = useState(false);
  const [aiSearching, setAiSearching] = useState(false);
  const [aiError, setAiError] = useState(null);
  const [aiNote, setAiNote] = useState(null);
  const [selected, setSelected] = useState(!!(value?.bottle || value?.wine));
  const debounceRef = useRef(null);
  const wrapRef = useRef(null);

  // Close results on outside click
  useEffect(() => {
    const handler = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setShowResults(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Search as user types
  useEffect(() => {
    if (selected) return;
    if (!query.trim() || query.trim().length < 2) {
      setResults({ bottles: [], wines: [] });
      setShowResults(false);
      return;
    }

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await apiFetch(`/api/journal/wine-search?q=${encodeURIComponent(query.trim())}`);
        if (res.ok) {
          const data = await res.json();
          setResults(data);
          setShowResults(true);
        }
      } catch { /* ignore */ }
      setSearching(false);
    }, 300);

    return () => clearTimeout(debounceRef.current);
  }, [query, selected]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectBottle = (bottle) => {
    const name = `${bottle.wine.name}${bottle.vintage ? ` ${bottle.vintage}` : ''}`;
    setQuery(name);
    setSelected(true);
    setShowResults(false);
    onChange({ bottle: bottle._id, wine: bottle.wine._id, wineName: name });
  };

  const selectWine = (wine) => {
    setQuery(wine.name);
    setSelected(true);
    setShowResults(false);
    onChange({ bottle: null, wine: wine._id, wineName: wine.name });
  };

  const handleAiSearch = async () => {
    if (!query.trim()) return;
    setAiSearching(true);
    setAiError(null);
    setAiNote(null);
    try {
      const res = await identifyWineByText(apiFetch, query.trim());
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // Previously an `if (res.ok)` with no else: a 429 or 403 flipped the
        // button back with no feedback at all.
        setAiError(t('journal.aiFailed', 'Wine lookup is unavailable right now.'));
        return;
      }
      if (data.match?.wine) {
        selectWine(data.match.wine);
        return;
      }
      if (data.candidates?.length) {
        // Offer the existing registry rows as options instead of guessing.
        setResults(prev => ({ ...prev, wines: data.candidates.map(c => c.wine).filter(Boolean) }));
        setShowResults(true);
        return;
      }
      if (data.identified) {
        // Recognised but not in the registry: keep the name, create nothing.
        const label = [data.identified.producer, data.identified.name].filter(Boolean).join(' ');
        setQuery(label);
        setSelected(true);
        setShowResults(false);
        onChange({ bottle: null, wine: null, wineName: label });
        setAiNote(t('journal.aiNotInRegistry', "Not in the wine register — we'll save the name with your entry."));
        return;
      }
      setAiError(t('journal.aiNoResult', "Couldn't identify that wine. You can type the name yourself."));
    } catch {
      setAiError(t('journal.aiFailed', 'Wine lookup is unavailable right now.'));
    } finally {
      setAiSearching(false);
    }
  };

  const handleClear = () => {
    setQuery('');
    setSelected(false);
    setResults({ bottles: [], wines: [] });
    setAiError(null);
    setAiNote(null);
    onChange({ bottle: null, wine: null, wineName: '' });
  };

  const hasResults = results.bottles.length > 0 || results.wines.length > 0;
  const noResults = query.trim().length >= 2 && !searching && !hasResults && showResults;

  return (
    <div className="wine-picker" ref={wrapRef}>
      <div className="wine-picker__input-row">
        <input
          type="text"
          className="input wine-picker__input"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setSelected(false); setAiError(null); setAiNote(null); onChange({ bottle: null, wine: null, wineName: e.target.value }); }}
          onFocus={() => { if (hasResults && !selected) setShowResults(true); }}
          placeholder={placeholder || t('journal.winePlaceholder', 'Search wine...')}
          maxLength={200}
        />
        {selected && (
          <button type="button" className="wine-picker__clear" onClick={handleClear}>×</button>
        )}
      </div>

      {/* Smart Search found the wine but the registry doesn't have it — the
          name is kept with the entry and nothing is written. */}
      {aiNote && <p className="wine-picker__ai-note">{aiNote}</p>}

      {showResults && (
        <div className="wine-picker__dropdown">
          {/* Bottles from your cellar */}
          {results.bottles.length > 0 && (
            <>
              <div className="wine-picker__section-label">{t('journal.yourCellar', 'Your cellar')}</div>
              {results.bottles.map(b => (
                <button key={b._id} type="button" className="wine-picker__option" onClick={() => selectBottle(b)}>
                  <span className="wine-picker__option-icon">🍾</span>
                  <span className="wine-picker__option-text">
                    <strong>{b.wine.name}</strong>
                    {b.vintage && <span className="wine-picker__vintage"> {b.vintage}</span>}
                    {b.wine.producer && <span className="wine-picker__producer"> · {b.wine.producer}</span>}
                  </span>
                </button>
              ))}
            </>
          )}

          {/* Wines from register */}
          {results.wines.length > 0 && (
            <>
              <div className="wine-picker__section-label">{t('journal.wineRegister', 'Wine register')}</div>
              {results.wines.map(w => (
                <button key={w._id} type="button" className="wine-picker__option" onClick={() => selectWine(w)}>
                  <span className="wine-picker__option-icon">🍷</span>
                  <span className="wine-picker__option-text">
                    <strong>{w.name}</strong>
                    {w.producer && <span className="wine-picker__producer"> · {w.producer}</span>}
                  </span>
                </button>
              ))}
            </>
          )}

          {/* No results — offer AI search */}
          {noResults && (
            <div className="wine-picker__no-results">
              <p>{t('journal.noWineResults', 'No wines found')}</p>
              <button type="button" className="btn btn-small btn-primary" onClick={handleAiSearch} disabled={aiSearching}>
                {aiSearching ? t('journal.aiSearching', 'Searching...') : t('journal.aiSearch', 'Smart Search')}
              </button>
              {aiError && <p className="wine-picker__ai-error">{aiError}</p>}
            </div>
          )}

          {searching && (
            <div className="wine-picker__searching">{t('journal.searching', 'Searching...')}</div>
          )}
        </div>
      )}
    </div>
  );
}
