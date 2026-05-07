import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { adminGetUsers, adminChangeUserRoles } from '../api/admin';
import ConfirmModal from '../components/ConfirmModal';
import './AdminModerators.css';

// Admin-only page for promoting / demoting forum moderators.
//
// Surfaces the existing PATCH /api/admin/users/:id/roles endpoint behind a
// purpose-built UI. Admins can:
//   - See current moderators (filtered list of users with the role)
//   - Search the user base by username/email
//   - One-click promote a regular user to moderator
//   - One-click revoke an existing moderator's role (with confirm)
//
// Self-protection: the backend prevents admins changing their own roles, so
// the UI hides the action buttons on the current admin's row.
export default function AdminModerators() {
  const { t } = useTranslation();
  const { apiFetch, user } = useAuth();

  const [moderators, setModerators] = useState([]);
  const [searchInput, setSearchInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState(null);
  const [searching, setSearching] = useState(false);

  const [loadingMods, setLoadingMods] = useState(true);
  const [error, setError] = useState(null);
  const [pending, setPending] = useState(null); // userId currently being promoted/demoted
  const [confirmRevoke, setConfirmRevoke] = useState(null); // user pending revocation

  const fetchModerators = useCallback(async () => {
    setLoadingMods(true);
    setError(null);
    try {
      const res = await adminGetUsers(apiFetch, 'role=moderator&limit=200');
      const data = await res.json();
      if (res.ok) {
        setModerators(data.users || []);
      } else {
        setError(data.error || t('adminModerators.failedLoad'));
      }
    } catch {
      setError(t('adminModerators.failedLoad'));
    } finally {
      setLoadingMods(false);
    }
  }, [apiFetch, t]);

  useEffect(() => { fetchModerators(); }, [fetchModerators]);

  const runSearch = async (q) => {
    if (!q || q.length < 2) {
      setSearchResults(null);
      return;
    }
    setSearching(true);
    try {
      const res = await adminGetUsers(apiFetch, `search=${encodeURIComponent(q)}&limit=20`);
      const data = await res.json();
      if (res.ok) setSearchResults(data.users || []);
    } catch {
      // silent
    } finally {
      setSearching(false);
    }
  };

  const handleSearchSubmit = (e) => {
    e.preventDefault();
    setSearchQuery(searchInput.trim());
    runSearch(searchInput.trim());
  };

  const clearSearch = () => {
    setSearchInput('');
    setSearchQuery('');
    setSearchResults(null);
  };

  const promote = async (target) => {
    setPending(target._id);
    try {
      const newRoles = Array.from(new Set([...(target.roles || ['user']), 'moderator']));
      const res = await adminChangeUserRoles(apiFetch, target._id, newRoles);
      if (res.ok) {
        await fetchModerators();
        if (searchQuery) runSearch(searchQuery);
      }
    } finally {
      setPending(null);
    }
  };

  const revoke = async (target) => {
    setPending(target._id);
    try {
      const newRoles = (target.roles || []).filter(r => r !== 'moderator');
      // The backend requires a non-empty array — fall back to ['user'] if
      // moderator was somehow the only role they had.
      const finalRoles = newRoles.length > 0 ? newRoles : ['user'];
      const res = await adminChangeUserRoles(apiFetch, target._id, finalRoles);
      if (res.ok) {
        await fetchModerators();
        if (searchQuery) runSearch(searchQuery);
      }
    } finally {
      setPending(null);
      setConfirmRevoke(null);
    }
  };

  const renderUserRow = (u, { isModerator }) => {
    const isSelf = String(u._id) === String(user.id);
    const displayName = u.displayName || u.username;
    return (
      <li key={u._id} className="admin-mods__row">
        <div className="admin-mods__user">
          <span className="admin-mods__avatar">{displayName.charAt(0).toUpperCase()}</span>
          <div className="admin-mods__user-meta">
            <span className="admin-mods__name">{displayName}</span>
            <span className="admin-mods__email">{u.email}</span>
          </div>
          <div className="admin-mods__role-badges">
            {(u.roles || []).filter(r => r !== 'user').map(r => (
              <span key={r} className={`admin-mods__role-badge admin-mods__role-badge--${r}`}>{r}</span>
            ))}
          </div>
        </div>
        <div className="admin-mods__actions">
          {isSelf ? (
            <span className="admin-mods__self-label">{t('adminModerators.you')}</span>
          ) : isModerator ? (
            <button
              className="btn btn-secondary btn-small"
              onClick={() => setConfirmRevoke(u)}
              disabled={pending === u._id}
            >
              {pending === u._id ? t('common.saving') : t('adminModerators.revoke')}
            </button>
          ) : (
            <button
              className="btn btn-primary btn-small"
              onClick={() => promote(u)}
              disabled={pending === u._id}
            >
              {pending === u._id ? t('common.saving') : t('adminModerators.promote')}
            </button>
          )}
        </div>
      </li>
    );
  };

  return (
    <div className="admin-mods">
      <header className="admin-mods__header">
        <h1>{t('adminModerators.title')}</h1>
        <p className="admin-mods__intro">{t('adminModerators.intro')}</p>
      </header>

      {error && <div className="alert alert-error">{error}</div>}

      <section className="admin-mods__section">
        <h2 className="admin-mods__section-title">
          {t('adminModerators.currentMods', { count: moderators.length })}
        </h2>
        {loadingMods ? (
          <p className="admin-mods__loading">{t('common.loading')}</p>
        ) : moderators.length === 0 ? (
          <p className="admin-mods__empty">{t('adminModerators.noMods')}</p>
        ) : (
          <ul className="admin-mods__list">
            {moderators.map(u => renderUserRow(u, { isModerator: true }))}
          </ul>
        )}
      </section>

      <section className="admin-mods__section">
        <h2 className="admin-mods__section-title">{t('adminModerators.findUser')}</h2>
        <form className="admin-mods__search" onSubmit={handleSearchSubmit} role="search">
          <input
            type="search"
            className="input admin-mods__search-input"
            value={searchInput}
            onChange={e => setSearchInput(e.target.value)}
            placeholder={t('adminModerators.searchPlaceholder')}
            aria-label={t('adminModerators.searchPlaceholder')}
            minLength={2}
          />
          {searchQuery && (
            <button type="button" className="btn btn-secondary btn-small" onClick={clearSearch}>
              {t('common.clear')}
            </button>
          )}
          <button type="submit" className="btn btn-primary btn-small" disabled={searching}>
            {searching ? t('common.loading') : t('common.search')}
          </button>
        </form>

        {searchResults !== null && (
          searchResults.length === 0 ? (
            <p className="admin-mods__empty">{t('adminModerators.noResults')}</p>
          ) : (
            <ul className="admin-mods__list">
              {searchResults.map(u => renderUserRow(u, {
                isModerator: (u.roles || []).includes('moderator')
              }))}
            </ul>
          )
        )}
      </section>

      {confirmRevoke && (
        <ConfirmModal
          title={t('adminModerators.revokeTitle')}
          message={t('adminModerators.revokeConfirm', {
            name: confirmRevoke.displayName || confirmRevoke.username
          })}
          warning={t('adminModerators.revokeWarning')}
          confirmLabel={t('adminModerators.revoke')}
          confirmClass="btn btn-warning"
          onConfirm={() => revoke(confirmRevoke)}
          onCancel={() => setConfirmRevoke(null)}
        />
      )}
    </div>
  );
}
