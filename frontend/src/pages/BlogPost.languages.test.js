/**
 * The line that leads from one version of a post to the others. The blog
 * lists the originals only, so this line is how a reader reaches a
 * translation, and how a reader who landed on a translation from a search
 * finds the original: a translation says what it was translated from and
 * links the original; an original lists its translations in their own
 * languages; a post in one language shows nothing.
 */
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const { getBlogPostMock, i18n, auth } = vi.hoisted(() => ({
  getBlogPostMock: vi.fn(),
  i18n: { t: (key, vars) => (vars && vars.language ? `${key}:${vars.language}` : key), i18n: { language: 'en' } },
  auth: { user: null, apiFetch: vi.fn() },
}));

vi.mock('react-i18next', () => ({ useTranslation: () => i18n }));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('../components/SEOHead', () => ({ default: () => null }));
vi.mock('../api/blog', () => ({ getBlogPost: getBlogPostMock }));
vi.mock('../api/discussions', () => ({ getDiscussions: async () => ({ ok: true, json: async () => ({ discussions: [] }) }) }));

const BlogPost = (await import('./BlogPost')).default;

const ORIGINAL = { _id: 'p1', slug: 'drink-windows', title: 'Drink windows', content: '<p>Body</p>', language: 'en', translationOf: null };
const SWEDISH = { _id: 'p2', slug: 'drickfonster', title: 'Drickfönster', content: '<p>Text</p>', language: 'sv', translationOf: 'p1' };
const ALTERNATES = [
  { language: 'en', slug: 'drink-windows', original: true },
  { language: 'fr', slug: 'fenetres', original: false },
  { language: 'sv', slug: 'drickfonster', original: false },
];

const open = (post, alternates) => {
  getBlogPostMock.mockResolvedValue({ ok: true, json: async () => ({ post, alternates }) });
  return render(
    <MemoryRouter initialEntries={[`/blog/${post.slug}`]}>
      <Routes><Route path="/blog/:slug" element={<BlogPost />} /></Routes>
    </MemoryRouter>,
  );
};

it('an original lists its translations, each named in its own language', async () => {
  open(ORIGINAL, ALTERNATES);
  const swedish = await screen.findByText('Svenska');
  expect(swedish.closest('a')).toHaveAttribute('href', '/blog/drickfonster');
  expect(swedish.closest('a')).toHaveAttribute('hreflang', 'sv');
  expect(screen.getByText('Français').closest('a')).toHaveAttribute('href', '/blog/fenetres');
  expect(screen.getByText(/blog\.alsoIn/)).toBeInTheDocument();
  // Not a link to itself.
  expect(screen.queryByText('English')).not.toBeInTheDocument();
});

it('a translation says what it was translated from and links the original', async () => {
  open(SWEDISH, ALTERNATES);
  expect(await screen.findByText(/blog\.translatedFrom:English/)).toBeInTheDocument();
  expect(screen.getByText('blog.readOriginal').closest('a')).toHaveAttribute('href', '/blog/drink-windows');
  expect(screen.queryByText(/blog\.alsoIn/)).not.toBeInTheDocument();
});

it('a post in one language shows no language line', async () => {
  open({ ...ORIGINAL, slug: 'storing-wine', title: 'Storing wine' }, []);
  expect(await screen.findByText('Storing wine', { selector: 'h1' })).toBeInTheDocument();
  expect(screen.queryByText(/blog\.alsoIn/)).not.toBeInTheDocument();
  expect(screen.queryByText(/blog\.translatedFrom/)).not.toBeInTheDocument();
});
