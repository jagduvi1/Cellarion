import { render, screen, fireEvent } from '@testing-library/react';
import Modal from './Modal';

describe('Modal', () => {
  test('renders children', () => {
    render(<Modal onClose={() => {}}>Hello content</Modal>);
    expect(screen.getByText('Hello content')).toBeInTheDocument();
  });

  test('renders title when provided', () => {
    render(<Modal title="Edit Wine" onClose={() => {}}>body</Modal>);
    expect(screen.getByRole('heading', { name: 'Edit Wine' })).toBeInTheDocument();
  });

  test('does not render an h2 when title is omitted', () => {
    render(<Modal onClose={() => {}}>body</Modal>);
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
  });

  test('calls onClose when overlay is clicked', () => {
    const onClose = jest.fn();
    const { container } = render(<Modal onClose={onClose}>body</Modal>);
    const overlay = container.firstChild;
    fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('does not call onClose when modal box is clicked', () => {
    const onClose = jest.fn();
    render(<Modal onClose={onClose}>body</Modal>);
    fireEvent.click(screen.getByText('body'));
    expect(onClose).not.toHaveBeenCalled();
  });
});
