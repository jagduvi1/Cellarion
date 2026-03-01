import { useState } from 'react';
import './GrapePicker.css';

/**
 * GrapePicker — searchable multi-select for grape varieties.
 *
 * Props:
 *   grapes   — full list of grape objects { _id, name, color }
 *   selected — array of selected grape _id strings
 *   onChange — callback(newSelectedIds[])
 */
function GrapePicker({ grapes = [], selected = [], onChange }) {
  const [search, setSearch] = useState('');

  const selectedSet = new Set(selected);
  const selectedGrapes = grapes.filter(g => selectedSet.has(g._id));
  const availableGrapes = grapes.filter(
    g => !selectedSet.has(g._id) && g.name.toLowerCase().includes(search.toLowerCase())
  );

  const add = (id) => onChange([...selected, id]);
  const remove = (id) => onChange(selected.filter(sid => sid !== id));

  return (
    <div className="grape-picker-widget">
      {/* Selected chips */}
      {selectedGrapes.length > 0 && (
        <div className="gpw-selected">
          {selectedGrapes.map(g => (
            <span key={g._id} className="gpw-chip">
              {g.name}
              <button
                type="button"
                className="gpw-chip-remove"
                onClick={() => remove(g._id)}
                aria-label={`Remove ${g.name}`}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Search */}
      <input
        type="text"
        className="gpw-search"
        placeholder={`Search ${grapes.length} grape${grapes.length !== 1 ? 's' : ''}…`}
        value={search}
        onChange={e => setSearch(e.target.value)}
      />

      {/* Available options */}
      <div className="gpw-options">
        {availableGrapes.length === 0 ? (
          <span className="gpw-empty">
            {search ? `No grapes match "${search}"` : 'All grapes selected'}
          </span>
        ) : (
          availableGrapes.map(g => (
            <button
              key={g._id}
              type="button"
              className="gpw-option"
              onClick={() => add(g._id)}
            >
              {g.name}
              {g.color && <em className="gpw-color"> {g.color}</em>}
            </button>
          ))
        )}
      </div>
    </div>
  );
}

export default GrapePicker;
