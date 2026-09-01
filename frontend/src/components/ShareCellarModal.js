import { useState, useEffect, useId } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { transferCellarOwnership } from '../api/cellars';
import { useDialogA11y } from '../utils/useDialogA11y';
import './ShareCellarModal.css';

function ShareCellarModal({ cellarId, cellarName, onClose }) {
  const { apiFetch } = useAuth();
  const { t } = useTranslation();
  // Two-step rather than window.confirm: handing over a cellar is not something
  // to do on a mis-click, and a native confirm is neither styleable nor
  // reliably announced to a screen reader.
  const [confirmTransfer, setConfirmTransfer] = useState(null);
  const [transferring, setTransferring] = useState(false);
  const [members, setMembers] = useState([]);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('viewer');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const titleId = useId();
  const boxRef = useDialogA11y(onClose);

  useEffect(() => {
    fetchMembers();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const fetchMembers = async () => {
    try {
      const res = await apiFetch(`/api/cellars/${cellarId}/members`);
      const data = await res.json();
      if (res.ok) setMembers(data.members);
    } catch {}
  };

  const handleAdd = async (e) => {
    e.preventDefault();
    setAdding(true);
    setError(null);
    setSuccess(null);

    try {
      const res = await apiFetch(`/api/cellars/${cellarId}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), role })
      });
      const data = await res.json();
      if (res.ok || (res.status === 202 && data.invited)) {
        if (data.invited) {
          setEmail('');
          setSuccess(data.message);
        } else {
          setMembers(data.members);
          setEmail('');
          setSuccess('Member added successfully.');
        }
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
      const res = await apiFetch(`/api/cellars/${cellarId}/members/${userId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
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
      const res = await apiFetch(`/api/cellars/${cellarId}/members/${userId}`, {
        method: 'DELETE'
      });
      if (res.ok) {
        setMembers(prev => prev.filter(m => m.user._id !== userId));
      } else {
        const data = await res.json();
        setError(data.error || 'Failed to remove member');
      }
    } catch {
      setError('Network error');
    }
  };

  const handleTransfer = async (userId) => {
    setTransferring(true);
    setError(null);
    try {
      const res = await transferCellarOwnership(apiFetch, cellarId, userId);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || t('shareCellar.transferFailed', 'Failed to transfer ownership'));
        return;
      }
      // Ownership is gone, so this modal's own controls no longer apply to us.
      // Reloading is blunt but honest: every screen behind it is now showing a
      // cellar we merely edit.
      window.location.reload();
    } catch {
      setError(t('shareCellar.transferFailed', 'Failed to transfer ownership'));
    } finally {
      setTransferring(false);
      setConfirmTransfer(null);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="share-modal" onClick={e => e.stopPropagation()} ref={boxRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <div className="share-modal-header">
          <h2 id={titleId}>Share "{cellarName}"</h2>
          <button className="modal-close-btn" onClick={onClose} aria-label="Close">{'\u2715'}</button>
        </div>

        {error && <div className="alert alert-error">{error}</div>}
        {success && <div className="alert alert-success">{success}</div>}

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
              {adding ? 'Adding\u2026' : 'Add'}
            </button>
          </div>
          <p className="share-role-hint">
            <strong>Viewer</strong> — can browse bottles and racks.{' '}
            <strong>Editor</strong> — can also add and remove bottles.
          </p>
          <p className="share-role-hint">
            {t('shareCellar.transferHint',
              'You can also hand a cellar over entirely: "Make owner" transfers it, along with its bottles and racks, to that person. You stay on as an editor.')}
          </p>
        </form>

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
                    {confirmTransfer === m.user._id ? (
                      <button
                        className="btn-transfer-owner btn-transfer-owner--confirm"
                        onClick={() => handleTransfer(m.user._id)}
                        disabled={transferring}
                      >
                        {transferring
                          ? t('shareCellar.transferring', 'Transferring…')
                          : t('shareCellar.transferConfirm', 'Confirm — give away this cellar')}
                      </button>
                    ) : (
                      <button
                        className="btn-transfer-owner"
                        onClick={() => setConfirmTransfer(m.user._id)}
                        aria-label={`Make ${m.user.username} the owner of this cellar`}
                      >
                        {t('shareCellar.transfer', 'Make owner')}
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}

        {members.length === 0 && (
          <p className="share-empty">Not shared with anyone yet.</p>
        )}
      </div>
    </div>
  );
}

export default ShareCellarModal;
