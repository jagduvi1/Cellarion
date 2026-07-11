import { useEffect, useRef } from 'react';

/**
 * A11y wiring for hand-rolled modal dialogs that build their own
 * `.modal-overlay` + box instead of using the shared <Modal> component.
 *
 * Attach the returned ref to the dialog box element and spread the usual
 * dialog attributes (role="dialog" aria-modal="true" aria-labelledby tabIndex={-1}).
 * This hook then:
 *   - moves focus into the dialog on open (first focusable, else the box), and
 *   - closes the dialog on Escape (mirrors the shared Modal / Drawer).
 *
 * Purely additive — it does not change layout or markup.
 */
export function useDialogA11y(onClose) {
  const boxRef = useRef(null);
  // Keep the latest onClose in a ref so callers can pass an inline/recreated
  // handler without re-running the mount effect (which would re-steal focus and
  // re-bind the listener on every render).
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const box = boxRef.current;
    if (box) {
      const focusable = box.querySelector(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      (focusable || box).focus();
    }
    const onKey = (e) => {
      if (e.key === 'Escape' && onCloseRef.current) onCloseRef.current(e);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  return boxRef;
}
