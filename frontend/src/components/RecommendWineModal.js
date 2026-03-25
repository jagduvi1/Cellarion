import { useState, useEffect, useRef } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { sendRecommendation, searchFriends } from '../api/recommendations';
import Modal from './Modal';
import './RecommendWineModal.css';

/**
 * Modal for recommending a wine to a friend (in-app user or external email).
 *
 * Props:
 *  - wineId:   WineDefinition _id
 *  - wineName: display name for the header
 *  - onClose:  close callback
 *  - onSent:   optional callback after successful send
 */
export default function RecommendWineModal({ wineId, wineName, onClose, onSent }) {
  const { apiFetch } = useAuth();

  const [mode, setMode] = useState('friend'); // 'friend' | 'email'
  const [query, setQuery] = useState('');
  const [friends, setFriends] = useState([]);
  const [selectedFriend, setSelectedFriend] = useState(null);
  const [email, setEmail] = useState('');
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(false);
  const debounceRef = useRef(null);

  // Search friends as user types
  useEffect(() => {
    if (mode !== 'friend') return;
    if (debounceRef.current) clearTimeout(debounceRef.current);

    debounceRef.current = setTimeout(async () => {
      try {
        const res = await searchFriends(apiFetch, query);
        if (res.ok) {
          const data = await res.json();
          setFriends(data.users || []);
        }
      } catch { /* ignore */ }
    }, 250);

    return () => clearTimeout(debounceRef.current);
  }, [query, mode]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSend = async (e) => {
    e.preventDefault();
    setError(null);

    if (mode === 'friend' && !selectedFriend) {
      setError('Please select a friend');
      return;
    }
    if (mode === 'email' && !email.trim()) {
      setError('Please enter an email address');
      return;
    }

    setSending(true);
    try {
      const payload = {
        wineId,
        note: note.trim(),
        ...(mode === 'friend'
          ? { recipientId: selectedFriend._id }
          : { recipientEmail: email.trim() })
      };

      const res = await sendRecommendation(apiFetch, payload);
      const data = await res.json();

      if (res.ok) {
        setSuccess(true);
        onSent?.(data.recommendation);
      } else {
        setError(data.error || 'Failed to send recommendation');
      }
    } catch {
      setError('Failed to send recommendation');
    } finally {
      setSending(false);
    }
  };

  if (success) {
    return (
      <Modal title="Recommendation Sent" onClose={onClose}>
        <p className="recommend-success-msg">
          Your recommendation for <strong>{wineName}</strong> has been sent
          {mode === 'friend' && selectedFriend
            ? ` to ${selectedFriend.displayName || selectedFriend.username}`
            : ` to ${email}`
          }.
        </p>
        <div className="modal-actions">
          <button className="btn btn-primary" onClick={onClose}>Done</button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={`Recommend: ${wineName || 'Wine'}`} onClose={onClose}>
      <form onSubmit={handleSend} className="recommend-form">
        {/* Mode toggle */}
        <div className="recommend-mode-toggle">
          <button
            type="button"
            className={`recommend-mode-btn ${mode === 'friend' ? 'active' : ''}`}
            onClick={() => { setMode('friend'); setError(null); }}
          >
            Cellarion User
          </button>
          <button
            type="button"
            className={`recommend-mode-btn ${mode === 'email' ? 'active' : ''}`}
            onClick={() => { setMode('email'); setError(null); }}
          >
            Email
          </button>
        </div>

        {mode === 'friend' ? (
          <div className="form-group">
            <label>Search your following list</label>
            <input
              type="text"
              className="input"
              placeholder="Search by username..."
              value={query}
              onChange={(e) => { setQuery(e.target.value); setSelectedFriend(null); }}
            />
            {!selectedFriend && friends.length > 0 && (
              <ul className="recommend-friend-list">
                {friends.map((f) => (
                  <li key={f._id}>
                    <button
                      type="button"
                      className="recommend-friend-item"
                      onClick={() => { setSelectedFriend(f); setQuery(f.displayName || f.username); }}
                    >
                      {f.displayName || f.username}
                      {f.displayName && f.username !== f.displayName && (
                        <span className="recommend-friend-username">@{f.username}</span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {selectedFriend && (
              <div className="recommend-selected">
                Sending to: <strong>{selectedFriend.displayName || selectedFriend.username}</strong>
                <button
                  type="button"
                  className="recommend-clear"
                  onClick={() => { setSelectedFriend(null); setQuery(''); }}
                >
                  Change
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="form-group">
            <label htmlFor="recommend-email">Recipient email</label>
            <input
              id="recommend-email"
              type="email"
              className="input"
              placeholder="friend@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
            <p className="recommend-email-hint">
              They'll receive an email with a link to this wine on Cellarion.
            </p>
          </div>
        )}

        <div className="form-group">
          <label htmlFor="recommend-note">Personal note (optional)</label>
          <textarea
            id="recommend-note"
            className="input"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="You should try this one..."
            rows={3}
            maxLength={500}
          />
          <span className="recommend-char-count">{note.length}/500</span>
        </div>

        {error && <div className="alert alert-error">{error}</div>}

        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={sending}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={sending}>
            {sending ? 'Sending...' : 'Send Recommendation'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
