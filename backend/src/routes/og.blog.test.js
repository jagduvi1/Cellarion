/**
 * GET /api/og/blog and GET /api/og/blog/:slug — the crawler-rendered blog
 * index and post.
 *
 * Only published posts are read. A post's body reaches the page through
 * sanitizeBlogHtml; its title and the other fields are escaped for HTML and,
 * in the JSON-LD, cannot end the script block. A post whose headings ask
 * questions or count steps also gets FAQPage or HowTo structured data, from
 * two of them up.
 */

let mockPosts = [];
let mockPost = null;

jest.mock('../models/BlogPost', () => {
  const { mockQuery } = require('./og.testKit');
  return {
    find: jest.fn(() => mockQuery(mockPosts)),
    findOne: jest.fn(() => mockQuery(mockPost)),
  };
});

const BlogPost = require('../models/BlogPost');
const {
  SITE, openPages, graphByType, canonical, metaDescription, forSnapshot,
} = require('./og.testKit');

const HOSTILE = 'Decanting </script><script>alert(1)</script> & "air"';

function post(overrides = {}) {
  return {
    title: 'How long to decant a young red',
    slug: 'how-long-to-decant',
    excerpt: 'An hour is a good start.',
    metaDescription: 'When a young red needs air, and how much.',
    content: '<h2>Why decant</h2><p>Air softens a young, tannic red.</p><ul><li>Pour slowly</li></ul>',
    coverImage: `${SITE}/api/uploads/blog/decanter.webp?v=2`,
    tags: ['serving', 'decanting'],
    author: { username: 'cellarmaster' },
    publishedAt: new Date('2026-03-04T10:00:00.000Z'),
    updatedAt: new Date('2026-03-06T08:30:00.000Z'),
    ...overrides,
  };
}

let pages;

beforeAll(async () => { pages = await openPages(require('./og')); });
afterAll(() => pages.close());

beforeEach(() => {
  mockPosts = [];
  mockPost = null;
  BlogPost.find.mockClear();
  BlogPost.findOne.mockClear();
});

describe('GET /api/og/blog', () => {
  test('lists the published posts with their date and description', async () => {
    mockPosts = [
      post(),
      post({ title: 'Storing wine without a cellar', slug: 'storing-without-a-cellar', metaDescription: '', excerpt: 'A cupboard can do.' }),
      post({ title: 'Undated draft that went live', slug: 'undated', metaDescription: '', excerpt: '', publishedAt: null }),
    ];
    const res = await pages.get('/blog');

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600');
    expect(BlogPost.find).toHaveBeenCalledWith({ status: 'published' });
    expect(canonical(res.html)).toBe(`${SITE}/blog`);
    expect(forSnapshot(res.html)).toMatchSnapshot();
  });

  test('says so when there is no post, and lists none in the JSON-LD', async () => {
    const res = await pages.get('/blog');

    expect(res.status).toBe(200);
    expect(res.html).toContain('<p>No posts yet.</p>');
    expect(graphByType(res.html).CollectionPage.mainEntity.numberOfItems).toBe(0);
  });

  test('a post title cannot end the JSON-LD block or add markup to the page', async () => {
    mockPosts = [post({ title: HOSTILE })];
    const res = await pages.get('/blog');

    expect(graphByType(res.html).CollectionPage.mainEntity.itemListElement[0].name).toBe(HOSTILE);
    expect(res.html).not.toContain('<script>alert(1)');
  });
});

describe('GET /api/og/blog/:slug', () => {
  test('answers 404 for a post that is missing or not published', async () => {
    const res = await pages.get('/blog/not-there');

    expect(res.status).toBe(404);
    expect(res.html).toBe('Not found');
    expect(BlogPost.findOne).toHaveBeenCalledWith({ slug: 'not-there', status: 'published' });
  });

  test('renders the post: head, byline, tags, cover image and the article body', async () => {
    mockPost = post();
    const res = await pages.get('/blog/how-long-to-decant');

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600');
    expect(canonical(res.html)).toBe(`${SITE}/blog/how-long-to-decant`);
    expect(metaDescription(res.html)).toBe('When a young red needs air, and how much.');
    expect(forSnapshot(res.html)).toMatchSnapshot();
  });

  test('a post with no author, cover, tags, description or dates falls back to the site and the title', async () => {
    mockPost = post({
      author: null, coverImage: '', tags: [], metaDescription: '', excerpt: '', publishedAt: null, updatedAt: null,
    });
    const res = await pages.get('/blog/how-long-to-decant');
    const posting = graphByType(res.html).BlogPosting;

    expect(posting.author).toEqual({ '@type': 'Organization', name: 'Cellarion', url: SITE });
    expect(posting.image).toBeUndefined();
    expect(metaDescription(res.html)).toBe('How long to decant a young red — Cellarion Blog');
    expect(res.html).not.toContain('og:image');
    expect(res.html).not.toContain('article:published_time');
    expect(res.html).not.toContain('<time');
    expect(res.html).not.toContain('<p>By ');
    expect(res.html).not.toContain('<p>Tags: ');
  });

  test('two question headings make an FAQPage; one does not', async () => {
    mockPost = post({
      content: '<h2>Does white wine need air?</h2><p>Rarely.</p><h3>How long is too long?</h3><p>Past four hours most reds fade.</p>',
    });
    const two = graphByType((await pages.get('/blog/how-long-to-decant')).html);
    expect(two.FAQPage.mainEntity).toEqual([
      { '@type': 'Question', name: 'Does white wine need air?', acceptedAnswer: { '@type': 'Answer', text: 'Rarely.' } },
      { '@type': 'Question', name: 'How long is too long?', acceptedAnswer: { '@type': 'Answer', text: 'Past four hours most reds fade.' } },
    ]);

    mockPost = post({ content: '<h2>Does white wine need air?</h2><p>Rarely.</p>' });
    const one = graphByType((await pages.get('/blog/how-long-to-decant')).html);
    expect(one.FAQPage).toBeUndefined();
  });

  test('two "Step N" headings make a HowTo with the numbering left out of the step names', async () => {
    mockPost = post({
      content: '<h2>Step 1 — Stand the bottle</h2><p>A day upright.</p><h2>Step 2: Pour</h2><p>Slowly, against the glass.</p>',
    });
    const graph = graphByType((await pages.get('/blog/how-long-to-decant')).html);

    expect(graph.HowTo.step).toEqual([
      { '@type': 'HowToStep', position: 1, name: 'Stand the bottle', text: 'A day upright.' },
      { '@type': 'HowToStep', position: 2, name: 'Pour', text: 'Slowly, against the glass.' },
    ]);
    expect(graph.FAQPage).toBeUndefined();
  });

  test('a title cannot end the JSON-LD block, and the body loses scripts and handlers', async () => {
    mockPost = post({
      title: HOSTILE,
      metaTitle: '',
      content: '<p onclick="steal()">Body</p><script>alert(2)</script><img src="x" onerror="alert(3)">',
    });
    const res = await pages.get('/blog/how-long-to-decant');

    expect(graphByType(res.html).BlogPosting.headline).toBe(HOSTILE);
    expect(res.html).not.toContain('<script>alert(');
    expect(res.html).not.toContain('onclick');
    expect(res.html).not.toContain('onerror');
    expect(res.html).toContain('<h1>Decanting &lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;air&quot;</h1>');
  });
});
