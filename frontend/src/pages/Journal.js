import { useState, useEffect, lazy, Suspense } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { getJournalEntries, deleteJournalEntry } from '../api/journal';
import './Journal.css';

const JournalEntryForm = lazy(() => import('../components/JournalEntryForm'));

const OCCASION_ICONS = {
  dinner: '🍽',
  tasting: '🍷',
  celebration: '🥂',
  casual: '☕',
  gift: '🎁',
  travel: '✈️',
  other: '📝'
};

function formatDate(dateStr) {
  return new Date(dateStr).toLocaleDateString(undefined, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });
}

function getMonthKey(dateStr) {
  const d = new Date(dateStr);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function formatMonth(key) {
  const [year, month] = key.split('-');
  return new Date(year, month - 1).toLocaleDateString(undefined, { year: 'numeric', month: 'long' });
}

export default function Journal() {
  const { t } = useTranslation();
  const { apiFetch } = useAuth();
  const [entries, setEntries] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  const [editEntry, setEditEntry] = useState(null);
  const [search, setSearch] = useState('');
  const [occasion, setOccasion] = useState('');

  useEffect(() => {
    fetchEntries();
  }, [search, occasion]); // eslint-disable-line react-hooks/exhaustive-deps

  const fetchEntries = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (search) params.set('q', search);
      if (occasion) params.set('occasion', occasion);
      params.set('limit', '50');

      const res = await getJournalEntries(apiFetch, params.toString());
      if (res.ok) {
        const data = await res.json();
        setEntries(data.items || []);
        setTotal(data.total || 0);
      }
    } catch { /* ignore */ }
    setLoading(false);
  };

  const handleDelete = async (id) => {
    if (!window.confirm(t('journal.confirmDelete', 'Delete this journal entry?'))) return;
    const res = await deleteJournalEntry(apiFetch, id);
    if (res.ok) {
      setEntries(prev => prev.filter(e => e._id !== id));
      setTotal(prev => prev - 1);
    }
  };

  const handleSaved = (entry) => {
    if (editEntry) {
      setEntries(prev => prev.map(e => e._id === entry._id ? entry : e));
    } else {
      setEntries(prev => [entry, ...prev]);
      setTotal(prev => prev + 1);
    }
    setEditEntry(null);
  };

  // Group entries by month
  const grouped = entries.reduce((acc, entry) => {
    const key = getMonthKey(entry.date);
    if (!acc[key]) acc[key] = [];
    acc[key].push(entry);
    return acc;
  }, {});

  return (
    <div className="journal-page">
      <div className="journal-header">
        <h1>{t('journal.title', 'Wine Journal')}</h1>
        <button className="btn btn-primary" onClick={() => { setEditEntry(null); setFormOpen(true); }}>
          + {t('journal.newEntry', 'New Entry')}
        </button>
      </div>

      {/* Filters */}
      <div className="journal-filters">
        <input
          type="text"
          className="input journal-search"
          placeholder={t('journal.searchPlaceholder', 'Search entries...')}
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <select className="input journal-occasion-filter" value={occasion} onChange={e => setOccasion(e.target.value)}>
          <option value="">{t('journal.allOccasions', 'All occasions')}</option>
          {Object.keys(OCCASION_ICONS).map(o => (
            <option key={o} value={o}>{OCCASION_ICONS[o]} {t(`journal.occasion_${o}`, o)}</option>
          ))}
        </select>
      </div>

      {loading ? (
        <p className="journal-loading">{t('journal.loading', 'Loading...')}</p>
      ) : entries.length === 0 ? (
        <div className="journal-empty">
          <p>{t('journal.empty', 'No journal entries yet. Start capturing your wine moments!')}</p>
        </div>
      ) : (
        <div className="journal-timeline">
          {Object.keys(grouped).sort().reverse().map(monthKey => (
            <div key={monthKey} className="journal-month">
              <h2 className="journal-month__label">{formatMonth(monthKey)}</h2>
              <div className="journal-month__entries">
                {grouped[monthKey].map(entry => (
                  <div key={entry._id} className="journal-card">
                    <div className="journal-card__header">
                      <span className="journal-card__occasion">{OCCASION_ICONS[entry.occasion] || '📝'}</span>
                      <div className="journal-card__meta">
                        <span className="journal-card__date">{formatDate(entry.date)}</span>
                        {entry.title && <h3 className="journal-card__title">{entry.title}</h3>}
                      </div>
                      {entry.mood && (
                        <span className="journal-card__mood">{'★'.repeat(entry.mood)}</span>
                      )}
                    </div>

                    {/* People */}
                    {entry.people?.length > 0 && (
                      <div className="journal-card__people">
                        {t('journal.with', 'With')} {entry.people.map((p, i) => (
                          <span key={i}>
                            {p.user ? (
                              <Link to={`/users/${p.user._id || p.user}`} className="journal-card__person-link">{p.name}</Link>
                            ) : (
                              <span>{p.name}</span>
                            )}
                            {i < entry.people.length - 1 ? ', ' : ''}
                          </span>
                        ))}
                      </div>
                    )}

                    {/* Pairings */}
                    {entry.pairings?.length > 0 && (
                      <div className="journal-card__pairings">
                        {entry.pairings.map((p, i) => (
                          <div key={i} className="journal-card__pairing">
                            {p.dish && <span className="journal-card__dish">🍽 {p.dish}</span>}
                            {(p.wineName || p.wine?.name || p.bottle?.wineDefinition?.name) && (
                              <span className="journal-card__wine">
                                🍷 {p.wineName || p.wine?.name || p.bottle?.wineDefinition?.name}
                                {p.bottle?.vintage ? ` ${p.bottle.vintage}` : ''}
                              </span>
                            )}
                            {p.notes && <span className="journal-card__pairing-notes">"{p.notes}"</span>}
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Notes */}
                    {entry.notes && (
                      <p className="journal-card__notes">{entry.notes}</p>
                    )}

                    {/* Actions */}
                    <div className="journal-card__actions">
                      {entry.visibility === 'private' && (
                        <span className="journal-card__badge">🔒 {t('journal.private', 'Private')}</span>
                      )}
                      <button className="journal-card__action" onClick={() => { setEditEntry(entry); setFormOpen(true); }}>
                        {t('journal.edit', 'Edit')}
                      </button>
                      <button className="journal-card__action journal-card__action--danger" onClick={() => handleDelete(entry._id)}>
                        {t('journal.delete', 'Delete')}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Form modal */}
      <Suspense fallback={null}>
        {formOpen && (
          <JournalEntryForm
            existing={editEntry}
            onClose={() => { setFormOpen(false); setEditEntry(null); }}
            onSaved={handleSaved}
          />
        )}
      </Suspense>
    </div>
  );
}
