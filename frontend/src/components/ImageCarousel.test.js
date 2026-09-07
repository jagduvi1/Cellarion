import { render, screen } from '@testing-library/react';

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ apiFetch: () => {} }),
}));

const { default: ImageCarousel } = await import('./ImageCarousel');

// Support ticket 2026-09-03: an admin-rejected photo (files deleted, both URLs
// nulled) reached this carousel, `src.startsWith` threw, and the page-level
// ErrorBoundary replaced the whole bottle page with "Something went wrong".
describe('ImageCarousel and a row with no URL', () => {
  test('renders an empty frame instead of throwing', () => {
    const images = [{ _id: 'dead', processedUrl: null, originalUrl: null, status: 'rejected' }];
    expect(() => render(<ImageCarousel images={images} />)).not.toThrow();
    expect(document.querySelector('img')).toBeNull();
  });

  test('a real row still renders its image', async () => {
    render(<ImageCarousel images={[{ _id: 'live', processedUrl: '/api/uploads/processed/live.png', originalUrl: null }]} />);
    const img = await screen.findByRole('img');
    expect(img.getAttribute('src')).toContain('/api/uploads/processed/live.png');
  });
});

// Discussion #1227: the owner could not tell whether a photo was still
// waiting for review or already published. Their own photo now says so.
describe('ImageCarousel state pill', () => {
  test('the owner sees the review state of their own photo; a published one says so', () => {
    const { rerender } = render(<ImageCarousel images={[{ _id: 'a', processedUrl: '/api/uploads/processed/a.png', status: 'processed', mine: true }]} />);
    expect(screen.getByRole('status').textContent).toBe('Awaiting review');
    rerender(<ImageCarousel images={[{ _id: 'a', processedUrl: '/api/uploads/processed/a.png', status: 'approved', mine: true }]} />);
    expect(screen.getByRole('status').textContent).toBe('Published');
  });

  test("someone else's published photo carries no pill", () => {
    render(<ImageCarousel images={[{ _id: 'b', processedUrl: '/api/uploads/processed/b.png', status: 'approved', mine: false }]} />);
    expect(screen.queryByRole('status')).toBeNull();
  });
});
