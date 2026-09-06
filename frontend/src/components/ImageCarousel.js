import { useState } from 'react';
import './ImageCarousel.css';
import AuthImage from './AuthImage';
import { API_URL } from '../api/apiConstants';

function ImageCarousel({ images, size = 'medium', defaultImageId, onSetDefault, currentUserId, onDelete, onReport }) {
  const [currentIndex, setCurrentIndex] = useState(0);

  if (!images || images.length === 0) return null;

  // Clamp against a stale index — the images array can shrink between
  // refreshes (e.g. an image rejected server-side) while a high index is
  // still in state, and images[currentIndex] would be undefined.
  const index = Math.min(currentIndex, images.length - 1);

  const goToPrev = () => {
    setCurrentIndex(index === 0 ? images.length - 1 : index - 1);
  };

  const goToNext = () => {
    setCurrentIndex(index === images.length - 1 ? 0 : index + 1);
  };

  const currentImage = images[index];
  const src = currentImage.processedUrl || currentImage.originalUrl || null;
  // A row with no URL (a rejected tombstone that slipped through) renders an
  // empty frame instead of throwing — AuthImage treats a null src as nothing
  // to show. Throwing here unmounts the entire host page via the ErrorBoundary.
  const fullSrc = !src ? null : (src.startsWith('http') ? src : `${API_URL}${src}`);
  const isDefault = defaultImageId && currentImage._id === defaultImageId;

  return (
    <div className={`image-carousel carousel-${size}`}>
      <div className="carousel-viewport">
        <AuthImage
          src={fullSrc}
          alt="Wine bottle"
          className="carousel-image"
          onError={(e) => { e.target.style.display = 'none'; }}
        />
        {currentImage.status === 'processing' && (
          <div className="carousel-processing">Processing...</div>
        )}
        {currentImage.credit && (
          <div className="carousel-credit">© {currentImage.credit}</div>
        )}
        {/* Removing a photo (ticket 6a865f60). Which verb you get depends on
            whether the photo is still only yours: once it is the wine's
            picture in the shared registry, taking it down changes other
            people's pages, so it becomes a report an admin decides. */}
        {(onDelete || onReport) && (() => {
          // The gallery now says `mine` itself (audit 2026-09 D05-1: uploader
          // ids no longer travel); the uploadedBy comparison stays for any
          // older payload shape.
          const mine = currentImage.mine === true || (currentUserId && currentImage.uploadedBy != null && String(currentImage.uploadedBy) === String(currentUserId));
          const canDelete = mine && !currentImage.assignedToWine;
          if (canDelete && onDelete) {
            return (
              <button
                type="button"
                className="carousel-action-btn"
                onClick={() => onDelete(currentImage)}
                aria-label="Delete this photo"
                title="Delete this photo"
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6M14 11v6" /><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                </svg>
              </button>
            );
          }
          if (!onReport) return null;
          return (
            <button
              type="button"
              className="carousel-action-btn"
              onClick={() => onReport(currentImage)}
              aria-label="Report this photo"
              title="Report this photo"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" /><line x1="4" y1="22" x2="4" y2="15" />
              </svg>
            </button>
          );
        })()}
        {onSetDefault && (
          <button
            type="button"
            className={`carousel-default-btn ${isDefault ? 'is-default' : ''}`}
            onClick={() => onSetDefault(isDefault ? null : currentImage._id)}
            aria-label={isDefault ? 'Remove as default' : 'Set as default image'}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill={isDefault ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
            </svg>
          </button>
        )}
      </div>

      {images.length > 1 && (
        <>
          <button className="carousel-btn carousel-prev" onClick={goToPrev} type="button" aria-label="Previous image">
            ‹
          </button>
          <button className="carousel-btn carousel-next" onClick={goToNext} type="button" aria-label="Next image">
            ›
          </button>
          <div className="carousel-dots">
            {images.map((img, i) => (
              <button
                key={i}
                type="button"
                className={`carousel-dot ${i === index ? 'active' : ''} ${defaultImageId && img._id === defaultImageId ? 'is-default' : ''}`}
                onClick={() => setCurrentIndex(i)}
                aria-label={`Go to image ${i + 1}`}
                aria-current={i === index ? 'true' : undefined}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export default ImageCarousel;
