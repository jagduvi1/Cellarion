import { useState, useEffect } from 'react';
import { usePlan } from '../contexts/AuthContext';
import { formatLimit } from '../config/plans';
import './ShareCellarModal.css';

function ShareCellarModal({ cellarId, cellarName, token, onClose }) {
  const { plan, config } = usePlan();
  const [members, setMembers] = useState([]);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('viewer');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState(null);
  const [limitError, setLimitError] = useState(null);
  const [success, setSuccess] = useState(null);

  const auth = () => ({ 'Authorization': `Bearer ${token}` });

  useEffect(() => {
    fetchMembers();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const fetchMembers = async () => {
    try {
      const res = await fetch(`/api/cellars/${cellarId}/members`, { headers: auth() });
      const data = await res.json();
      if (res.ok) setMembers(data.members);
    } catch {}
  };

  const atLimit = config.maxSharesPerCellar !== -1 && members.length >= config.maxSharesPerCellar;

  const handleAdd = async (e) => {
    e.preventDefault();
    setAdding(true);
    setError(null);
    setLimitError(null);
    setSuccess(null);

    try {
      const res = await fetch(`/api/cellars/${cellarId}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth() },
        body: JSON.stringify({ email: email.trim(), role })
      });
      const data = await res.json();
      if (res.ok) {
        setMembers(data.members);
        setEmail('');
        setSuccess('Member added successfully.');
      } else if (res.status === 403 && data.limitReached === 'shares') {
        setLimitError(data);
      } else {
        setError(data.error || 'Failed to add member');
      }
    } catch {
      setError('Network error');
    } finally {
      setAdding(false);
    }
  };

  const handleRoleChange = async (userId, newRole) => {
    setError(null);
    try {
      const res = await fetch(`/api/cellars/${cellarId}/members/${userId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...auth() },
        body: JSON.stringify({ role: newRole })
      });
      const data = await res.json();
      if (res.ok) setMembers(data.members);
      else setError(data.error || 'Failed to update role');
    } catch {
      setError('Network error');
    }
  };

  const handleRemove = async (userId) => {
    setError(null);
    try {
      const res = await fetch(`/api/cellars/${cellarId}/members/${userId}`, {
        method: 'DELETE',
        headers: auth()
      });
      if (res.ok) {
        setMembers(prev => prev.filter(m => m.user._id !== userId));
        setLimitError(null);
      } else {
        const data = await res.json();
        setError(data.error || 'Failed to remove member');
      }
    } catch {
      setError('Network error');
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="share-modal" onClick={e => e.stopPropagation()}>
        <div className="share-modal-header">
          <h2>Share "{cellarName}"</h2>
          <button className="modal-close-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>

        {error && <div className="alert alert-error">{error}</div>}
        {success && <div className="alert alert-success">{success}</div>}

        {/* Plan share limit notice */}
        {(atLimit || limitError) && (
          <div className="share-limit-notice">
            <span>🔒</span>
            <div>
              <strong>Share limit reached</strong>
              <p>
                Your <strong>{plan.charAt(0).toUpperCase() + plan.slice(1)}</strong> plan allows{' '}
                <strong>{formatLimit(config.maxSharesPerCellar)} shared member{config.maxSharesPerCellar === 1 ? '' : 's'}</strong> per cellar.
                Contact an admin to upgrade your plan.
              </p>
            </div>
          </div>
        )}

        {!atLimit && (
          <form onSubmit={handleAdd} className="share-add-form">
            <label className="share-form-label">Add a person by email</label>
            <div className="share-input-row">
              <input
                type="email"
                className="share-email-input"
                placeholder="friend@example.com"
                value={email}
                onChange={e => setEmail(e.target.value)}
                required
              />
              <select
                className="share-role-select"
                value={role}
                onChange={e => setRole(e.target.value)}
              >
                <option value="viewer">Viewer</option>
                <option value="editor">Editor</option>
              </select>
              <button type="submit" className="btn btn-primary" disabled={adding}>
                {adding ? 'Adding…' : 'Add'}
              </button>
            </div>
            <p className="share-role-hint">
              <strong>Viewer</strong> — can browse bottles and racks.{' '}
              <strong>Editor</strong> — can also add and remove bottles.
            </p>
          </form>
        )}

        {members.length > 0 && (
          <div className="share-members">
            <h3 className="share-members-title">Shared with</h3>
            <ul className="share-members-list">
              {members.map(m => (
                <li key={m.user._id} className="share-member-item">
                  <div className="share-member-info">
                    <span className="share-member-name">{m.user.username}</span>
                    <span className="share-member-email">{m.user.email}</span>
                  </div>
                  <div className="share-member-controls">
                    <select
                      className="share-role-select share-role-select--sm"
                      value={m.role}
                      onChange={e => handleRoleChange(m.user._id, e.target.value)}
                    >
                      <option value="viewer">Viewer</option>
                      <option value="editor">Editor</option>
                    </select>
                    <button
                      className="btn-remove-member"
                      onClick={() => handleRemove(m.user._id)}
                      aria-label={`Remove ${m.user.username}`}
                    >
                      Remove
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}

        {members.length === 0 && !atLimit && (
          <p className="share-empty">Not shared with anyone yet.</p>
        )}
      </div>
    </div>
  );
}

export default ShareCellarModal;
