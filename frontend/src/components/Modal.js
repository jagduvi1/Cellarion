import './Modal.css';

/**
 * Reusable modal shell with an overlay, box, title, and action row.
 *
 * Usage:
 *   <Modal title="Edit Cellar" onClose={handleClose}>
 *     <p>Content goes here</p>
 *     <div className="modal-actions">
 *       <button ...>Cancel</button>
 *       <button ...>Save</button>
 *     </div>
 *   </Modal>
 */
function Modal({ title, onClose, children, wide, showClose }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className={`modal-box${wide ? ' modal-box--wide' : ''}`} onClick={e => e.stopPropagation()}>
        {(title || showClose) && (
          <div className="modal-header">
            {title && <h2>{title}</h2>}
            {showClose && (
              <button type="button" className="modal-close-btn" onClick={onClose} aria-label="Close">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            )}
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

export default Modal;
