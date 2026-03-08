import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { adminGetUsers, adminChangeUserPlan, adminResetUserTrial, adminChangeUserRoles } from '../api/admin';
import { PLAN_NAMES, PLANS } from '../config/plans';
import './AdminUsers.css';

const PAGE_SIZE = 50;
const ALL_ROLES = ['user', 'somm', 'admin'];

const DURATION_OPTIONS = [
  { value: '30',   labelKey: 'admin.users.duration30' },
  { value: '90',   labelKey: 'admin.users.duration90' },
  { value: '180',  labelKey: 'admin.users.duration180' },
  { value: '365',  labelKey: 'admin.users.duration365' },
  { value: 'null', labelKey: 'admin.users.durationNever' },
];

function PlanBadge({ plan }) {
  return <span className={`users-badge users-badge--plan users-badge--${plan}`}>{PLANS[plan]?.label || plan}</span>;
}

function ExpiryBadge({ planExpiresAt, t }) {
  if (!planExpiresAt) {
    return <span className="users-expiry users-expiry--never">{t('admin.users.expiryNever')}</span>;
  }
  const now = Date.now();
  const exp = new Date(planExpiresAt).getTime();
  const daysLeft = Math.ceil((exp - now) / (1000 * 60 * 60 * 24));

  if (now > exp) {
    return <span className="users-expiry users-expiry--expired">{t('admin.users.expiryExpired')}</span>;
  }
  if (daysLeft <= 30) {
    return (
      <span className="users-expiry users-expiry--soon">
        {new Date(planExpiresAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}
        {' '}({daysLeft}d)
      </span>
    );
  }
  return (
    <span className="users-expiry">
      {new Date(planExpiresAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}
    </span>
  );
}

function RoleBadges({ roles = [] }) {
  return (
    <span className="users-role-badges">
      {roles.map(r => (
        <span key={r} className={`users-badge users-badge--role users-badge--${r}`}>{r}</span>
      ))}
    </span>
  );
}

function RoleCheckboxes({ userId, currentRoles = [], disabled, onChange }) {
  return (
    <div className="users-role-checkboxes">
      {ALL_ROLES.map(r => (
        <label key={r} className="users-role-checkbox-label">
          <input
            type="checkbox"
            checked={currentRoles.includes(r)}
            disabled={disabled}
            onChange={e => {
              const next = e.target.checked
                ? [...new Set([...currentRoles, r])]
                : currentRoles.filter(x => x !== r);
              if (next.length === 0) return; // must keep at least one
              onChange(userId, next);
            }}
          />
          {r}
        </label>
      ))}
    </div>
  );
}

/**
 * Inline plan-change cell: picking a new plan opens a duration picker.
 * Applying sends { plan, expiresInDays } to the parent.
 */
function PlanCell({ user, disabled, onApply, t }) {
  const [pendingPlan, setPendingPlan] = useState(null);
  const [duration, setDuration] = useState('365');

  function handlePlanSelect(e) {
    const newPlan = e.target.value;
    if (newPlan === user.plan) {
      setPendingPlan(null);
    } else {
      setPendingPlan(newPlan);
    }
  }

  function handleApply() {
    onApply(user._id, pendingPlan, duration === 'null' ? null : Number(duration));
    setPendingPlan(null);
  }

  function handleCancel() {
    setPendingPlan(null);
  }

  return (
    <div className="users-plan-cell">
      <div className="users-select-cell">
        <PlanBadge plan={pendingPlan || user.plan} />
        <select
          className="users-inline-select"
          value={pendingPlan || user.plan}
          disabled={disabled}
          onChange={handlePlanSelect}
        >
          {PLAN_NAMES.map(p => (
            <option key={p} value={p}>{PLANS[p].label}</option>
          ))}
        </select>
      </div>

      {pendingPlan && (
        <div className="users-duration-picker">
          <label className="users-duration-label">{t('admin.users.durationLabel')}</label>
          <select
            className="users-inline-select"
            value={duration}
            onChange={e => setDuration(e.target.value)}
          >
            {DURATION_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{t(o.labelKey)}</option>
            ))}
          </select>
          <button className="btn btn-primary btn-xs" onClick={handleApply} disabled={disabled}>
            {t('admin.users.applyPlanBtn')}
          </button>
          <button className="btn btn-secondary btn-xs" onClick={handleCancel} disabled={disabled}>
            {t('admin.users.cancelPlanBtn')}
          </button>
        </div>
      )}
    </div>
  );
}

function AdminUsers() {
  const { t } = useTranslation();
  const { apiFetch } = useAuth();
  const [users, setUsers] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [offset, setOffset] = useState(0);

  const [filters, setFilters] = useState({ search: '', plan: '', role: '' });
  const [pendingFilters, setPendingFilters] = useState({ search: '', plan: '', role: '' });

  // Track in-flight updates per user to show spinner
  const [updating, setUpdating] = useState({});

  const fetchUsers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: PAGE_SIZE, offset });
      if (filters.search) params.set('search', filters.search);
      if (filters.plan)   params.set('plan', filters.plan);
      if (filters.role)   params.set('role', filters.role);

      const res = await adminGetUsers(apiFetch, params);
      const data = await res.json();
      if (res.ok) {
        setUsers(data.users);
        setTotal(data.total);
      } else {
        setError(data.error || 'Failed to load users');
      }
    } catch {
      setError('Network error');
    } finally {
      setLoading(false);
    }
  }, [apiFetch, filters, offset]);

  useEffect(() => { fetchUsers(); }, [fetchUsers]);

  function applyFilters(e) {
    e.preventDefault();
    setOffset(0);
    setFilters({ ...pendingFilters });
  }

  function clearFilters() {
    const empty = { search: '', plan: '', role: '' };
    setPendingFilters(empty);
    setFilters(empty);
    setOffset(0);
  }

  async function changePlan(userId, newPlan, expiresInDays) {
    setUpdating(prev => ({ ...prev, [userId + '_plan']: true }));
    try {
      const res = await adminChangeUserPlan(apiFetch, userId, newPlan, expiresInDays);
      const data = await res.json();
      if (res.ok) {
        setUsers(prev => prev.map(u => u._id === userId
          ? { ...u, plan: data.user.plan, planExpiresAt: data.user.planExpiresAt, planStartedAt: data.user.planStartedAt }
          : u
        ));
      } else {
        setError(data.error || 'Failed to change plan');
      }
    } catch {
      setError('Network error');
    } finally {
      setUpdating(prev => ({ ...prev, [userId + '_plan']: false }));
    }
  }

  async function resetTrial(userId) {
    setUpdating(prev => ({ ...prev, [userId + '_trial']: true }));
    try {
      const res = await adminResetUserTrial(apiFetch, userId);
      const data = await res.json();
      if (res.ok) {
        setUsers(prev => prev.map(u => u._id === userId
          ? { ...u, trialEligible: data.user.trialEligible }
          : u
        ));
      } else {
        setError(data.error || 'Failed to reset trial');
      }
    } catch {
      setError('Network error');
    } finally {
      setUpdating(prev => ({ ...prev, [userId + '_trial']: false }));
    }
  }

  async function changeRoles(userId, newRoles) {
    setUpdating(prev => ({ ...prev, [userId + '_roles']: true }));
    try {
      const res = await adminChangeUserRoles(apiFetch, userId, newRoles);
      const data = await res.json();
      if (res.ok) {
        setUsers(prev => prev.map(u => u._id === userId ? { ...u, roles: data.user.roles } : u));
      } else {
        setError(data.error || 'Failed to change roles');
      }
    } catch {
      setError('Network error');
    } finally {
      setUpdating(prev => ({ ...prev, [userId + '_roles']: false }));
    }
  }

  const totalPages = Math.ceil(total / PAGE_SIZE);
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;

  return (
    <div className="admin-users-page">
      <div className="page-header">
        <h1>{t('admin.users.title')}</h1>
        <span className="users-total">{t('admin.users.user', { count: total })}</span>
      </div>

      {/* Filters */}
      <form className="users-filters" onSubmit={applyFilters}>
        <input
          className="input"
          type="text"
          placeholder={t('admin.users.searchPlaceholder')}
          value={pendingFilters.search}
          onChange={e => setPendingFilters(p => ({ ...p, search: e.target.value }))}
        />
        <select
          className="input"
          value={pendingFilters.plan}
          onChange={e => setPendingFilters(p => ({ ...p, plan: e.target.value }))}
        >
          <option value="">{t('admin.users.allPlans')}</option>
          {PLAN_NAMES.map(p => (
            <option key={p} value={p}>{PLANS[p].label}</option>
          ))}
        </select>
        <select
          className="input"
          value={pendingFilters.role}
          onChange={e => setPendingFilters(p => ({ ...p, role: e.target.value }))}
        >
          <option value="">{t('admin.users.allRoles')}</option>
          {ALL_ROLES.map(r => (
            <option key={r} value={r}>{r.charAt(0).toUpperCase() + r.slice(1)}</option>
          ))}
        </select>
        <button type="submit" className="btn btn-primary">{t('admin.users.filterBtn')}</button>
        {(filters.search || filters.plan || filters.role) && (
          <button type="button" className="btn btn-secondary" onClick={clearFilters}>{t('admin.users.clearBtn')}</button>
        )}
      </form>

      {error && <div className="error-message">{error}</div>}

      {loading ? (
        <div className="loading-spinner">{t('admin.users.loadingUsers')}</div>
      ) : users.length === 0 ? (
        <div className="empty-state">{t('admin.users.noUsers')}</div>
      ) : (
        <>
          <div className="users-table-wrap">
            <table className="users-table">
              <thead>
                <tr>
                  <th>{t('admin.users.colUsername')}</th>
                  <th>{t('admin.users.colEmail')}</th>
                  <th>{t('admin.users.colPlan')}</th>
                  <th>{t('admin.users.colExpiry')}</th>
                  <th>{t('admin.users.colTrial')}</th>
                  <th>{t('admin.users.colRoles')}</th>
                  <th>{t('admin.users.colJoined')}</th>
                </tr>
              </thead>
              <tbody>
                {users.map(u => (
                  <tr key={u._id} className="users-row">
                    <td className="users-username">{u.username}</td>
                    <td className="users-email">{u.email}</td>
                    <td>
                      <PlanCell
                        user={u}
                        disabled={updating[u._id + '_plan']}
                        onApply={changePlan}
                        t={t}
                      />
                    </td>
                    <td>
                      <ExpiryBadge planExpiresAt={u.planExpiresAt} t={t} />
                    </td>
                    <td className="users-trial-cell">
                      {u.trialEligible
                        ? <span className="users-trial-badge users-trial-badge--available">{t('admin.users.trialAvailable')}</span>
                        : (
                          <button
                            className="btn btn-secondary btn-xs"
                            disabled={updating[u._id + '_trial']}
                            onClick={() => resetTrial(u._id)}
                          >
                            {t('admin.users.resetTrialBtn')}
                          </button>
                        )
                      }
                    </td>
                    <td>
                      <div className="users-roles-cell">
                        <RoleBadges roles={u.roles} />
                        <RoleCheckboxes
                          userId={u._id}
                          currentRoles={u.roles || []}
                          disabled={updating[u._id + '_roles']}
                          onChange={changeRoles}
                        />
                      </div>
                    </td>
                    <td className="users-joined">
                      {new Date(u.createdAt).toLocaleDateString(undefined, {
                        year: 'numeric', month: 'short', day: 'numeric'
                      })}
                    </td>
                  </tr>
                ))}
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
                {t('admin.users.previousBtn')}
              </button>
              <span className="users-page-info">{t('admin.users.page', { current: currentPage, total: totalPages })}</span>
              <button
                className="btn btn-secondary"
                disabled={offset + PAGE_SIZE >= total}
                onClick={() => setOffset(offset + PAGE_SIZE)}
              >
                {t('admin.users.nextBtn')}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default AdminUsers;
