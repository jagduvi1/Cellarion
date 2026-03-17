import { useState } from 'react';
import './ImageCarousel.css';
import AuthImage from './AuthImage';

const API_URL = process.env.REACT_APP_API_URL || '';

function ImageCarousel({ images, size = 'medium', defaultImageId, onSetDefault }) {
  const [currentIndex, setCurrentIndex] = useState(0);

  if (!images || images.length === 0) return null;

  const goToPrev = () => {
    setCurrentIndex((prev) => (prev === 0 ? images.length - 1 : prev - 1));
  };

  const goToNext = () => {
    setCurrentIndex((prev) => (prev === images.length - 1 ? 0 : prev + 1));
  };

  const currentImage = images[currentIndex];
  const src = currentImage.processedUrl || currentImage.originalUrl;
  const fullSrc = src.startsWith('http') ? src : `${API_URL}${src}`;
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
                className={`carousel-dot ${i === currentIndex ? 'active' : ''} ${defaultImageId && img._id === defaultImageId ? 'is-default' : ''}`}
                onClick={() => setCurrentIndex(i)}
                aria-label={`Go to image ${i + 1}`}
                aria-current={i === currentIndex ? 'true' : undefined}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export default ImageCarousel;
