import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { adminChangeUserPlan, adminResetUserTrial, adminChangeUserRoles } from '../../api/admin';
import { PLAN_NAMES, PLANS } from '../../config/plans';
import { fmtDate, PlanBadge, RoleBadge } from './helpers';

const PAGE_SIZE = 50;
const ALL_ROLES = ['user', 'somm', 'admin'];
const DURATION_OPTIONS = [
  { value: '30',   label: '30 days' },
  { value: '90',   label: '90 days' },
  { value: '180',  label: '180 days' },
  { value: '365',  label: '1 year' },
  { value: 'null', label: 'Never' },
];

function RoleCheckboxes({ userId, currentRoles = [], disabled, onChange }) {
  return (
    <span style={{ display: 'inline-flex', gap: 4 }}>
      {ALL_ROLES.map(r => (
        <label key={r} style={{ display: 'inline-flex', alignItems: 'center', gap: 2, cursor: disabled ? 'default' : 'pointer', fontSize: 10 }}>
          <input
            type="checkbox"
            checked={currentRoles.includes(r)}
            disabled={disabled}
            onChange={e => {
              const next = e.target.checked
                ? [...new Set([...currentRoles, r])]
                : currentRoles.filter(x => x !== r);
              if (next.length === 0) return;
              onChange(userId, next);
            }}
          />
          {r}
        </label>
      ))}
    </span>
  );
}

function InlinePlanPicker({ user, disabled, onApply }) {
  const [pendingPlan, setPendingPlan] = useState(null);
  const [duration, setDuration] = useState('365');

  function handleSelect(e) {
    const newPlan = e.target.value;
    setPendingPlan(newPlan === user.plan ? null : newPlan);
  }

  function handleApply() {
    onApply(user._id, pendingPlan, duration === 'null' ? null : Number(duration));
    setPendingPlan(null);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <PlanBadge plan={pendingPlan || user.plan} />
        <select
          className="sa-input"
          style={{ width: 'auto', padding: '1px 4px', fontSize: 10 }}
          value={pendingPlan || user.plan}
          disabled={disabled}
          onChange={handleSelect}
        >
          {PLAN_NAMES.map(p => (
            <option key={p} value={p}>{PLANS[p]?.label || p}</option>
          ))}
        </select>
      </div>
      {pendingPlan && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <select
            className="sa-input"
            style={{ width: 'auto', padding: '1px 4px', fontSize: 10 }}
            value={duration}
            onChange={e => setDuration(e.target.value)}
          >
            {DURATION_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <button className="sa-btn" style={{ fontSize: 10, padding: '1px 6px' }} onClick={handleApply} disabled={disabled}>Apply</button>
          <button className="sa-btn" style={{ fontSize: 10, padding: '1px 6px' }} onClick={() => setPendingPlan(null)}>Cancel</button>
        </div>
      )}
    </div>
  );
}

function ExpiryCell({ planExpiresAt }) {
  if (!planExpiresAt) return <span style={{ opacity: 0.4 }}>never</span>;
  const now = Date.now();
  const exp = new Date(planExpiresAt).getTime();
  const daysLeft = Math.ceil((exp - now) / (1000 * 60 * 60 * 24));
  if (now > exp) return <span style={{ color: 'var(--sa-danger)' }}>expired</span>;
  if (daysLeft <= 30) return <span style={{ color: 'var(--sa-gold)' }}>{fmtDate(planExpiresAt)} ({daysLeft}d)</span>;
  return <span className="mono">{fmtDate(planExpiresAt)}</span>;
}

export default function TabUsers() {
  const { apiFetch } = useAuth();
  const [search, setSearch] = useState('');
  const [planFilter, setPlanFilter] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [page, setPage] = useState(0);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [updating, setUpdating] = useState({});

  const load = useCallback(async (q, plan, role, p) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: PAGE_SIZE, offset: p * PAGE_SIZE });
      if (q)    params.set('search', q);
      if (plan) params.set('plan', plan);
      if (role) params.set('role', role);
      const res = await apiFetch(`/api/superadmin/users?${params}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      setData(await res.json());
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [apiFetch]);

  useEffect(() => { load(search, planFilter, roleFilter, page); }, [page]); // eslint-disable-line

  const handleSearch = (e) => {
    e.preventDefault();
    setPage(0);
    load(search, planFilter, roleFilter, 0);
  };

  const clearFilters = () => {
    setSearch('');
    setPlanFilter('');
    setRoleFilter('');
    setPage(0);
    load('', '', '', 0);
  };

  async function changePlan(userId, newPlan, expiresInDays) {
    setUpdating(prev => ({ ...prev, [userId + '_plan']: true }));
    try {
      const res = await adminChangeUserPlan(apiFetch, userId, newPlan, expiresInDays);
      const body = await res.json();
      if (res.ok) {
        setData(prev => prev ? {
          ...prev,
          users: prev.users.map(u => u._id === userId
            ? { ...u, plan: body.user.plan, planExpiresAt: body.user.planExpiresAt }
            : u
          ),
        } : prev);
      } else {
        setError(body.error || 'Failed to change plan');
      }
    } catch { setError('Network error'); }
    finally { setUpdating(prev => ({ ...prev, [userId + '_plan']: false })); }
  }

  async function resetTrial(userId) {
    setUpdating(prev => ({ ...prev, [userId + '_trial']: true }));
    try {
      const res = await adminResetUserTrial(apiFetch, userId);
      const body = await res.json();
      if (res.ok) {
        setData(prev => prev ? {
          ...prev,
          users: prev.users.map(u => u._id === userId
            ? { ...u, trialEligible: body.user.trialEligible }
            : u
          ),
        } : prev);
      } else {
        setError(body.error || 'Failed to reset trial');
      }
    } catch { setError('Network error'); }
    finally { setUpdating(prev => ({ ...prev, [userId + '_trial']: false })); }
  }

  async function changeRoles(userId, newRoles) {
    setUpdating(prev => ({ ...prev, [userId + '_roles']: true }));
    try {
      const res = await adminChangeUserRoles(apiFetch, userId, newRoles);
      const body = await res.json();
      if (res.ok) {
        setData(prev => prev ? {
          ...prev,
          users: prev.users.map(u => u._id === userId ? { ...u, roles: body.user.roles } : u),
        } : prev);
      } else {
        setError(body.error || 'Failed to change roles');
      }
    } catch { setError('Network error'); }
    finally { setUpdating(prev => ({ ...prev, [userId + '_roles']: false })); }
  }

  const hasFilters = search || planFilter || roleFilter;

  return (
    <>
      <form className="sa-filter-row" onSubmit={handleSearch}>
        <input
          className="sa-input"
          placeholder="Search by username or email..."
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <select className="sa-input" style={{ width: 'auto' }} value={planFilter} onChange={e => setPlanFilter(e.target.value)}>
          <option value="">All plans</option>
          {PLAN_NAMES.map(p => <option key={p} value={p}>{PLANS[p]?.label || p}</option>)}
        </select>
        <select className="sa-input" style={{ width: 'auto' }} value={roleFilter} onChange={e => setRoleFilter(e.target.value)}>
          <option value="">All roles</option>
          {ALL_ROLES.map(r => <option key={r} value={r}>{r.charAt(0).toUpperCase() + r.slice(1)}</option>)}
        </select>
        <button type="submit" className="sa-btn">Search</button>
        {hasFilters && (
          <button type="button" className="sa-btn" onClick={clearFilters}>Clear</button>
        )}
      </form>

      {error && <div className="sa-error">Error: {error}</div>}

      <div className="sa-panel">
        <div className="sa-panel-header">
          <span className="sa-panel-title">Users</span>
          <span style={{ fontSize: 10, color: 'var(--sa-text-dim)' }}>{data ? `${data.total} total` : ''}</span>
        </div>
        <div className="sa-panel-body">
          {loading ? (
            <div className="sa-loading">Loading users...</div>
          ) : (
            <div className="sa-table-wrap">
              <table className="sa-table">
                <thead>
                  <tr>
                    <th>Username</th>
                    <th>Email</th>
                    <th>Plan</th>
                    <th>Expires</th>
                    <th>Trial</th>
                    <th>Roles</th>
                    <th>Verified</th>
                    <th>Joined</th>
                  </tr>
                </thead>
                <tbody>
                  {(data?.users || []).map(u => (
                    <tr key={u._id}>
                      <td>{u.username}</td>
                      <td className="mono">{u.email}</td>
                      <td>
                        <InlinePlanPicker
                          user={u}
                          disabled={updating[u._id + '_plan']}
                          onApply={changePlan}
                        />
                      </td>
                      <td><ExpiryCell planExpiresAt={u.planExpiresAt} /></td>
                      <td>
                        {u.trialEligible
                          ? <span className="sa-badge ok">eligible</span>
                          : (
                            <button
                              className="sa-btn"
                              style={{ fontSize: 10, padding: '1px 6px' }}
                              disabled={updating[u._id + '_trial']}
                              onClick={() => resetTrial(u._id)}
                            >
                              Reset
                            </button>
                          )
                        }
                      </td>
                      <td>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                          <div style={{ display: 'flex', gap: 3 }}>
                            {(u.roles || []).map(r => <RoleBadge key={r} role={r} />)}
                          </div>
                          <RoleCheckboxes
                            userId={u._id}
                            currentRoles={u.roles || []}
                            disabled={updating[u._id + '_roles']}
                            onChange={changeRoles}
                          />
                        </div>
                      </td>
                      <td>{u.emailVerified ? <span className="sa-badge ok">yes</span> : <span className="sa-badge error">no</span>}</td>
                      <td className="mono">{fmtDate(u.createdAt)}</td>
                    </tr>
                  ))}
                  {(!data?.users?.length) && (
                    <tr><td colSpan={8}><div className="sa-empty">No users found</div></td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}

          {data && data.total > PAGE_SIZE && (
            <div className="sa-pagination">
              <button className="sa-btn" disabled={page === 0} onClick={() => setPage(p => p - 1)}>
                &laquo; Prev
              </button>
              <span>Page {page + 1} of {Math.ceil(data.total / PAGE_SIZE)}</span>
              <button
                className="sa-btn"
                disabled={(page + 1) * PAGE_SIZE >= data.total}
                onClick={() => setPage(p => p + 1)}
              >
                Next &raquo;
              </button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
