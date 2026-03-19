import { useState, useEffect, useRef } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { searchWines } from '../api/wines';
import './WineSearchPicker.css';

/**
 * Compact wine search + select input.
 * Props:
 *   selected   – currently selected wine object (or null)
 *   onSelect   – callback(wine | null)
 *   placeholder – input placeholder text
 */
export default function WineSearchPicker({ selected, onSelect, placeholder = 'Search for a wine...' }) {
  const { apiFetch } = useAuth();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [noResults, setNoResults] = useState(false);
  const wrapperRef = useRef(null);
  const debounceRef = useRef(null);

  // Debounced search
  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      setNoResults(false);
      return;
    }

    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await searchWines(apiFetch, `search=${encodeURIComponent(query.trim())}&limit=8`);
        const data = await res.json();
        const wines = data.wines || [];
        setResults(wines);
        setNoResults(wines.length === 0);
        setOpen(true);
      } catch {
        setResults([]);
        setNoResults(false);
      } finally {
        setLoading(false);
      }
    }, 300);

    return () => clearTimeout(debounceRef.current);
  }, [query, apiFetch]);

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const handleSelect = (wine) => {
    onSelect(wine);
    setQuery('');
    setResults([]);
    setNoResults(false);
    setOpen(false);
  };

  const handleClear = () => {
    onSelect(null);
    setQuery('');
  };

  if (selected) {
    return (
      <div className="wine-search-picker__selected">
        <span className={`wine-search-picker__type-dot ${selected.type || ''}`} />
        <span className="wine-search-picker__selected-name">
          {selected.name}
          {selected.producer && <span className="wine-search-picker__selected-producer"> — {selected.producer}</span>}
        </span>
        <button type="button" className="wine-search-picker__clear" onClick={handleClear}>&times;</button>
      </div>
    );
  }

  return (
    <div className="wine-search-picker" ref={wrapperRef}>
      <input
        type="text"
        className="input wine-search-picker__input"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => results.length > 0 && setOpen(true)}
        placeholder={placeholder}
      />
      {loading && <span className="wine-search-picker__spinner" />}
      {open && (results.length > 0 || noResults) && (
        <ul className="wine-search-picker__dropdown">
          {results.map((wine) => (
            <li key={wine._id} className="wine-search-picker__option" onClick={() => handleSelect(wine)}>
              <span className={`wine-search-picker__option-dot ${wine.type || ''}`} />
              <div className="wine-search-picker__option-text">
                <span className="wine-search-picker__option-name">{wine.name}</span>
                <span className="wine-search-picker__option-sub">
                  {wine.producer && <span>{wine.producer}</span>}
                  {wine.country?.name && <span>{wine.country.name}</span>}
                  {wine.region?.name && <span>{wine.region.name}</span>}
                </span>
              </div>
              {wine.type && (
                <span className={`wine-search-picker__option-type ${wine.type}`}>{wine.type}</span>
              )}
            </li>
          ))}
          {noResults && (
            <li className="wine-search-picker__no-results">No wines found</li>
          )}
        </ul>
      )}
    </div>
  );
}
