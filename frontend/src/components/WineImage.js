import { useState } from 'react';
import { getWineImageUrl } from '../utils/wineImageUrl';
import { thumbUrl } from '../utils/thumbUrl';

/**
 * Unified wine thumbnail component.
 *
 * Resolves the image URL via getWineImageUrl, hides the <img> on load error,
 * and optionally renders a coloured placeholder when there is no image.
 *
 * Every use but the large ones is a small card or list row, so an uploaded
 * photo is shown as its card-size thumbnail (utils/thumbUrl) by default — about
 * 40× smaller than the full PNG. If the thumbnail fails to load, the full image
 * is tried once before the <img> is hidden. Pass `full` where the image is
 * shown large.
 *
 * Props:
 *  - image       — raw image value from the wine/bottle object (URL, path, or filename)
 *  - alt         — alt text (default "")
 *  - className   — CSS class for the <img>
 *  - wineType    — e.g. "red", "white" — used for placeholder colour
 *  - placeholder — CSS class for the placeholder <div> (omit to render nothing when no image)
 *  - wrapClass   — optional wrapper <div> class (rendered only when image exists)
 *  - credit      — optional image credit text (rendered inside wrapClass if provided)
 *  - creditClass — CSS class for the credit <span>
 *  - loading     — img loading attribute ("lazy" | "eager")
 *  - full        — show the full-size image instead of the thumbnail
 */
function WineImage({ image, alt = '', className, wineType, placeholder, wrapClass, credit, creditClass, loading, full = false }) {
  const fullSrc = getWineImageUrl(image);
  // The full URL whose thumbnail failed — keyed by URL so a new image retries.
  const [thumbFailedFor, setThumbFailedFor] = useState(null);

  if (!fullSrc) {
    return placeholder ? <div className={`${placeholder} ${wineType || 'red'}`} /> : null;
  }

  const thumb = full ? fullSrc : thumbUrl(fullSrc);
  const src = thumbFailedFor === fullSrc ? fullSrc : thumb;

  const img = (
    <img
      src={src}
      alt={alt}
      className={className}
      loading={loading}
      onError={(e) => {
        if (src !== fullSrc) setThumbFailedFor(fullSrc);
        else e.target.style.display = 'none';
      }}
    />
  );

  if (wrapClass) {
    return (
      <div className={wrapClass}>
        {img}
        {credit && <span className={creditClass}>{credit}</span>}
      </div>
    );
  }

  return img;
}

export default WineImage;
