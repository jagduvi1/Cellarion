import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// The admin by-wine view (support ticket 2026-10-09): each photo shows its
// vintage, the photo a vintage shows is marked, and "Use for <vintage>"
// makes another one that vintage's photo.

vi.mock('react-i18next', () => {
  const t = (key, a, b) => {
    const vars = b && typeof b === 'object' ? b : (a && typeof a === 'object' ? a : undefined);
    return vars ? `${key}:${JSON.stringify(vars)}` : key;
  };
  return { useTranslation: () => ({ t }) };
});
vi.mock('../components/AuthImage', () => ({ default: ({ alt }) => <img alt={alt} /> }));

let api;
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ apiFetch: api, user: { id: 'admin' } }) }));

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const WINE = { _id: 'w1', name: 'Barolo', producer: 'Vajra', image: '/api/uploads/processed/official.webp' };
const img = (id, over) => ({
  _id: id, status: 'approved', visibility: 'public', processedUrl: `/api/uploads/processed/${id}.webp`,
  uploadedBy: { username: 'anna' }, assignedToWine: false, contentHash: id, ...over,
});

beforeEach(() => {
  window.scrollTo = vi.fn(); // jsdom has no scrolling; the page scrolls to top on load
  api = vi.fn(async (url) => {
    if (url.startsWith('/api/admin/images/by-wine')) {
      return ok({
        items: [{
          wine: WINE, imageCount: 3, bottleCount: 2,
          images: [
            img('official', { assignedToWine: true, vintage: null }),
            img('first16', { vintage: '2016', vintageOfficial: true }),
            img('later16', { vintage: '2016', vintageOfficial: false }),
          ],
        }],
        total: 1, page: 1, limit: 12,
      });
    }
    return ok({ ok: true });
  });
});

const { default: AdminImagesByWine } = await import('./AdminImagesByWine');

test('shows each photo\'s vintage, marks the vintage\'s photo, and offers to choose another', async () => {
  render(<MemoryRouter><AdminImagesByWine /></MemoryRouter>);
  expect(await screen.findByText(/admin\.images\.vintagePhoto:\{"vintage":"2016"\}/)).toBeInTheDocument();
  expect(screen.getByText('2016')).toBeInTheDocument();                 // the other 2016 photo, unmarked
  expect(screen.getByText('admin.images.noVintage')).toBeInTheDocument(); // the wine-level official image
  // Only the unmarked photo of a known vintage offers the choice.
  const choose = screen.getAllByText('admin.images.setVintagePhoto:{"vintage":"2016"}');
  expect(choose).toHaveLength(1);

  fireEvent.click(choose[0]);
  await waitFor(() => expect(api).toHaveBeenCalledWith('/api/admin/images/later16/set-vintage-official', { method: 'PUT' }));
});
