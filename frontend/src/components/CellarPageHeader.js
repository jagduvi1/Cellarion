import { Link } from 'react-router-dom';
import './CellarPageHeader.css';

/**
 * Standard header block that sits ABOVE <CellarNav> on every cellar subpage.
 * A fixed shape (back-link row → title + always-reserved subtitle line, with an
 * optional right-side action slot) means the nav strip always anchors at the
 * same vertical position, so it no longer "jumps" as the user moves between
 * Bottles / Racks / Room / History / Cellar Book.
 *
 *   backTo, backLabel   — the shared back-link
 *   title               — cellar name / page title (string or node)
 *   subtitle            — one optional line; its space is ALWAYS reserved
 *   loading             — swap the h1 for a skeleton
 *   userColor           — left accent border on the h1
 *   titleBadge          — optional inline node after the h1 (e.g. shared-by / Beta)
 *   actions             — right-aligned action slot (buttons / menus)
 */
function CellarPageHeader({ backTo, backLabel, title, subtitle, loading, userColor, titleBadge, actions }) {
  return (
    <div className="cellar-page-header">
      <Link to={backTo} className="back-link">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"/></svg>
        {backLabel}
      </Link>
      <div className="cellar-page-header-main">
        <div className="cellar-page-header-titles">
          {loading ? (
            <div className="cph-skeleton-h1" />
          ) : (
            <h1 className={userColor ? 'cellar-accent-border' : ''} style={userColor ? { '--cellar-color': userColor } : undefined}>
              {title}{titleBadge}
            </h1>
          )}
          <p className="cellar-page-subtitle">{loading ? '' : subtitle}</p>
        </div>
        {actions && <div className="cellar-page-header-actions">{actions}</div>}
      </div>
    </div>
  );
}

export default CellarPageHeader;
