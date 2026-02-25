import { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import ImageCarousel from './ImageCarousel';

function ImageGallery({ bottleId, wineDefinitionId, size = 'medium', onEmpty }) {
  const { token } = useAuth();
  const [images, setImages] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!bottleId && !wineDefinitionId) {
      setLoading(false);
      return;
    }
    fetchImages();
  }, [bottleId, wineDefinitionId]);

  const fetchImages = async () => {
    try {
      const endpoint = bottleId
        ? `/api/images/bottle/${bottleId}`
        : `/api/images/wine/${wineDefinitionId}`;

      const res = await fetch(endpoint, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await res.json();
      if (res.ok) {
        setImages(data.images);
        if (data.images.length === 0 && onEmpty) onEmpty();
      } else if (onEmpty) {
        onEmpty();
      }
    } catch (err) {
      console.error('Failed to fetch images:', err);
      if (onEmpty) onEmpty();
    } finally {
      setLoading(false);
    }
  };

  if (loading) return null;
  if (images.length === 0) return null;

  return <ImageCarousel images={images} size={size} />;
}

export default ImageGallery;
