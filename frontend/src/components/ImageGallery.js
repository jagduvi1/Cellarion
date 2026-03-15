import { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import ImageCarousel from './ImageCarousel';

function ImageGallery({ bottleId, wineDefinitionId, size = 'medium', onEmpty, defaultImageId: externalDefaultId, onSetDefault }) {
  const { apiFetch } = useAuth();
  const [images, setImages] = useState([]);
  const [defaultImageId, setDefaultImageId] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!bottleId && !wineDefinitionId) {
      setLoading(false);
      return;
    }
    fetchImages();
  }, [bottleId, wineDefinitionId]); // eslint-disable-line react-hooks/exhaustive-deps

  const fetchImages = async () => {
    try {
      const endpoint = bottleId
        ? `/api/images/bottle/${bottleId}`
        : `/api/images/wine/${wineDefinitionId}`;

      const res = await apiFetch(endpoint);
      const data = await res.json();
      if (res.ok) {
        setImages(data.images);
        // For bottle images, the API returns defaultImageId
        if (data.defaultImageId) setDefaultImageId(data.defaultImageId);
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

  // For wine galleries, the "default" is the one with assignedToWine=true
  const resolvedDefaultId = externalDefaultId || defaultImageId ||
    (wineDefinitionId ? images.find(img => img.assignedToWine)?._id : null) || null;

  // Wrap onSetDefault to update local state optimistically before the API call
  const handleSetDefault = onSetDefault ? async (imageId) => {
    // Save previous state so we can revert on failure
    const prevDefaultId = defaultImageId;
    const prevImages = images;

    // Optimistic update — immediate visual feedback
    if (imageId) {
      setDefaultImageId(imageId);
      setImages(prev => prev.map(img => ({
        ...img,
        assignedToWine: img._id === imageId
      })));
    } else {
      setDefaultImageId(null);
      setImages(prev => prev.map(img => ({
        ...img,
        assignedToWine: false
      })));
    }

    try {
      await onSetDefault(imageId);
    } catch {
      // Revert on failure
      setDefaultImageId(prevDefaultId);
      setImages(prevImages);
    }
  } : undefined;

  return (
    <ImageCarousel
      images={images}
      size={size}
      defaultImageId={resolvedDefaultId}
      onSetDefault={handleSetDefault}
    />
  );
}

export default ImageGallery;
