/**
 * GET /api/og/community/discussions and /community/discussions/:idOrSlug —
 * the crawler-rendered forum list and thread.
 *
 * A discussion's body and its replies are HTML written by members: they reach
 * the page through sanitizeForumHtml, and as plain text in the previews, the
 * meta description and the JSON-LD. An address that names a discussion by id
 * moves permanently to its slug when it has one.
 */

let mockDiscussions = [];
let mockDiscussion = null;
let mockReplies = [];

jest.mock('../models/Discussion', () => {
  const { mockQuery } = require('./og.testKit');
  return {
    find: jest.fn(() => mockQuery(mockDiscussions)),
    findOne: jest.fn(() => mockQuery(mockDiscussion)),
  };
});
jest.mock('../models/DiscussionReply', () => {
  const { mockQuery } = require('./og.testKit');
  return { find: jest.fn(() => mockQuery(mockReplies)) };
});

const Discussion = require('../models/Discussion');
const DiscussionReply = require('../models/DiscussionReply');
const {
  SITE, openPages, jsonLd, canonical, metaDescription, forSnapshot,
} = require('./og.testKit');

const ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const HOSTILE = 'Corked? </script><script>alert(1)</script>';

function discussion(overrides = {}) {
  return {
    _id: ID,
    title: 'What to pour with roast lamb',
    slug: 'what-to-pour-with-roast-lamb',
    body: '<p>We are roasting a <strong>leg of lamb</strong> on Sunday.</p><p>Rioja or a northern Rhône?</p>',
    category: 'food-pairing',
    replyCount: 2,
    author: { username: 'lambfan', displayName: 'Lamb Fan' },
    wineDefinition: { _id: 'wine1', name: 'Reserva', producer: 'Example Bodega', slug: 'example-bodega-reserva' },
    createdAt: new Date('2026-02-01T09:00:00.000Z'),
    lastActivityAt: new Date('2026-02-03T18:45:00.000Z'),
    ...overrides,
  };
}

const REPLIES = [
  { body: '<p>Rioja Reserva, every time.</p>', author: { username: 'tempranillo' }, createdAt: new Date('2026-02-02T07:10:00.000Z') },
  { body: '<p>Try a <em>Cornas</em>.</p>', author: null, createdAt: null },
];

let pages;

beforeAll(async () => { pages = await openPages(require('./og')); });
afterAll(() => pages.close());

beforeEach(() => {
  mockDiscussions = [];
  mockDiscussion = null;
  mockReplies = [];
  Discussion.findOne.mockClear();
  DiscussionReply.find.mockClear();
});

describe('GET /api/og/community/discussions', () => {
  test('lists the discussions with category, reply count and a plain-text preview', async () => {
    mockDiscussions = [
      discussion(),
      discussion({ title: 'A single reply', slug: '', category: 'cellar-tips', replyCount: 1, body: `<p>${'Long text. '.repeat(20)}</p>` }),
      discussion({ title: 'An unknown category', slug: 'an-unknown-category', category: 'off-topic', replyCount: 0, body: '' }),
    ];
    const res = await pages.get('/community/discussions');

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('public, max-age=600');
    expect(canonical(res.html)).toBe(`${SITE}/community/discussions`);
    expect(forSnapshot(res.html)).toMatchSnapshot();
  });

  test('says so when there is no discussion', async () => {
    const res = await pages.get('/community/discussions');

    expect(res.status).toBe(200);
    expect(res.html).toContain('<p>No discussions yet — be the first to start one.</p>');
    expect(jsonLd(res.html).mainEntity.numberOfItems).toBe(0);
  });

  test('a title cannot end the JSON-LD block, and a body adds no markup to the list', async () => {
    mockDiscussions = [discussion({ title: HOSTILE, body: '<img src="x" onerror="alert(2)"><p>Smells of wet cardboard.</p>' })];
    const res = await pages.get('/community/discussions');

    expect(jsonLd(res.html).mainEntity.itemListElement[0].name).toBe(HOSTILE);
    expect(res.html).not.toContain('<script>alert(1)');
    expect(res.html).not.toContain('onerror');
    expect(res.html).toContain('<small>Smells of wet cardboard.</small>');
  });
});

describe('GET /api/og/community/discussions/:idOrSlug', () => {
  test('answers 404 for an unknown discussion, looked up by its lower-cased slug', async () => {
    const res = await pages.get('/community/discussions/No-Such-Thread');

    expect(res.status).toBe(404);
    expect(res.html).toBe('Not found');
    expect(Discussion.findOne).toHaveBeenCalledWith({ slug: 'no-such-thread' });
  });

  test('an id address moves permanently to the slug address', async () => {
    mockDiscussion = discussion();
    const res = await pages.get(`/community/discussions/${ID}`);

    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe(`${SITE}/community/discussions/what-to-pour-with-roast-lamb`);
    expect(Discussion.findOne).toHaveBeenCalledWith({ _id: ID });
    expect(DiscussionReply.find).not.toHaveBeenCalled();
  });

  test('a discussion without a slug is served at its id address', async () => {
    mockDiscussion = discussion({ slug: '' });
    const res = await pages.get(`/community/discussions/${ID}`);

    expect(res.status).toBe(200);
    expect(canonical(res.html)).toBe(`${SITE}/community/discussions/${ID}`);
  });

  test('renders the thread: the post, the wine it is about and the replies that are not deleted', async () => {
    mockDiscussion = discussion();
    mockReplies = REPLIES;
    const res = await pages.get('/community/discussions/what-to-pour-with-roast-lamb');

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=600');
    expect(DiscussionReply.find).toHaveBeenCalledWith({ discussion: ID, isDeleted: { $ne: true } });
    expect(canonical(res.html)).toBe(`${SITE}/community/discussions/what-to-pour-with-roast-lamb`);
    expect(metaDescription(res.html)).toBe('We are roasting a leg of lamb on Sunday.Rioja or a northern Rhône?');
    expect(forSnapshot(res.html)).toMatchSnapshot();
  });

  test('a thread with no author, body, dates, wine or replies falls back to Anonymous and its title', async () => {
    mockDiscussion = discussion({
      author: null, body: '', createdAt: null, lastActivityAt: null, wineDefinition: null, replyCount: 0,
    });
    const res = await pages.get('/community/discussions/what-to-pour-with-roast-lamb');
    const posting = jsonLd(res.html);

    expect(posting.author).toEqual({ '@type': 'Person', name: 'Anonymous' });
    expect(posting.comment).toBeUndefined();
    expect(posting.interactionStatistic.userInteractionCount).toBe(0);
    expect(metaDescription(res.html)).toBe('What to pour with roast lamb — Cellarion wine discussion');
    expect(res.html).toContain('<p>By Anonymous</p>');
    expect(res.html).not.toContain('article:published_time');
    expect(res.html).not.toContain('<p>About: ');
    expect(res.html).not.toContain('<section>');
  });

  test('a title cannot end the JSON-LD block, and the post and its replies lose scripts and handlers', async () => {
    mockDiscussion = discussion({
      title: HOSTILE,
      body: '<p onclick="steal()">Musty.</p><script>alert(2)</script>',
    });
    mockReplies = [{ body: '<img src="x" onerror="alert(3)"><p>Send it back.</p>', author: { username: 'somm' }, createdAt: null }];
    const res = await pages.get('/community/discussions/what-to-pour-with-roast-lamb');
    const posting = jsonLd(res.html);

    expect(posting.headline).toBe(HOSTILE);
    expect(posting.comment[0].text).toBe('Send it back.');
    expect(res.html).not.toContain('<script>alert(');
    expect(res.html).not.toContain('onclick');
    expect(res.html).not.toContain('onerror');
    expect(res.html).toContain('<h1>Corked? &lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt;</h1>');
  });
});
