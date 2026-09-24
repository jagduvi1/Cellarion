import { render, fireEvent } from '@testing-library/react';
import WineImage from './WineImage';

const FULL = '/api/uploads/processed/0f3b2a1c-1111-4222-8333-944445555666.png';
const THUMB = '/api/uploads/thumbs/processed/0f3b2a1c-1111-4222-8333-944445555666.png.webp';

describe('WineImage', () => {
  it('shows the card-size thumbnail of an upload by default', () => {
    const { container } = render(<WineImage image={FULL} />);
    expect(container.querySelector('img')).toHaveAttribute('src', THUMB);
  });

  it('shows the full image with `full`', () => {
    const { container } = render(<WineImage image={FULL} full />);
    expect(container.querySelector('img')).toHaveAttribute('src', FULL);
  });

  it('leaves an external image alone', () => {
    const { container } = render(<WineImage image="https://example.com/label.png" />);
    expect(container.querySelector('img')).toHaveAttribute('src', 'https://example.com/label.png');
  });

  it('falls back to the full image when the thumbnail fails, then hides on a second failure', () => {
    const { container } = render(<WineImage image={FULL} />);
    fireEvent.error(container.querySelector('img'));
    const img = container.querySelector('img');
    expect(img).toHaveAttribute('src', FULL);
    expect(img.style.display).toBe('');
    fireEvent.error(img);
    expect(img.style.display).toBe('none');
  });

  it('renders the placeholder when there is no image', () => {
    const { container } = render(<WineImage image={null} placeholder="ph" wineType="white" />);
    expect(container.querySelector('.ph.white')).not.toBeNull();
  });
});
