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
