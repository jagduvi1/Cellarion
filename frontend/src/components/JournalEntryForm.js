import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { createJournalEntry, updateJournalEntry } from '../api/journal';
import { searchFriends } from '../api/recommendations';
import Modal from './Modal';
import './JournalEntryForm.css';

const OCCASIONS = ['dinner', 'tasting', 'celebration', 'casual', 'gift', 'travel', 'other'];

export default function JournalEntryForm({ existing, onClose, onSaved, prefilledBottle }) {
  const { t } = useTranslation();
  const { apiFetch, user } = useAuth();
  const isEdit = !!existing;

  const [date, setDate] = useState(existing?.date ? existing.date.split('T')[0] : new Date().toISOString().split('T')[0]);
  const [title, setTitle] = useState(existing?.title || '');
  const [occasion, setOccasion] = useState(existing?.occasion || 'dinner');
  const [mood, setMood] = useState(existing?.mood || null);
  const [notes, setNotes] = useState(existing?.notes || '');
  const [visibility, setVisibility] = useState(existing?.visibility || 'private');
  const [people, setPeople] = useState(existing?.people || []);
  const [pairings, setPairings] = useState(
    existing?.pairings?.length > 0
      ? existing.pairings
      : prefilledBottle
        ? [{ dish: '', bottle: prefilledBottle._id, wine: prefilledBottle.wineDefinition?._id, wineName: prefilledBottle.wineDefinition?.name || '', notes: '' }]
        : [{ dish: '', bottle: null, wine: null, wineName: '', notes: '' }]
  );

  const [personName, setPersonName] = useState('');
  const [friendSuggestions, setFriendSuggestions] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const debounceRef = useRef(null);

  // Search friends as user types person name
  useEffect(() => {
    if (!personName.trim()) { setFriendSuggestions([]); return; }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await searchFriends(apiFetch, personName);
        if (res.ok) {
          const data = await res.json();
          setFriendSuggestions(data.users || []);
        }
      } catch { /* ignore */ }
    }, 250);
    return () => clearTimeout(debounceRef.current);
  }, [personName]); // eslint-disable-line react-hooks/exhaustive-deps

  const addPerson = (name, userId = null) => {
    if (!name.trim()) return;
    setPeople(prev => [...prev, { name: name.trim(), user: userId }]);
    setPersonName('');
    setFriendSuggestions([]);
  };

  const removePerson = (idx) => {
    setPeople(prev => prev.filter((_, i) => i !== idx));
  };

  const updatePairing = (idx, field, value) => {
    setPairings(prev => prev.map((p, i) => i === idx ? { ...p, [field]: value } : p));
  };

  const addPairing = () => {
    setPairings(prev => [...prev, { dish: '', bottle: null, wine: null, wineName: '', notes: '' }]);
  };

  const removePairing = (idx) => {
    setPairings(prev => prev.filter((_, i) => i !== idx));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);

    if (!date) { setError(t('journal.dateRequired', 'Date is required')); return; }

    setSaving(true);
    try {
      const payload = {
        date,
        title: title.trim(),
        occasion,
        mood,
        notes: notes.trim(),
        visibility,
        people: people.map(p => ({ name: p.name, user: p.user?._id || p.user || null })),
        pairings: pairings.filter(p => p.dish || p.wineName || p.bottle || p.notes).map(p => ({
          dish: p.dish,
          bottle: p.bottle,
          wine: p.wine,
          wineName: p.wineName,
          notes: p.notes
        }))
      };

      const res = isEdit
        ? await updateJournalEntry(apiFetch, existing._id, payload)
        : await createJournalEntry(apiFetch, payload);

      const data = await res.json();

      if (res.ok) {
        onSaved?.(data.entry);
        onClose();
      } else {
        setError(data.error || 'Failed to save');
      }
    } catch {
      setError('Failed to save');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={isEdit ? t('journal.editEntry', 'Edit Journal Entry') : t('journal.newEntry', 'New Journal Entry')} onClose={onClose}>
      <form onSubmit={handleSubmit} className="journal-form">
        {/* Date & occasion row */}
        <div className="journal-form__row">
          <div className="form-group journal-form__date">
            <label>{t('journal.date', 'Date')}</label>
            <input type="date" className="input" value={date} onChange={e => setDate(e.target.value)} required />
          </div>
          <div className="form-group journal-form__occasion">
            <label>{t('journal.occasion', 'Occasion')}</label>
            <select className="input" value={occasion} onChange={e => setOccasion(e.target.value)}>
              {OCCASIONS.map(o => (
                <option key={o} value={o}>{t(`journal.occasion_${o}`, o)}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Title */}
        <div className="form-group">
          <label>{t('journal.titleLabel', 'Title (optional)')}</label>
          <input type="text" className="input" value={title} onChange={e => setTitle(e.target.value)} placeholder={t('journal.titlePlaceholder', 'Anniversary dinner at...')} maxLength={200} />
        </div>

        {/* People */}
        <div className="form-group">
          <label>{t('journal.people', 'People')}</label>
          <div className="journal-form__people-tags">
            {people.map((p, i) => (
              <span key={i} className="journal-form__person-tag">
                {p.name}
                {(p.user?._id || p.user) && <span className="journal-form__person-linked">@</span>}
                <button type="button" className="journal-form__person-remove" onClick={() => removePerson(i)}>×</button>
              </span>
            ))}
          </div>
          <div className="journal-form__person-input-wrap">
            <input
              type="text"
              className="input"
              value={personName}
              onChange={e => setPersonName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addPerson(personName); } }}
              placeholder={t('journal.addPerson', 'Type a name and press Enter')}
            />
            {friendSuggestions.length > 0 && (
              <ul className="journal-form__friend-suggestions">
                {friendSuggestions.map(f => (
                  <li key={f._id}>
                    <button type="button" onClick={() => addPerson(f.displayName || f.username, f._id)}>
                      {f.displayName || f.username}
                      {f.displayName && f.username !== f.displayName && <span className="journal-form__friend-username"> @{f.username}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {/* Pairings */}
        <div className="form-group">
          <label>{t('journal.pairings', 'Pairings')}</label>
          {pairings.map((p, i) => (
            <div key={i} className="journal-form__pairing">
              <div className="journal-form__pairing-header">
                <span className="journal-form__pairing-num">#{i + 1}</span>
                {pairings.length > 1 && (
                  <button type="button" className="journal-form__pairing-remove" onClick={() => removePairing(i)}>×</button>
                )}
              </div>
              <input
                type="text"
                className="input"
                value={p.dish}
                onChange={e => updatePairing(i, 'dish', e.target.value)}
                placeholder={t('journal.dishPlaceholder', 'Dish (e.g. Osso buco)')}
                maxLength={200}
              />
              <input
                type="text"
                className="input"
                value={p.wineName}
                onChange={e => updatePairing(i, 'wineName', e.target.value)}
                placeholder={t('journal.winePlaceholder', 'Wine name')}
                maxLength={200}
              />
              <textarea
                className="input"
                value={p.notes}
                onChange={e => updatePairing(i, 'notes', e.target.value)}
                placeholder={t('journal.pairingNotesPlaceholder', 'Tasting note for this pairing...')}
                rows={2}
                maxLength={500}
              />
            </div>
          ))}
          <button type="button" className="btn btn-small btn-secondary" onClick={addPairing}>
            + {t('journal.addPairing', 'Add pairing')}
          </button>
        </div>

        {/* Mood */}
        <div className="form-group">
          <label>{t('journal.mood', 'Mood')}</label>
          <div className="journal-form__mood">
            {[1, 2, 3, 4, 5].map(n => (
              <button
                key={n}
                type="button"
                className={`journal-form__mood-btn ${mood === n ? 'active' : ''}`}
                onClick={() => setMood(mood === n ? null : n)}
              >
                {'★'}
              </button>
            ))}
          </div>
        </div>

        {/* Notes */}
        <div className="form-group">
          <label>{t('journal.notes', 'Notes')}</label>
          <textarea
            className="input"
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder={t('journal.notesPlaceholder', 'How was the evening?')}
            rows={3}
            maxLength={2000}
          />
        </div>

        {/* Visibility */}
        <div className="form-group">
          <label>{t('journal.visibility', 'Visibility')}</label>
          <div className="journal-form__visibility">
            <button type="button" className={`journal-form__vis-btn ${visibility === 'private' ? 'active' : ''}`} onClick={() => setVisibility('private')}>
              {t('journal.private', 'Private')}
            </button>
            <button type="button" className={`journal-form__vis-btn ${visibility === 'public' ? 'active' : ''}`} onClick={() => setVisibility('public')}>
              {t('journal.public', 'Public')}
            </button>
          </div>
        </div>

        {error && <div className="alert alert-error">{error}</div>}

        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={saving}>
            {t('journal.cancel', 'Cancel')}
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? t('journal.saving', 'Saving...') : isEdit ? t('journal.update', 'Update') : t('journal.save', 'Save Entry')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
