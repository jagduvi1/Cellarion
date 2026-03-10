import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { adminGetDeletedCellars, adminRestoreCellar } from '../api/admin';

const PAGE_SIZE = 50;

function daysUntilPurge(deletedAt) {
  if (!deletedAt) return null;
  const purgeAt = new Date(deletedAt).getTime() + 30 * 24 * 60 * 60 * 1000;
  return Math.max(0, Math.ceil((purgeAt - Date.now()) / (1000 * 60 * 60 * 24)));
}

function AdminCellars() {
  const { t } = useTranslation();
  const { apiFetch } = useAuth();
  const [cellars, setCellars] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState('');
  const [pendingSearch, setPendingSearch] = useState('');
  const [restoring, setRestoring] = useState({});
  const [restored, setRestored] = useState({});

  const fetchCellars = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: PAGE_SIZE, offset });
      if (search) params.set('search', search);
      const res = await adminGetDeletedCellars(apiFetch, params);
      const data = await res.json();
      if (res.ok) {
        setCellars(data.cellars);
        setTotal(data.total);
      } else {
        setError(data.error || t('admin.cellars.errorLoad'));
      }
    } catch {
      setError(t('admin.cellars.errorNetwork'));
    } finally {
      setLoading(false);
    }
  }, [apiFetch, search, offset, t]);

  useEffect(() => { fetchCellars(); }, [fetchCellars]);

  function applySearch(e) {
    e.preventDefault();
    setOffset(0);
    setSearch(pendingSearch);
  }

  async function restore(cellar) {
    setRestoring(prev => ({ ...prev, [cellar._id]: true }));
    setError(null);
    try {
      const res = await adminRestoreCellar(apiFetch, cellar._id);
      const data = await res.json();
      if (res.ok) {
        setRestored(prev => ({ ...prev, [cellar._id]: data.cellar.name }));
        setCellars(prev => prev.filter(c => c._id !== cellar._id));
        setTotal(prev => prev - 1);
      } else {
        setError(data.error || t('admin.cellars.errorRestore'));
      }
    } catch {
      setError(t('admin.cellars.errorNetwork'));
    } finally {
      setRestoring(prev => ({ ...prev, [cellar._id]: false }));
    }
  }

  const totalPages = Math.ceil(total / PAGE_SIZE);
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;

  return (
    <div className="admin-users-page">
      <div className="page-header">
        <h1>{t('admin.cellars.title')}</h1>
        <span className="users-total">{t('admin.cellars.count', { count: total })}</span>
      </div>

      <form className="users-filters" onSubmit={applySearch}>
        <input
          className="input"
          type="text"
          placeholder={t('admin.cellars.searchPlaceholder')}
          value={pendingSearch}
          onChange={e => setPendingSearch(e.target.value)}
        />
        <button type="submit" className="btn btn-primary">{t('admin.cellars.searchBtn')}</button>
        {search && (
          <button type="button" className="btn btn-secondary" onClick={() => { setPendingSearch(''); setSearch(''); setOffset(0); }}>
            {t('admin.cellars.clearBtn')}
          </button>
        )}
      </form>

      {Object.entries(restored).map(([id, name]) => (
        <div key={id} className="success-message" style={{ marginBottom: '0.5rem' }}>
          {t('admin.cellars.restoreSuccess', { name })}
        </div>
      ))}

      {error && <div className="error-message">{error}</div>}

      {loading ? (
        <div className="loading-spinner">{t('admin.cellars.loading')}</div>
      ) : cellars.length === 0 ? (
        <div className="empty-state">{t('admin.cellars.empty')}</div>
      ) : (
        <>
          <div className="users-table-wrap">
            <table className="users-table">
              <thead>
                <tr>
                  <th>{t('admin.cellars.colName')}</th>
                  <th>{t('admin.cellars.colOwner')}</th>
                  <th>{t('admin.cellars.colDeletedAt')}</th>
                  <th>{t('admin.cellars.colPurgesIn')}</th>
                  <th>{t('admin.cellars.colAction')}</th>
                </tr>
              </thead>
              <tbody>
                {cellars.map(c => {
                  const days = daysUntilPurge(c.deletedAt);
                  return (
                    <tr key={c._id} className="users-row">
                      <td><strong>{c.name}</strong></td>
                      <td>
                        <span>{c.user?.username || '—'}</span>
                        {c.user?.email && <span style={{ color: '#9A9484', marginLeft: '0.4rem', fontSize: '0.8rem' }}>{c.user.email}</span>}
                      </td>
                      <td>
                        {new Date(c.deletedAt).toLocaleDateString(undefined, {
                          year: 'numeric', month: 'short', day: 'numeric',
                        })}
                      </td>
                      <td>
                        <span style={{ color: days <= 3 ? '#c0392b' : days <= 7 ? '#d68910' : undefined }}>
                          {t('admin.cellars.daysLeft', { count: days })}
                        </span>
                      </td>
                      <td>
                        <button
                          className="btn btn-secondary btn-xs"
                          disabled={restoring[c._id]}
                          onClick={() => restore(c)}
                        >
                          {restoring[c._id] ? t('admin.cellars.restoring') : t('admin.cellars.restoreBtn')}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div className="users-pagination">
              <button
                className="btn btn-secondary"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              >
                {t('admin.cellars.previousBtn')}
              </button>
              <span className="users-page-info">{t('admin.cellars.page', { current: currentPage, total: totalPages })}</span>
              <button
                className="btn btn-secondary"
                disabled={offset + PAGE_SIZE >= total}
                onClick={() => setOffset(offset + PAGE_SIZE)}
              >
                {t('admin.cellars.nextBtn')}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default AdminCellars;
