/**
 * "Discuss this post" lists the threads opened from this post. getDiscussions
 * adds the '?' itself, so the params it is handed must not start with one:
 * '??blogPost=' reaches the server as a key named '?blogPost', the filter is
 * never applied, and the newest threads site-wide are listed instead.
 */
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

// Stable identities: both are effect dependencies in the page.
const { getDiscussionsMock, i18n, auth } = vi.hoisted(() => ({
  getDiscussionsMock: vi.fn(),
  i18n: { t: (key) => key },
  auth: { user: null, apiFetch: vi.fn() },
}));

vi.mock('react-i18next', () => ({ useTranslation: () => i18n }));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('../components/SEOHead', () => ({ default: () => null }));
vi.mock('../api/blog', () => ({
  getBlogPost: vi.fn(async () => ({
    ok: true,
    json: async () => ({ post: { _id: 'post1', slug: 'a-post', title: 'A post', content: '<p>Body</p>' } }),
  })),
}));
vi.mock('../api/discussions', () => ({ getDiscussions: getDiscussionsMock }));

const BlogPost = (await import('./BlogPost')).default;

it('asks for the threads of this post only', async () => {
  getDiscussionsMock.mockResolvedValue({
    ok: true,
    json: async () => ({ discussions: [{ _id: 'd1', slug: 'about-a-post', title: 'About a post' }] }),
  });

  render(
    <MemoryRouter initialEntries={['/blog/a-post']}>
      <Routes>
        <Route path="/blog/:slug" element={<BlogPost />} />
      </Routes>
    </MemoryRouter>,
  );

  expect(await screen.findByText('About a post')).toBeInTheDocument();
  expect(getDiscussionsMock).toHaveBeenCalledWith(expect.any(Function), 'blogPost=post1&limit=10');
});

it('getDiscussions turns those params into a single query string', async () => {
  const { getDiscussions } = await vi.importActual('../api/discussions');
  const apiFetch = vi.fn();
  getDiscussions(apiFetch, 'blogPost=post1&limit=10');
  expect(apiFetch).toHaveBeenCalledWith('/api/discussions?blogPost=post1&limit=10');
});
