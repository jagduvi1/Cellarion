import { useEffect, useId, useRef } from 'react';
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
 *
 * Always carries dialog semantics (role="dialog" + aria-modal). Pass
 * `trapFocus` for modals that must hold focus (e.g. a blocking/non-dismissible
 * modal): on open it moves focus into the dialog and keeps Tab inside it.
 */
function Modal({ title, onClose, children, wide, showClose, boxStyle, trapFocus = false }) {
  const titleId = useId();
  const boxRef = useRef(null);

  // Escape closes the dialog, independent of the optional focus trap — mirrors
  // Drawer.js so every shared-Modal dialog is keyboard-dismissible.
  useEffect(() => {
    if (!onClose) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose(e); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    if (!trapFocus) return;
    const box = boxRef.current;
    if (!box) return;
    // tabIndex -1 is OUT of the tab order by definition — the unchecked members
    // of a roving-tabindex group (the Wine record's type/colour chips). Counting
    // them put the opening focus on an unchecked chip, where Space proposed the
    // wrong type, and let Shift+Tab from the group's real tab stop walk out of
    // the dialog (audit 2026-09-19).
    const focusable = () =>
      Array.from(
        box.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
      ).filter((el) => !el.disabled && el.tabIndex !== -1 && el.offsetParent !== null);

    // Move focus into the dialog on open.
    (focusable()[0] || box).focus();

    const onKeyDown = (e) => {
      if (e.key !== 'Tab') return;
      const items = focusable();
      if (items.length === 0) { e.preventDefault(); return; }
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    box.addEventListener('keydown', onKeyDown);
    return () => box.removeEventListener('keydown', onKeyDown);
  }, [trapFocus]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className={`modal-box${wide ? ' modal-box--wide' : ''}`}
        style={boxStyle}
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        {...(title ? { 'aria-labelledby': titleId } : {})}
        ref={boxRef}
        tabIndex={-1}
      >
        {(title || showClose) && (
          <div className="modal-header">
            {title && <h2 id={titleId}>{title}</h2>}
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
