import { render, screen, fireEvent } from '@testing-library/react';
import DialogBox from './DialogBox';

/**
 * DialogBox is the a11y shell the hand-rolled overlays (slot popups, room
 * consume/blocker, bottle-detail confirms) mount instead of a bare box div
 * (grand-audit H6). These tests pin the contract: dialog semantics, focus
 * moving in on open, Escape closing, and NOT stealing focus from an
 * autoFocus child.
 */
describe('DialogBox', () => {
  test('renders a dialog with aria-modal, the given label, and its children', () => {
    render(
      <DialogBox onClose={() => {}} label="Remove Bottle" className="slot-modal">
        <button>Confirm</button>
      </DialogBox>
    );
    const dialog = screen.getByRole('dialog', { name: 'Remove Bottle' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveClass('slot-modal');
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument();
  });

  test('supports aria-labelledby via labelledBy', () => {
    render(
      <DialogBox onClose={() => {}} labelledBy="dlg-title">
        <h2 id="dlg-title">Slot 4</h2>
      </DialogBox>
    );
    expect(screen.getByRole('dialog', { name: 'Slot 4' })).toBeInTheDocument();
  });

  test('moves focus to the first focusable element on open', () => {
    render(
      <DialogBox onClose={() => {}} label="Confirm">
        <button>Cancel</button>
        <button>OK</button>
      </DialogBox>
    );
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
  });

  test('focuses the box itself when nothing inside is focusable', () => {
    render(
      <DialogBox onClose={() => {}} label="Info">
        <p>Just text</p>
      </DialogBox>
    );
    expect(screen.getByRole('dialog')).toHaveFocus();
  });

  test('does NOT steal focus from an autoFocus child (search-first popups)', () => {
    render(
      <DialogBox onClose={() => {}} label="Place bottle">
        <button aria-label="Close">&times;</button>
        {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
        <input autoFocus aria-label="Search wines" />
      </DialogBox>
    );
    expect(screen.getByRole('textbox', { name: 'Search wines' })).toHaveFocus();
  });

  test('Escape calls onClose; other keys do not', () => {
    const onClose = vi.fn();
    render(<DialogBox onClose={onClose} label="X">body</DialogBox>);
    fireEvent.keyDown(document, { key: 'Enter' });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('Escape listener is removed on unmount', () => {
    const onClose = vi.fn();
    const { unmount } = render(<DialogBox onClose={onClose} label="X">body</DialogBox>);
    unmount();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });

  test('passes className, style and click handlers through to the box div', () => {
    const onClick = vi.fn();
    render(
      <DialogBox onClose={() => {}} label="X" className="room-consume-modal" style={{ maxWidth: 400 }} onClick={onClick}>
        body
      </DialogBox>
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveStyle({ maxWidth: '400px' });
    fireEvent.click(dialog);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
