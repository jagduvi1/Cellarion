import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { sendRecommendation, searchFriends } from '../api/recommendations';
import Modal from './Modal';
import './RecommendWineModal.css';

export default function RecommendWineModal({ wineId, wineName, onClose, onSent }) {
  const { t } = useTranslation();
  const { apiFetch } = useAuth();

  const [mode, setMode] = useState('friend');
  const [query, setQuery] = useState('');
  const [friends, setFriends] = useState([]);
  const [selectedFriend, setSelectedFriend] = useState(null);
  const [email, setEmail] = useState('');
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(false);
  const debounceRef = useRef(null);

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
      setError(t('recommend.selectFriend'));
      return;
    }
    if (mode === 'email' && !email.trim()) {
      setError(t('recommend.enterEmail'));
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

  const recipientName = mode === 'friend' && selectedFriend
    ? selectedFriend.displayName || selectedFriend.username
    : email;

  if (success) {
    return (
      <Modal title={t('recommend.sent')} onClose={onClose}>
        <p className="recommend-success-msg">
          {t('recommend.sentMessagePrefix', 'Your recommendation for')} <strong>{wineName}</strong> {t('recommend.sentMessageSuffix', 'has been sent to')} {recipientName}.
        </p>
        <div className="modal-actions">
          <button className="btn btn-primary" onClick={onClose}>{t('recommend.done')}</button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={t('recommend.title', { wine: wineName || 'Wine' })} onClose={onClose}>
      <form onSubmit={handleSend} className="recommend-form">
        <div className="recommend-mode-toggle">
          <button
            type="button"
            className={`recommend-mode-btn ${mode === 'friend' ? 'active' : ''}`}
            onClick={() => { setMode('friend'); setError(null); }}
          >
            {t('recommend.cellarionUser')}
          </button>
          <button
            type="button"
            className={`recommend-mode-btn ${mode === 'email' ? 'active' : ''}`}
            onClick={() => { setMode('email'); setError(null); }}
          >
            {t('recommend.email')}
          </button>
        </div>

        {mode === 'friend' ? (
          <div className="form-group">
            <label>{t('recommend.searchFollowing')}</label>
            <input
              type="text"
              className="input"
              placeholder={t('recommend.searchPlaceholder')}
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
                {t('recommend.sendingTo')} <strong>{selectedFriend.displayName || selectedFriend.username}</strong>
                <button
                  type="button"
                  className="recommend-clear"
                  onClick={() => { setSelectedFriend(null); setQuery(''); }}
                >
                  {t('recommend.change')}
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="form-group">
            <label htmlFor="recommend-email">{t('recommend.recipientEmail')}</label>
            <input
              id="recommend-email"
              type="email"
              className="input"
              placeholder={t('recommend.emailPlaceholder')}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
            <p className="recommend-email-hint">{t('recommend.emailHint')}</p>
          </div>
        )}

        <div className="form-group">
          <label htmlFor="recommend-note">{t('recommend.personalNote')}</label>
          <textarea
            id="recommend-note"
            className="input"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={t('recommend.notePlaceholder')}
            rows={3}
            maxLength={500}
          />
          <span className="recommend-char-count">{note.length}/500</span>
        </div>

        {error && <div className="alert alert-error">{error}</div>}

        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={sending}>
            {t('recommend.cancel')}
          </button>
          <button type="submit" className="btn btn-primary" disabled={sending}>
            {sending ? t('recommend.sending') : t('recommend.send')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
