import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { PLAN_NAMES, PLANS } from '../config/plans';
import './AdminUsers.css';

const PAGE_SIZE = 50;
const ALL_ROLES = ['user', 'somm', 'admin'];

function PlanBadge({ plan }) {
  return <span className={`users-badge users-badge--plan users-badge--${plan}`}>{PLANS[plan]?.label || plan}</span>;
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

function AdminUsers() {
  const { token } = useAuth();
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

      const res = await fetch(`/api/admin/users?${params}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
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
  }, [token, filters, offset]);

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

  async function changePlan(userId, newPlan) {
    setUpdating(prev => ({ ...prev, [userId + '_plan']: true }));
    try {
      const res = await fetch(`/api/admin/users/${userId}/plan`, {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan: newPlan })
      });
      const data = await res.json();
      if (res.ok) {
        setUsers(prev => prev.map(u => u._id === userId ? { ...u, plan: data.user.plan } : u));
      } else {
        alert(data.error || 'Failed to change plan');
      }
    } catch {
      alert('Network error');
    } finally {
      setUpdating(prev => ({ ...prev, [userId + '_plan']: false }));
    }
  }

  async function changeRoles(userId, newRoles) {
    setUpdating(prev => ({ ...prev, [userId + '_roles']: true }));
    try {
      const res = await fetch(`/api/admin/users/${userId}/roles`, {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ roles: newRoles })
      });
      const data = await res.json();
      if (res.ok) {
        setUsers(prev => prev.map(u => u._id === userId ? { ...u, roles: data.user.roles } : u));
      } else {
        alert(data.error || 'Failed to change roles');
      }
    } catch {
      alert('Network error');
    } finally {
      setUpdating(prev => ({ ...prev, [userId + '_roles']: false }));
    }
  }

  const totalPages = Math.ceil(total / PAGE_SIZE);
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;

  return (
    <div className="admin-users-page">
      <div className="page-header">
        <h1>Users</h1>
        <span className="users-total">{total} user{total !== 1 ? 's' : ''}</span>
      </div>

      {/* Filters */}
      <form className="users-filters" onSubmit={applyFilters}>
        <input
          className="input"
          type="text"
          placeholder="Search username or email…"
          value={pendingFilters.search}
          onChange={e => setPendingFilters(p => ({ ...p, search: e.target.value }))}
        />
        <select
          className="input"
          value={pendingFilters.plan}
          onChange={e => setPendingFilters(p => ({ ...p, plan: e.target.value }))}
        >
          <option value="">All plans</option>
          {PLAN_NAMES.map(p => (
            <option key={p} value={p}>{PLANS[p].label}</option>
          ))}
        </select>
        <select
          className="input"
          value={pendingFilters.role}
          onChange={e => setPendingFilters(p => ({ ...p, role: e.target.value }))}
        >
          <option value="">All roles</option>
          {ALL_ROLES.map(r => (
            <option key={r} value={r}>{r.charAt(0).toUpperCase() + r.slice(1)}</option>
          ))}
        </select>
        <button type="submit" className="btn btn-primary">Filter</button>
        {(filters.search || filters.plan || filters.role) && (
          <button type="button" className="btn btn-secondary" onClick={clearFilters}>Clear</button>
        )}
      </form>

      {error && <div className="error-message">{error}</div>}

      {loading ? (
        <div className="loading-spinner">Loading users…</div>
      ) : users.length === 0 ? (
        <div className="empty-state">No users found.</div>
      ) : (
        <>
          <div className="users-table-wrap">
            <table className="users-table">
              <thead>
                <tr>
                  <th>Username</th>
                  <th>Email</th>
                  <th>Plan</th>
                  <th>Roles</th>
                  <th>Joined</th>
                </tr>
              </thead>
              <tbody>
                {users.map(u => (
                  <tr key={u._id} className="users-row">
                    <td className="users-username">{u.username}</td>
                    <td className="users-email">{u.email}</td>
                    <td>
                      <div className="users-select-cell">
                        <PlanBadge plan={u.plan} />
                        <select
                          className="users-inline-select"
                          value={u.plan}
                          disabled={updating[u._id + '_plan']}
                          onChange={e => changePlan(u._id, e.target.value)}
                        >
                          {PLAN_NAMES.map(p => (
                            <option key={p} value={p}>{PLANS[p].label}</option>
                          ))}
                        </select>
                      </div>
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
                Previous
              </button>
              <span className="users-page-info">Page {currentPage} of {totalPages}</span>
              <button
                className="btn btn-secondary"
                disabled={offset + PAGE_SIZE >= total}
                onClick={() => setOffset(offset + PAGE_SIZE)}
              >
                Next
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default AdminUsers;
