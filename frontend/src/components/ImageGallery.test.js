import { render, screen, waitFor } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key, fallback) => (typeof fallback === 'string' ? fallback : key) }),
}));

// Hoisted so the AuthContext mock factory may reference it safely.
const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ apiFetch, user: { id: 'u1' } }),
}));

const { default: ImageGallery } = await import('./ImageGallery');

const respondWith = (images) =>
  apiFetch.mockResolvedValue({ ok: true, json: async () => ({ images, defaultImageId: null }) });

const dead = { _id: 'dead', processedUrl: null, originalUrl: null, status: 'rejected', uploadedBy: 'u1' };
const live = { _id: 'live', processedUrl: '/api/uploads/processed/live.png', originalUrl: null, status: 'approved', uploadedBy: 'u1' };

// Support ticket 2026-09-03: the server used to hand the uploader their own
// rejected photo — a tombstone with both URLs nulled — and the gallery passed
// it straight to the carousel, which threw. The gallery must treat a row
// without a file behind it as if it were not there at all.
describe('ImageGallery and rows without a file behind them', () => {
  beforeEach(() => apiFetch.mockReset());

  test('a tombstone is dropped and the real photo still shows', async () => {
    respondWith([dead, live]);
    const onLoaded = vi.fn();
    render(<ImageGallery bottleId="b1" onLoaded={onLoaded} />);

    const img = await screen.findByRole('img');
    expect(img.getAttribute('src')).toContain('live.png');
    expect(onLoaded).toHaveBeenCalledWith(1);
  });

  test('only a tombstone counts as no images', async () => {
    respondWith([dead]);
    const onEmpty = vi.fn();
    const onLoaded = vi.fn();
    const { container } = render(<ImageGallery bottleId="b1" onEmpty={onEmpty} onLoaded={onLoaded} />);

    await waitFor(() => expect(onEmpty).toHaveBeenCalled());
    expect(onLoaded).toHaveBeenCalledWith(0);
    expect(container.querySelector('img')).toBeNull();
  });
});
