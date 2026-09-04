import { useState, useEffect, useImperativeHandle, forwardRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import ImageCarousel from './ImageCarousel';
import ConfirmModal from './ConfirmModal';
import Modal from './Modal';

// Why a photo might need to come down. Mirrors REPORT_REASONS on
// routes/images.js — the server validates, this only labels.
const REPORT_REASONS = ['private-info', 'not-this-wine', 'poor-quality', 'offensive', 'other'];

const ImageGallery = forwardRef(function ImageGallery({ bottleId, wineDefinitionId, size = 'medium', onEmpty, onLoaded, defaultImageId: externalDefaultId, onSetDefault, showAll = false }, ref) {
  const { apiFetch, user } = useAuth();
  const { t } = useTranslation();
  const [images, setImages] = useState([]);
  const [defaultImageId, setDefaultImageId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [pendingReport, setPendingReport] = useState(null);
  const [actionError, setActionError] = useState('');

  const fetchImages = useCallback(async () => {
    try {
      let endpoint = bottleId
        ? `/api/images/bottle/${bottleId}`
        : `/api/images/wine/${wineDefinitionId}`;
      if (!bottleId && showAll) endpoint += '?all=true';

      const res = await apiFetch(endpoint);
      const data = await res.json();
      if (res.ok) {
        // Coerce before storing: a 200 whose body has no `images` array used to
        // put undefined into state and throw on the next render, taking the
        // whole host page down with it. A gallery that cannot list images must
        // degrade to "no images", never break the page embedding it.
        // ...and drop any row without a file behind it. A rejected photo is a
        // tombstone (both URLs nulled when the admin deleted the files); the
        // server no longer returns those, but the carousel must never be
        // handed a row it cannot render — that is exactly how one rejected
        // photo made a bottle page unreachable for its owner (ticket 2026-09-03).
        const list = (Array.isArray(data.images) ? data.images : [])
          .filter((img) => img && (img.processedUrl || img.originalUrl));
        setImages(list);
        // For bottle images, the API returns defaultImageId
        if (data.defaultImageId) setDefaultImageId(data.defaultImageId);
        if (list.length === 0 && onEmpty) onEmpty();
        // onEmpty only fires for the empty case, so a caller that needs to tell
        // "no images" from "not fetched yet" (AddBottle changes its photo copy
        // on exactly that distinction) has no positive signal. onLoaded gives
        // it one, and is called on EVERY settled outcome including failure —
        // a caller gating UI on it would otherwise render nothing at all,
        // permanently, whenever this endpoint errors.
        if (onLoaded) onLoaded(list.length);
      } else {
        if (onEmpty) onEmpty();
        // A failed load reports 0 rather than staying silent. Conflating
        // "failed" with "none" is deliberate: every caller's fallback for zero
        // is the safe one (offer the upload), whereas a caller left waiting
        // forever shows a broken half-rendered section.
        if (onLoaded) onLoaded(0);
      }
    } catch (err) {
      console.error('Failed to fetch images:', err);
      if (onEmpty) onEmpty();
      if (onLoaded) onLoaded(0);
    } finally {
      setLoading(false);
    }
  }, [apiFetch, bottleId, wineDefinitionId, showAll, onEmpty, onLoaded]);

  useEffect(() => {
    if (!bottleId && !wineDefinitionId) {
      setLoading(false);
      return;
    }
    fetchImages();
  }, [bottleId, wineDefinitionId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Expose refresh method so parents can trigger a re-fetch after uploads
  useImperativeHandle(ref, () => ({
    refresh: fetchImages
  }), [fetchImages]);

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

  // Delete removes the row locally first: the photo is gone from the server by
  // the time this resolves, and leaving it on screen until a refetch lands
  // reads as "it didn't work" on the one action where that matters most.
  const confirmDelete = async () => {
    const img = pendingDelete;
    setPendingDelete(null);
    setActionError('');
    try {
      const res = await apiFetch(`/api/images/${img._id}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setActionError(body.error || t('imageActions.deleteFailed', 'Could not delete the photo.'));
        return;
      }
      setImages((prev) => prev.filter((i) => i._id !== img._id));
    } catch {
      setActionError(t('imageActions.deleteFailed', 'Could not delete the photo.'));
    }
  };

  const submitReport = async (reason) => {
    const img = pendingReport;
    setPendingReport(null);
    setActionError('');
    try {
      const res = await apiFetch(`/api/images/${img._id}/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
      });
      const body = await res.json().catch(() => ({}));
      setActionError(res.ok
        ? (body.message || t('imageActions.reportThanks', 'Thanks — an admin will review this photo.'))
        : (body.error || t('imageActions.reportFailed', 'Could not report the photo.')));
    } catch {
      setActionError(t('imageActions.reportFailed', 'Could not report the photo.'));
    }
  };

  return (
    <>
      <ImageCarousel
        images={images}
        size={size}
        defaultImageId={resolvedDefaultId}
        onSetDefault={handleSetDefault}
        currentUserId={user?._id || user?.id}
        onDelete={setPendingDelete}
        onReport={setPendingReport}
      />
      {actionError && <p className="gallery-action-note">{actionError}</p>}
      {pendingDelete && (
        <ConfirmModal
          title={t('imageActions.deleteTitle', 'Delete this photo?')}
          message={t('imageActions.deleteMessage', 'The photo and its file are removed from the server. This cannot be undone.')}
          confirmLabel={t('imageActions.deleteConfirm', 'Delete photo')}
          confirmClass="btn-danger"
          onConfirm={confirmDelete}
          onCancel={() => setPendingDelete(null)}
        />
      )}
      {pendingReport && (
        <Modal title={t('imageActions.reportTitle', 'Report this photo')} onClose={() => setPendingReport(null)}>
          <p className="gallery-report-lead">
            {t('imageActions.reportLead', 'What is wrong with it? An admin will look — nothing is removed automatically.')}
          </p>
          <div className="gallery-report-reasons">
            {REPORT_REASONS.map((r) => (
              <button key={r} type="button" className="btn btn-secondary" onClick={() => submitReport(r)}>
                {t(`imageActions.reason.${r}`, r)}
              </button>
            ))}
          </div>
        </Modal>
      )}
    </>
  );
});

export default ImageGallery;
