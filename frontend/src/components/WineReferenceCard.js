import { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { getWine } from '../api/wines';
import Modal from './Modal';
import WineImage from './WineImage';
import './WineReferenceCard.css';

/**
 * Compact inline card for a linked wine reference.
 * Click to expand into a modal with full wine details.
 */
export default function WineReferenceCard({ wine }) {
  const { apiFetch } = useAuth();
  const [showModal, setShowModal] = useState(false);
  const [fullWine, setFullWine] = useState(null);
  const [loading, setLoading] = useState(false);

  if (!wine || !wine.name) return null;

  const typeLabel = wine.type ? wine.type.charAt(0).toUpperCase() + wine.type.slice(1) : '';

  const handleClick = async () => {
    setShowModal(true);
    if (fullWine) return;

    setLoading(true);
    try {
      const res = await getWine(apiFetch, wine._id);
      if (res.ok) {
        const data = await res.json();
        setFullWine(data.wine || data);
      }
    } catch {
      // fall back to the inline wine data
    } finally {
      setLoading(false);
    }
  };

  const detail = fullWine || wine;
  const grapes = detail.grapes?.filter(g => g && (g.name || typeof g === 'string')) || [];
  const rating = detail.communityRating;
  const hasRating = rating && rating.reviewCount > 0 && rating.averageNormalized != null;

  return (
    <>
      <button type="button" className="wine-ref-card" onClick={handleClick} title="View wine details">
        <span className={`wine-ref-card__dot ${wine.type || ''}`} />
        <div className="wine-ref-card__info">
          <span className="wine-ref-card__name">{wine.name}</span>
          {wine.producer && <span className="wine-ref-card__producer">{wine.producer}</span>}
        </div>
        <div className="wine-ref-card__meta">
          {typeLabel && <span className="wine-ref-card__type">{typeLabel}</span>}
          {wine.country?.name && <span className="wine-ref-card__country">{wine.country.name}</span>}
        </div>
        <svg className="wine-ref-card__chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="9 18 15 12 9 6"/>
        </svg>
      </button>

      {showModal && (
        <Modal title={detail.name} onClose={() => setShowModal(false)}>
          {loading ? (
            <div className="wine-modal__loading">Loading wine details...</div>
          ) : (
            <div className="wine-modal">
              <WineImage image={detail.image} alt={detail.name} className="wine-modal__image" wrapClass="wine-modal__image-wrap" />
              <div className="wine-modal__header">
                <span className={`wine-modal__type-badge ${detail.type || ''}`}>
                  {detail.type ? detail.type.charAt(0).toUpperCase() + detail.type.slice(1) : 'Wine'}
                </span>
                {hasRating && (
                  <span className="wine-modal__rating">
                    ★ {rating.averageNormalized.toFixed(1)} <span className="wine-modal__rating-count">({rating.reviewCount})</span>
                  </span>
                )}
              </div>

              <dl className="wine-modal__details">
                <div className="wine-modal__row">
                  <dt>Producer</dt>
                  <dd>{detail.producer}</dd>
                </div>
                {detail.country?.name && (
                  <div className="wine-modal__row">
                    <dt>Country</dt>
                    <dd>{detail.country.name}</dd>
                  </div>
                )}
                {detail.region?.name && (
                  <div className="wine-modal__row">
                    <dt>Region</dt>
                    <dd>{detail.region.name}</dd>
                  </div>
                )}
                {detail.appellation && (
                  <div className="wine-modal__row">
                    <dt>Appellation</dt>
                    <dd>{detail.appellation}</dd>
                  </div>
                )}
                {detail.classification && (
                  <div className="wine-modal__row">
                    <dt>Classification</dt>
                    <dd>{detail.classification}</dd>
                  </div>
                )}
                {grapes.length > 0 && (
                  <div className="wine-modal__row">
                    <dt>Grapes</dt>
                    <dd>{grapes.map(g => g.name || g).join(', ')}</dd>
                  </div>
                )}
              </dl>
            </div>
          )}
          <div className="modal-actions">
            <button className="btn btn--secondary" onClick={() => setShowModal(false)}>Close</button>
          </div>
        </Modal>
      )}
    </>
  );
}
