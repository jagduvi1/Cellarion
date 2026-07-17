import { useDialogA11y } from '../utils/useDialogA11y';

/**
 * Thin a11y shell for hand-rolled dialog boxes that keep their own overlay
 * and styling instead of using the shared <Modal> (custom layouts: slot
 * popups, room overlays, in-page confirms). Renders the box div with the
 * standard dialog semantics and the useDialogA11y wiring — focus moves into
 * the dialog on open, Escape calls onClose.
 *
 * Purely additive: pass the box's existing className/onClick/style through,
 * and name the dialog with `label` (aria-label) or `labelledBy` (the id of
 * the visible title element). Mount it only while the dialog is open — the
 * Escape listener and focus move live for exactly that time.
 */
export default function DialogBox({ onClose, label, labelledBy, children, ...divProps }) {
  const boxRef = useDialogA11y(onClose);
  return (
    <div
      ref={boxRef}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      aria-labelledby={labelledBy}
      tabIndex={-1}
      {...divProps}
    >
      {children}
    </div>
  );
}
