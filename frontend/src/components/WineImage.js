import { getWineImageUrl } from '../utils/wineImageUrl';

/**
 * Unified wine thumbnail component.
 *
 * Resolves the image URL via getWineImageUrl, hides the <img> on load error,
 * and optionally renders a coloured placeholder when there is no image.
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
 */
function WineImage({ image, alt = '', className, wineType, placeholder, wrapClass, credit, creditClass, loading }) {
  const src = getWineImageUrl(image);

  if (!src) {
    return placeholder ? <div className={`${placeholder} ${wineType || 'red'}`} /> : null;
  }

  const img = (
    <img
      src={src}
      alt={alt}
      className={className}
      loading={loading}
      onError={(e) => { e.target.style.display = 'none'; }}
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
