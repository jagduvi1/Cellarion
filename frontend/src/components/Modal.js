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
function Modal({ title, onClose, children, wide }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className={`modal-box${wide ? ' modal-box--wide' : ''}`} onClick={e => e.stopPropagation()}>
        {title && <h2>{title}</h2>}
        {children}
      </div>
    </div>
  );
}

export default Modal;
