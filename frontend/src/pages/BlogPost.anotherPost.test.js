/**
 * The blog post page stays mounted when its address changes to another post
 * (Back and Forward do it without leaving the app). A post that failed to load
 * left its "not found" on the next post, which then never showed. The page is
 * keyed by its address: another post is a fresh page.
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route, Link } from 'react-router-dom';

// Stable identities: both are effect dependencies in the page.
const { getBlogPostMock, getDiscussionsMock, i18n, auth } = vi.hoisted(() => ({
  getBlogPostMock: vi.fn(),
  getDiscussionsMock: vi.fn(),
  i18n: { t: (key) => key },
  auth: { user: null, apiFetch: vi.fn() },
}));

vi.mock('react-i18next', () => ({ useTranslation: () => i18n }));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('../components/SEOHead', () => ({ default: () => null }));
vi.mock('../api/blog', () => ({ getBlogPost: getBlogPostMock }));
vi.mock('../api/discussions', () => ({ getDiscussions: getDiscussionsMock }));

const BlogPost = (await import('./BlogPost')).default;

const post = (n) => ({ _id: `post${n}`, slug: `post-${n}`, title: `Post ${n}`, content: `<p>Body ${n}</p>` });
const threadsOf = { post1: [{ _id: 'd1', slug: 'about-post-1', title: 'About post 1' }], post2: [] };

beforeEach(() => {
  vi.clearAllMocks();
  getBlogPostMock.mockImplementation(async (apiFetch, slug) => {
    if (slug === 'unreachable') throw new Error('offline');
    return { ok: true, json: async () => ({ post: post(slug.slice(-1)) }) };
  });
  getDiscussionsMock.mockImplementation(async (apiFetch, params) => {
    const id = /blogPost=(\w+)/.exec(params)[1];
    if (id === 'post2') throw new Error('offline');
    return { ok: true, json: async () => ({ discussions: threadsOf[id] }) };
  });
});

const renderAt = (slug) => render(
  <MemoryRouter initialEntries={[`/blog/${slug}`]}>
    <Link to="/blog/post-2">to post 2</Link>
    <Routes>
      <Route path="/blog/:slug" element={<BlogPost />} />
    </Routes>
  </MemoryRouter>,
);

it('a post that could not be loaded does not leave its "not found" on the next post', async () => {
  renderAt('unreachable');
  expect(await screen.findByText('blog.postNotFound')).toBeInTheDocument();

  fireEvent.click(screen.getByText('to post 2'));

  expect(await screen.findByText('Body 2')).toBeInTheDocument();
  expect(screen.queryByText('blog.postNotFound')).not.toBeInTheDocument();
});

it('the next post does not list the threads of the post before', async () => {
  renderAt('post-1');
  expect(await screen.findByText('About post 1')).toBeInTheDocument();

  // Post 2's own thread list cannot be read; the page then shows none.
  fireEvent.click(screen.getByText('to post 2'));

  expect(await screen.findByText('Body 2')).toBeInTheDocument();
  expect(screen.queryByText('About post 1')).not.toBeInTheDocument();
});
