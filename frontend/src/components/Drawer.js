import { useEffect } from 'react';
import './Drawer.css';

/**
 * Right-side slide-in panel. Keeps the page (e.g. the list behind it) visible,
 * unlike a centered modal. Sticky header + footer with a scrollable body, so
 * action buttons stay reachable no matter how long the form is. Closes on
 * Escape or overlay click.
 *
 *   <Drawer title="Edit wine" onClose={close} footer={<>…buttons…</>}>
 *     …form…
 *   </Drawer>
 */
function Drawer({ title, onClose, children, footer, width }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="drawer-overlay" onClick={onClose}>
      <div
        className="drawer-panel"
        style={width ? { width } : undefined}
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="drawer-header">
          <h2>{title}</h2>
          <button type="button" className="drawer-close" onClick={onClose} aria-label="Close">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="drawer-body">{children}</div>
        {footer && <div className="drawer-footer">{footer}</div>}
      </div>
    </div>
  );
}

export default Drawer;
