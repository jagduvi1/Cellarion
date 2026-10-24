/**
 * Discussions — the thread list always belongs to the current filter.
 *
 * Changing the sort, category, search or language section starts a new load
 * while the previous one may still be in flight. Only the load for the filter
 * on screen may set the list, the page count and the loading state; a slower
 * answer for an earlier filter (or a "Load more" started under it) is dropped.
 */

import { render, screen, fireEvent, act } from '@testing-library/react';

vi.mock('../api/discussions', () => ({
  getDiscussions: vi.fn(),
  createDiscussion: vi.fn(),
  getForumLanguages: vi.fn(),
}));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ apiFetch: vi.fn(), user: null }),
}));
vi.mock('react-router-dom', () => ({
  useLocation: () => ({ state: null, pathname: '/community/discussions' }),
}));
vi.mock('../components/DiscussionCard', () => ({
  default: ({ discussion }) => <div>{discussion.title}</div>,
}));
vi.mock('../components/CommunityCTA', () => ({ default: () => null }));
vi.mock('../components/SEOHead', () => ({ default: () => null }));
vi.mock('../components/WineSearchPicker', () => ({ default: () => null }));
vi.mock('../components/DiscussionComposer', () => ({ default: () => null }));

vi.mock('react-i18next', () => {
  const t = (key) => key;
  return { useTranslation: () => ({ t }) };
});

const { getDiscussions, getForumLanguages } = await import('../api/discussions');
const Discussions = (await import('./Discussions')).default;

const jsonRes = (body, ok = true, status = 200) => ({ ok, status, json: async () => body });

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

const page = (titles, pages = 1) => jsonRes({
  discussions: titles.map((title) => ({ _id: title, title })),
  pages,
});

const sortSelect = () => screen.getByDisplayValue('discussions.sortMostActive');
const isLoading = () => screen.queryByText('common.loading') !== null;

beforeEach(() => {
  vi.clearAllMocks();
  getForumLanguages.mockResolvedValue(jsonRes({ languages: [] }));
});

test('a slower answer for the previous sort does not replace the new sort\'s list', async () => {
  const active = deferred();
  const newest = deferred();
  getDiscussions
    .mockImplementationOnce(() => active.promise)
    .mockImplementationOnce(() => newest.promise);

  render(<Discussions />);
  await act(async () => { fireEvent.change(sortSelect(), { target: { value: 'newest' } }); });
  expect(getDiscussions).toHaveBeenCalledTimes(2);
  expect(getDiscussions.mock.calls[1][1]).toContain('sort=newest');

  await act(async () => { newest.resolve(page(['Newest thread'])); });
  await act(async () => { active.resolve(page(['Most active thread'], 3)); });

  expect(screen.getByText('Newest thread')).toBeInTheDocument();
  expect(screen.queryByText('Most active thread')).not.toBeInTheDocument();
  // The stale answer had more pages; its page count must not offer "Load more".
  expect(screen.queryByText('discussions.loadMore')).not.toBeInTheDocument();
  expect(isLoading()).toBe(false);
});

test('loading ends only when the current filter\'s answer arrives', async () => {
  const general = deferred();
  const tasting = deferred();
  getDiscussions
    .mockImplementationOnce(() => general.promise)
    .mockImplementationOnce(() => tasting.promise);

  render(<Discussions />);
  await act(async () => { fireEvent.click(screen.getByText('discussions.categories.tasting-notes')); });
  expect(getDiscussions.mock.calls[1][1]).toContain('category=tasting-notes');

  await act(async () => { general.resolve(page(['Any category thread'])); });

  expect(screen.queryByText('Any category thread')).not.toBeInTheDocument();
  expect(isLoading()).toBe(true);

  await act(async () => { tasting.resolve(page(['Tasting thread'])); });

  expect(screen.getByText('Tasting thread')).toBeInTheDocument();
  expect(isLoading()).toBe(false);
});

test('a "Load more" started under the previous filter does not append into the new list', async () => {
  const more = deferred();
  getDiscussions
    .mockResolvedValueOnce(page(['Active page 1'], 2))
    .mockImplementationOnce(() => more.promise)
    .mockResolvedValueOnce(page(['Newest page 1']));

  render(<Discussions />);
  expect(await screen.findByText('Active page 1')).toBeInTheDocument();

  await act(async () => { fireEvent.click(screen.getByText('discussions.loadMore')); });
  await act(async () => { fireEvent.change(sortSelect(), { target: { value: 'newest' } }); });
  expect(screen.getByText('Newest page 1')).toBeInTheDocument();

  await act(async () => { more.resolve(page(['Active page 2'], 2)); });

  expect(screen.getByText('Newest page 1')).toBeInTheDocument();
  expect(screen.queryByText('Active page 2')).not.toBeInTheDocument();
  expect(screen.queryByText('Active page 1')).not.toBeInTheDocument();
});

test('a failed load for the current filter still shows the error', async () => {
  getDiscussions.mockResolvedValueOnce(jsonRes({ error: 'Nope' }, false, 500));

  render(<Discussions />);

  expect(await screen.findByText('Nope')).toBeInTheDocument();
  expect(isLoading()).toBe(false);
});
