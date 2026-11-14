/**
 * ReviewCard — the overall impression is clamped to three lines, so "Show
 * more" must appear whenever the clamp hides text (not only when there are
 * aroma / palate / finish notes behind it), and the author can open their
 * review in the edit form from any list that passes onUpdate.
 */

import { render, screen, fireEvent } from '@testing-library/react';

let currentUser;
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ apiFetch: vi.fn(), user: currentUser }),
}));
vi.mock('react-router-dom', () => ({
  Link: ({ children }) => <a href="/">{children}</a>,
}));
vi.mock('react-i18next', () => {
  const t = (key) => key;
  return { useTranslation: () => ({ t }) };
});
vi.mock('../api/reviews', () => ({ toggleLike: vi.fn(), deleteReview: vi.fn() }));
vi.mock('../utils/timeAgo', () => ({ default: () => 'today' }));
vi.mock('./CellarCredBadge', () => ({ default: () => null }));
vi.mock('./RatingDisplay', () => ({ default: () => null }));
vi.mock('./ReviewForm', () => ({
  default: ({ existingReview, onSaved, onClose }) => (
    <button
      type="button"
      onClick={() => {
        onSaved({ ...existingReview, tasting: { overall: 'Edited text' } });
        onClose();
      }}
    >
      edit-form:{existingReview._id}
    </button>
  ),
}));

const ReviewCard = (await import('./ReviewCard')).default;

const AUTHOR = { _id: 'u1', username: 'author' };
const overallOnly = (overrides = {}) => ({
  _id: 'r1',
  author: AUTHOR,
  rating: 4,
  ratingScale: '5',
  createdAt: '2026-01-01T00:00:00Z',
  tasting: { overall: 'A long overall impression.' },
  ...overrides,
});

// jsdom has no layout: give every element the heights a browser would report.
function layout({ scrollHeight, clientHeight }) {
  vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockReturnValue(scrollHeight);
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(clientHeight);
}

beforeEach(() => { currentUser = { id: 'u1' }; });
afterEach(() => { vi.restoreAllMocks(); });

test('an overall-only review that is clamped offers Show more', () => {
  layout({ scrollHeight: 120, clientHeight: 72 });
  const { container } = render(<ReviewCard review={overallOnly()} />);

  fireEvent.click(screen.getByText('reviews.showMore'));
  expect(container.querySelector('.review-card__tasting')).toHaveClass('expanded');

  // Unclamped, the text fits; "Show less" must stay to fold it again.
  fireEvent.click(screen.getByText('reviews.showLess'));
  expect(container.querySelector('.review-card__tasting')).not.toHaveClass('expanded');
  expect(screen.getByText('reviews.showMore')).toBeInTheDocument();
});

test('an overall-only review that fits shows no Show more', () => {
  layout({ scrollHeight: 48, clientHeight: 48 });
  render(<ReviewCard review={overallOnly()} />);
  expect(screen.queryByText('reviews.showMore')).toBeNull();
});

test('a review with detailed notes offers Show more even when the overall text fits', () => {
  layout({ scrollHeight: 48, clientHeight: 48 });
  render(<ReviewCard review={overallOnly({ tasting: { overall: 'Short.', palate: 'Dark fruit.' } })} />);
  fireEvent.click(screen.getByText('reviews.showMore'));
  expect(screen.getByText('Dark fruit.')).toBeInTheDocument();
});

test('the author can edit their review', async () => {
  const onUpdate = vi.fn();
  render(<ReviewCard review={overallOnly()} onUpdate={onUpdate} />);

  fireEvent.click(screen.getByRole('button', { name: 'reviews.editReview' }));
  fireEvent.click(await screen.findByText('edit-form:r1'));

  expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ _id: 'r1', tasting: { overall: 'Edited text' } }));
  expect(screen.queryByText('edit-form:r1')).toBeNull();
});

test('no Edit on someone else\'s review, nor where the list cannot take the update', () => {
  const { rerender } = render(<ReviewCard review={overallOnly()} />);
  expect(screen.queryByRole('button', { name: 'reviews.editReview' })).toBeNull();

  currentUser = { id: 'someone-else' };
  rerender(<ReviewCard review={overallOnly()} onUpdate={vi.fn()} />);
  expect(screen.queryByRole('button', { name: 'reviews.editReview' })).toBeNull();
});
