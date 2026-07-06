import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { getRecommendations, getSentRecommendations, updateRecommendationStatus, deleteRecommendation } from '../api/recommendations';
import { addToWishlist } from '../api/wishlist';
import './Recommendations.css';

import WineImage from '../components/WineImage';
import ConfirmModal from '../components/ConfirmModal';
import timeAgo from '../utils/timeAgo';

const PAGE_SIZE = 50; // backend caps recommendation pages at 50

export default function Recommendations() {
  const { t } = useTranslation();
  const { apiFetch } = useAuth();
  const [tab, setTab] = useState('received');
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [message, setMessage] = useState(null); // { type: 'info' | 'error', text }
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);

  useEffect(() => {
    fetchItems();
  }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

  // Latest-wins guard: a slow response for the previous tab must not
  // overwrite the list for the tab the user is now viewing.
  const fetchSeq = useRef(0);

  const fetchItems = async (loadMore = false) => {
    const seq = ++fetchSeq.current;
    if (loadMore) setLoadingMore(true); else setLoading(true);
    try {
      const fetcher = tab === 'received' ? getRecommendations : getSentRecommendations;
      // Request pages explicitly — without a limit the backend serves its
      // default (20) while the tab badge shows the full total.
      const params = new URLSearchParams();
      params.set('limit', String(PAGE_SIZE));
      if (loadMore) params.set('skip', String(items.length));
      const res = await fetcher(apiFetch, params.toString());
      if (res.ok && seq === fetchSeq.current) {
        const data = await res.json();
        setItems(prev => loadMore ? [...prev, ...(data.items || [])] : (data.items || []));
        setTotal(data.total || 0);
      }
    } catch { /* ignore */ }
    if (seq === fetchSeq.current) {
      setLoading(false);
      setLoadingMore(false);
    }
  };

  const handleMarkSeen = async (id) => {
    const res = await updateRecommendationStatus(apiFetch, id, 'seen');
    if (res.ok) {
      setItems((prev) => prev.map((r) => r._id === id ? { ...r, status: 'seen' } : r));
    }
  };

  const handleDelete = async (id) => {
    try {
      const res = await deleteRecommendation(apiFetch, id);
      if (res.ok) {
        setItems(prev => prev.filter(r => r._id !== id));
        setTotal(prev => prev - 1);
      }
    } catch { /* ignore */ }
    setConfirmDeleteId(null);
  };

  const handleAddToWishlist = async (rec) => {
    if (!rec.wine?._id) return; // wine was deleted from the registry
    setMessage(null);
    try {
      const res = await addToWishlist(apiFetch, { wineDefinitionId: rec.wine._id });
      if (res.ok) {
        await updateRecommendationStatus(apiFetch, rec._id, 'added-to-wishlist');
        setItems((prev) => prev.map((r) => r._id === rec._id ? { ...r, status: 'added-to-wishlist' } : r));
      } else if (res.status === 409) {
        setMessage({ type: 'info', text: t('recommendations.alreadyOnWishlist', 'This wine is already on your wishlist.') });
      } else {
        setMessage({ type: 'error', text: t('recommendations.addFailed', 'Could not add to wishlist. Please try again.') });
      }
    } catch {
      setMessage({ type: 'error', text: t('recommendations.addFailed', 'Could not add to wishlist. Please try again.') });
    }
  };

  return (
    <div className="recommendations-page">
      <h1>{t('recommendations.title')}</h1>

      <div className="rec-tabs">
        <button
          className={`rec-tab ${tab === 'received' ? 'active' : ''}`}
          onClick={() => setTab('received')}
        >
          {t('recommendations.received')} {tab === 'received' && total > 0 ? `(${total})` : ''}
        </button>
        <button
          className={`rec-tab ${tab === 'sent' ? 'active' : ''}`}
          onClick={() => setTab('sent')}
        >
          {t('recommendations.sent')} {tab === 'sent' && total > 0 ? `(${total})` : ''}
        </button>
      </div>

      {message && (
        <div className={`alert ${message.type === 'error' ? 'alert-error' : 'alert-info'}`}>{message.text}</div>
      )}

      {loading ? (
        <p className="rec-loading">{t('recommendations.loading')}</p>
      ) : items.length === 0 ? (
        <div className="rec-empty">
          <p>
            {tab === 'received'
              ? t('recommendations.emptyReceived')
              : t('recommendations.emptySent')}
          </p>
        </div>
      ) : (
        <ul className="rec-list">
          {items.map((rec) => (
            <li key={rec._id} className={`rec-card ${rec.status === 'pending' && tab === 'received' ? 'rec-card--unread' : ''}`}>
              <div className="rec-card__wine">
                <WineImage image={rec.wine?.image} className="rec-card__img" />
                <div className="rec-card__info">
                  <strong className="rec-card__name">{rec.wine?.name || 'Unknown wine'}</strong>
                  {rec.wine?.producer && (
                    <span className="rec-card__producer">{rec.wine.producer}</span>
                  )}
                  {rec.wine?.appellation && (
                    <span className="rec-card__appellation">{rec.wine.appellation}</span>
                  )}
                </div>
              </div>

              <div className="rec-card__meta">
                {tab === 'received' ? (
                  <span>
                    {t('recommendations.from')} <Link to={`/users/${rec.sender?._id}`} className="rec-card__user">
                      {rec.sender?.displayName || rec.sender?.username || 'Unknown'}
                    </Link>
                  </span>
                ) : (
                  <span>
                    {t('recommendations.to')} {rec.recipient
                      ? <Link to={`/users/${rec.recipient._id}`} className="rec-card__user">
                          {rec.recipient.displayName || rec.recipient.username}
                        </Link>
                      : <span>{rec.recipientEmail}</span>
                    }
                  </span>
                )}
                <span className="rec-card__time">{timeAgo(rec.createdAt)}</span>
              </div>

              {rec.note && (
                <p className="rec-card__note">"{rec.note}"</p>
              )}

              {tab === 'received' && (
                <div className="rec-card__actions">
                  {rec.status === 'pending' && (
                    <button
                      className="btn btn-small btn-secondary"
                      onClick={() => handleMarkSeen(rec._id)}
                    >
                      {t('recommendations.markSeen')}
                    </button>
                  )}
                  {rec.status !== 'added-to-wishlist' && (
                    <button
                      className="btn btn-small btn-primary"
                      onClick={() => handleAddToWishlist(rec)}
                      disabled={!rec.wine?._id}
                      title={!rec.wine?._id ? t('recommendations.wineRemoved', 'This wine is no longer in the registry') : undefined}
                    >
                      {t('recommendations.addToWishlist')}
                    </button>
                  )}
                  {rec.status === 'added-to-wishlist' && (
                    <span className="rec-card__badge">{t('recommendations.addedToWishlist')}</span>
                  )}
                  <button
                    className="btn btn-small btn-danger"
                    onClick={() => setConfirmDeleteId(rec._id)}
                  >
                    {t('recommendations.delete', 'Delete')}
                  </button>
                </div>
              )}

              {tab === 'sent' && (
                <div className="rec-card__status">
                  <span className={`rec-status rec-status--${rec.status}`}>
                    {rec.status === 'pending' ? t('recommendations.statusPending') : rec.status === 'seen' ? t('recommendations.statusSeen') : t('recommendations.statusAddedToWishlist')}
                  </span>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {!loading && items.length < total && (
        <div className="rec-load-more" style={{ textAlign: 'center', marginTop: '1rem' }}>
          <button className="btn btn-secondary" onClick={() => fetchItems(true)} disabled={loadingMore}>
            {loadingMore ? t('common.loading') : t('recommendations.loadMore', 'Load more')}
          </button>
        </div>
      )}

      {confirmDeleteId && (
        <ConfirmModal
          title={t('recommendations.delete', 'Delete')}
          message={t('recommendations.confirmDelete', 'Delete this recommendation?')}
          onConfirm={() => handleDelete(confirmDeleteId)}
          onCancel={() => setConfirmDeleteId(null)}
        />
      )}
    </div>
  );
}
