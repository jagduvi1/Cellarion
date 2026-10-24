/**
 * ReviewFeed — the review list always belongs to the tab on screen.
 *
 * Switching between Discover and Following starts a new load while the
 * previous tab's may still be in flight. Only the current tab's answer may set
 * the list, the page count and the loading state.
 */

import { render, screen, fireEvent, act } from '@testing-library/react';

vi.mock('../api/reviews', () => ({
  getReviewFeed: vi.fn(),
  getDiscoverFeed: vi.fn(),
}));
vi.mock('../api/profiles', () => ({ searchUsers: vi.fn() }));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ apiFetch: vi.fn(), user: { id: 'me' } }),
}));
vi.mock('react-router-dom', () => ({
  useLocation: () => ({ pathname: '/community' }),
  Link: ({ children }) => <a href="/">{children}</a>,
}));
vi.mock('../components/ReviewCard', () => ({
  default: ({ review }) => <div>{review.title}</div>,
}));
vi.mock('../components/FollowButton', () => ({ default: () => null }));

vi.mock('react-i18next', () => {
  const t = (key) => key;
  return { useTranslation: () => ({ t }) };
});

const { getReviewFeed, getDiscoverFeed } = await import('../api/reviews');
const ReviewFeed = (await import('./ReviewFeed')).default;

const jsonRes = (body, ok = true, status = 200) => ({ ok, status, json: async () => body });

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

const page = (titles, pages = 1) => jsonRes({
  reviews: titles.map((title) => ({ _id: title, title })),
  pages,
});

const isLoading = () => screen.queryByText('common.loading') !== null;

beforeEach(() => {
  vi.clearAllMocks();
});

test('a slower answer for the previous tab does not replace the new tab\'s list', async () => {
  const discover = deferred();
  const following = deferred();
  getDiscoverFeed.mockImplementationOnce(() => discover.promise);
  getReviewFeed.mockImplementationOnce(() => following.promise);

  render(<ReviewFeed />);
  await act(async () => { fireEvent.click(screen.getByText('reviewFeed.following')); });
  expect(getReviewFeed).toHaveBeenCalledTimes(1);

  await act(async () => { following.resolve(page(['Review by someone I follow'])); });
  await act(async () => { discover.resolve(page(['Discover review'], 3)); });

  expect(screen.getByText('Review by someone I follow')).toBeInTheDocument();
  expect(screen.queryByText('Discover review')).not.toBeInTheDocument();
  // The stale answer had more pages; its page count must not offer "Load more".
  expect(screen.queryByText('reviewFeed.loadMore')).not.toBeInTheDocument();
  expect(isLoading()).toBe(false);
});

test('loading ends only when the current tab\'s answer arrives', async () => {
  const discover = deferred();
  const following = deferred();
  getDiscoverFeed.mockImplementationOnce(() => discover.promise);
  getReviewFeed.mockImplementationOnce(() => following.promise);

  render(<ReviewFeed />);
  await act(async () => { fireEvent.click(screen.getByText('reviewFeed.following')); });

  await act(async () => { discover.resolve(page(['Discover review'])); });

  expect(screen.queryByText('Discover review')).not.toBeInTheDocument();
  expect(isLoading()).toBe(true);

  await act(async () => { following.resolve(page(['Review by someone I follow'])); });

  expect(screen.getByText('Review by someone I follow')).toBeInTheDocument();
  expect(isLoading()).toBe(false);
});

test('a "Load more" started under the previous tab does not append into the new list', async () => {
  const more = deferred();
  getDiscoverFeed
    .mockResolvedValueOnce(page(['Discover page 1'], 2))
    .mockImplementationOnce(() => more.promise);
  getReviewFeed.mockResolvedValueOnce(page(['Following page 1']));

  render(<ReviewFeed />);
  expect(await screen.findByText('Discover page 1')).toBeInTheDocument();

  await act(async () => { fireEvent.click(screen.getByText('reviewFeed.loadMore')); });
  await act(async () => { fireEvent.click(screen.getByText('reviewFeed.following')); });
  expect(screen.getByText('Following page 1')).toBeInTheDocument();

  await act(async () => { more.resolve(page(['Discover page 2'], 2)); });

  expect(screen.getByText('Following page 1')).toBeInTheDocument();
  expect(screen.queryByText('Discover page 2')).not.toBeInTheDocument();
});
