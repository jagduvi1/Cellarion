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

  const handleSaved = () => {
    setEditEntry(null);
    fetchEntries();
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
                        <div className="journal-card__mood">
                          {[1, 2, 3, 4, 5].map(n => (
                            <span key={n} className={`journal-card__mood-dot ${n > entry.mood ? 'journal-card__mood-dot--empty' : ''}`} />
                          ))}
                        </div>
                      )}
                    </div>

                    {/* People as badges with initials */}
                    {entry.people?.length > 0 && (
                      <div className="journal-card__people">
                        <span className="journal-card__people-label">{t('journal.with', 'With')}</span>
                        {entry.people.map((p, i) => {
                          const initial = (p.name || '?')[0].toUpperCase();
                          const isLinked = !!(p.user?._id || p.user);
                          return isLinked ? (
                            <Link key={i} to={`/users/${p.user._id || p.user}`} className="journal-card__person-badge journal-card__person-badge--linked">
                              <span className="journal-card__person-initial">{initial}</span>
                              {p.name}
                            </Link>
                          ) : (
                            <span key={i} className="journal-card__person-badge">
                              <span className="journal-card__person-initial">{initial}</span>
                              {p.name}
                            </span>
                          );
                        })}
                      </div>
                    )}

                    {/* Pairings as two-column cards */}
                    {entry.pairings?.length > 0 && (
                      <div className="journal-card__pairings">
                        {entry.pairings.map((p, i) => {
                          const wineName = p.wineName || p.wine?.name || p.bottle?.wineDefinition?.name;
                          const vintage = p.bottle?.vintage;
                          return (
                            <div key={i}>
                              <div className="journal-card__pairing">
                                <div className="journal-card__pairing-dish">
                                  <span className="journal-card__pairing-icon">Dish</span>
                                  <span className="journal-card__pairing-text">{p.dish || '—'}</span>
                                </div>
                                <div className="journal-card__pairing-wine">
                                  <span className="journal-card__pairing-icon">Wine</span>
                                  <span className="journal-card__pairing-text">
                                    {wineName || '—'}{vintage ? ` ${vintage}` : ''}
                                  </span>
                                </div>
                              </div>
                              {p.notes && (
                                <div className="journal-card__pairing-notes">"{p.notes}"</div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {/* Notes */}
                    {entry.notes && (
                      <p className="journal-card__notes">{entry.notes}</p>
                    )}

                    {/* Footer with actions */}
                    <div className="journal-card__footer">
                      {entry.visibility === 'private' && (
                        <span className="journal-card__badge">
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                          {t('journal.private', 'Private')}
                        </span>
                      )}
                      <span className="journal-card__footer-spacer" />
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
