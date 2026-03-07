import { useState } from 'react';
import './ImageCarousel.css';

const API_URL = process.env.REACT_APP_API_URL || '';

function ImageCarousel({ images, size = 'medium' }) {
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

  return (
    <div className={`image-carousel carousel-${size}`}>
      <div className="carousel-viewport">
        <img
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
      </div>

      {images.length > 1 && (
        <>
          <button className="carousel-btn carousel-prev" onClick={goToPrev} type="button">
            ‹
          </button>
          <button className="carousel-btn carousel-next" onClick={goToNext} type="button">
            ›
          </button>
          <div className="carousel-dots">
            {images.map((_, i) => (
              <button
                key={i}
                type="button"
                className={`carousel-dot ${i === currentIndex ? 'active' : ''}`}
                onClick={() => setCurrentIndex(i)}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export default ImageCarousel;
