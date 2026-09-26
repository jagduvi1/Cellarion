/**
 * routes/sitemap — a sitemap index plus paged parts (scaling audit
 * 2026-09-25). The single file it replaces listed at most 5,000 wines, so over
 * half of the public wine pages were never offered to search engines.
 *
 * Pinned here: the index lists one part per 40,000 (here: per 2) rows; every
 * wine the public page serves is listed, nothing it hides is; paging is by
 * _id; the taxonomy threshold; URL encoding + XML escaping; unknown parts are
 * a no-store 404; the cache, its size cap and single-flight builds.
 */
process.env.FRONTEND_URL = 'https://cellarion.test';

jest.mock('../models/BlogPost', () => ({ find: jest.fn() }));
jest.mock('../models/WineDefinition', () => ({ find: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../models/Country', () => ({ find: jest.fn() }));
jest.mock('../models/Region', () => ({ find: jest.fn() }));
jest.mock('../models/Grape', () => ({ find: jest.fn() }));
jest.mock('../models/Discussion', () => ({ find: jest.fn(), countDocuments: jest.fn() }));
jest.mock('./taxonomy', () => ({ countWinesBy: jest.fn() }));

const http = require('http');
const express = require('express');
const mongoose = require('mongoose');
const BlogPost = require('../models/BlogPost');
const WineDefinition = require('../models/WineDefinition');
const Country = require('../models/Country');
const Region = require('../models/Region');
const Grape = require('../models/Grape');
const Discussion = require('../models/Discussion');
const { countWinesBy } = require('./taxonomy');
const { createSitemapRouter } = require('./sitemap');

const SITE = 'https://cellarion.test';
const oid = (n) => new mongoose.Types.ObjectId(n.toString(16).padStart(24, '0'));

// A chainable query over `rows`, honouring sort({_id:1}) / skip / limit, and
// recording what it was asked.
function query(rows, calls) {
  const q = { filter: null, sort: null, skip: 0, limit: Infinity, select: null };
  calls.push(q);
  const chain = {
    sort(s) { q.sort = s; return chain; },
    skip(n) { q.skip = n; return chain; },
    limit(n) { q.limit = n; return chain; },
    select(s) { q.select = s; return chain; },
    lean() {
      let out = rows.slice();
      if (q.sort && q.sort._id === 1) out.sort((a, b) => String(a._id).localeCompare(String(b._id)));
      return Promise.resolve(out.slice(q.skip, q.skip + q.limit));
    },
  };
  return { q, chain };
}

let wines;
let discussions;
let calls;

function stub() {
  calls = { wines: [], discussions: [] };
  WineDefinition.countDocuments.mockImplementation(async () => wines.length);
  Discussion.countDocuments.mockImplementation(async () => discussions.length);
  WineDefinition.find.mockImplementation((filter) => { const { q, chain } = query(wines, calls.wines); q.filter = filter; return chain; });
  Discussion.find.mockImplementation((filter) => { const { q, chain } = query(discussions, calls.discussions); q.filter = filter; return chain; });
  BlogPost.find.mockImplementation(() => query([
    { slug: 'offline-mode', publishedAt: new Date('2026-09-25'), updatedAt: new Date('2026-09-25') },
  ], []).chain);
  Country.find.mockImplementation(() => query([{ _id: 'c1', slug: 'italy', updatedAt: new Date('2026-08-01') }, { _id: 'c2', slug: 'tiny', updatedAt: null }], []).chain);
  Region.find.mockImplementation(() => query([{ _id: 'r1', slug: 'piemonte', updatedAt: new Date('2026-08-02') }], []).chain);
  Grape.find.mockImplementation(() => query([{ _id: 'g1', slug: 'nebbiolo', updatedAt: null }], []).chain);
  countWinesBy.mockImplementation(async (field) => ({
    country: new Map([['c1', 50], ['c2', 1]]),
    region: new Map([['r1', 3]]),
    grapes: new Map([['g1', 2]]),
    type: new Map([['red', 40], ['rosé', 5], ['fortified', 0]]),
  }[field]));
}

let server;
let base;
let router;
async function mount(opts = {}) {
  if (server) await new Promise((r) => server.close(r));
  const app = express();
  router = createSitemapRouter({ urlsPerFile: 2, limiter: (req, res, next) => next(), ...opts });
  app.use('/sitemap.xml', router);
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
}
afterAll(async () => { if (server) await new Promise((r) => server.close(r)); });

const get = async (qs = '') => {
  const res = await fetch(`${base}/sitemap.xml${qs}`);
  return { status: res.status, type: res.headers.get('content-type'), cache: res.headers.get('cache-control'), body: await res.text() };
};
const locs = (xml) => [...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]);

beforeEach(async () => {
  jest.clearAllMocks();
  wines = [1, 2, 3, 4, 5].map((n) => ({ _id: oid(n), slug: n === 3 ? null : `wine-${n}`, updatedAt: new Date(`2026-09-0${n}`) }));
  discussions = [
    { _id: oid(101), slug: 'best-barolo', lastActivityAt: new Date('2026-09-10'), replyCount: 12 },
    { _id: oid(102), slug: 'cork & screw', lastActivityAt: null, replyCount: 0 },
  ];
  stub();
  await mount();
});

describe('the index', () => {
  test('lists the pages part and one part per file of wines and of threads', async () => {
    const r = await get();
    expect(r.status).toBe(200);
    expect(r.type).toMatch(/application\/xml/);
    expect(r.body).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>\n<sitemapindex xmlns="http:\/\/www.sitemaps.org\/schemas\/sitemap\/0.9">/);
    expect(locs(r.body)).toEqual([
      `${SITE}/sitemap.xml?part=pages`,
      `${SITE}/sitemap.xml?part=wines-1`,
      `${SITE}/sitemap.xml?part=wines-2`,
      `${SITE}/sitemap.xml?part=wines-3`,
      `${SITE}/sitemap.xml?part=discussions-1`,
    ]);
  });

  test('counts only what the public pages serve', async () => {
    await get();
    expect(WineDefinition.countDocuments).toHaveBeenCalledWith({ nonWine: { $ne: true }, pendingIdentity: { $ne: true } });
    expect(Discussion.countDocuments).toHaveBeenCalledWith({ isLocked: { $ne: true } });
  });

  test('an empty registry still has a valid index with the pages part', async () => {
    wines = [];
    discussions = [];
    expect(locs((await get()).body)).toEqual([`${SITE}/sitemap.xml?part=pages`]);
  });
});

describe('wine parts', () => {
  test('page by page in _id order, slug URLs with the id as fallback, all of them', async () => {
    const all = [];
    for (let p = 1; p <= 3; p++) {
      const r = await get(`?part=wines-${p}`);
      expect(r.status).toBe(200);
      expect(r.body).toMatch(/<urlset xmlns="http:\/\/www.sitemaps.org\/schemas\/sitemap\/0.9">/);
      all.push(...locs(r.body));
    }
    expect(all).toEqual([
      `${SITE}/wines/wine-1`,
      `${SITE}/wines/wine-2`,
      `${SITE}/wines/${oid(3)}`,
      `${SITE}/wines/wine-4`,
      `${SITE}/wines/wine-5`,
    ]);
    const q = calls.wines[1];
    expect(q).toMatchObject({ sort: { _id: 1 }, skip: 2, limit: 2, filter: { nonWine: { $ne: true }, pendingIdentity: { $ne: true } } });
  });

  test('the lastmod is the wine\'s last update', async () => {
    const r = await get('?part=wines-1');
    expect(r.body).toContain(`<loc>${SITE}/wines/wine-1</loc>\n    <lastmod>2026-09-01</lastmod>`);
  });

  test('no cap: every wine is listed (the old single file stopped at 5,000)', async () => {
    wines = Array.from({ length: 12000 }, (_, i) => ({ _id: oid(i + 1), slug: `w-${i}`, updatedAt: new Date('2026-09-01') }));
    await mount({ urlsPerFile: 40000 });
    expect(locs((await get()).body)).toContain(`${SITE}/sitemap.xml?part=wines-1`);
    expect(locs((await get('?part=wines-1')).body)).toHaveLength(12000);
  });

  test('a page past the last one is a no-store 404', async () => {
    const r = await get('?part=wines-4');
    expect(r.status).toBe(404);
    expect(r.cache).toBe('no-store');
  });
});

describe('the pages part', () => {
  test('site pages, published posts, taxonomy pages that have enough wines, and the type pages', async () => {
    const r = await get('?part=pages');
    const list = locs(r.body);
    expect(list).toEqual(expect.arrayContaining([
      `${SITE}/`,
      `${SITE}/blog`,
      `${SITE}/community/discussions`,
      `${SITE}/blog/offline-mode`,
      `${SITE}/countries/italy`,
      `${SITE}/regions/piemonte`,
      `${SITE}/wines/type/red`,
      `${SITE}/wines/type/ros%C3%A9`, // percent-encoded, as the protocol requires
    ]));
    expect(list).not.toContain(`${SITE}/countries/tiny`); // 1 wine < 3
    expect(list).not.toContain(`${SITE}/grapes/nebbiolo`); // 2 wines < 3
    expect(list.some((l) => l.includes('fortified'))).toBe(false);
    expect(list.some((l) => l.includes('/wines/wine-'))).toBe(false); // wines have their own parts
    expect(BlogPost.find).toHaveBeenCalledWith({ status: 'published' });
  });
});

describe('discussion parts', () => {
  test('open threads, XML-escaped, busy ones ranked higher', async () => {
    const r = await get('?part=discussions-1');
    expect(r.status).toBe(200);
    expect(r.body).toContain(`<loc>${SITE}/community/discussions/best-barolo</loc>\n    <lastmod>2026-09-10</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>0.6</priority>`);
    // A space is percent-encoded, an ampersand entity-escaped.
    expect(r.body).toContain(`<loc>${SITE}/community/discussions/cork%20&amp;%20screw</loc>`);
    expect(r.body).toContain('<priority>0.4</priority>');
    expect(calls.discussions[0].filter).toEqual({ isLocked: { $ne: true } });
  });
});

describe('requests that name no part', () => {
  test.each(['foo', 'wines-0', 'wines-abc', 'wines-1x', '../etc/passwd', 'discussions-', 'pages-1'])('?part=%s is a no-store 404', async (p) => {
    const r = await get(`?part=${encodeURIComponent(p)}`);
    expect(r.status).toBe(404);
    expect(r.cache).toBe('no-store');
  });

  test('a repeated part parameter is a 404, not a crash', async () => {
    expect((await get('?part=pages&part=wines-1')).status).toBe(404);
  });
});

describe('caching', () => {
  test('a part is built once an hour; others are separate', async () => {
    const first = await get('?part=wines-1');
    expect(first.cache).toBe('public, max-age=3600');
    const again = await get('?part=wines-1');
    expect(again.body).toBe(first.body);
    expect(WineDefinition.find).toHaveBeenCalledTimes(1);
    await get('?part=wines-2');
    expect(WineDefinition.find).toHaveBeenCalledTimes(2);
  });

  test('an expired part is rebuilt', async () => {
    await mount({ cacheTtlMs: 0 });
    await get('?part=wines-1');
    await new Promise((r) => setTimeout(r, 5));
    await get('?part=wines-1');
    expect(WineDefinition.find).toHaveBeenCalledTimes(2);
  });

  test('the total size is capped: the oldest part is dropped first', async () => {
    const one = (await get('?part=wines-1')).body.length;
    await mount({ cacheMaxChars: one * 1.5 }); // room for one part only
    await get('?part=wines-1');
    await get('?part=wines-2');   // evicts wines-1
    await get('?part=wines-2');   // cached
    await get('?part=wines-1');   // rebuilt
    expect(WineDefinition.find).toHaveBeenCalledTimes(1 + 3);
  });

  test('concurrent requests for a part share one build', async () => {
    let release;
    WineDefinition.find.mockImplementationOnce(() => ({
      sort() { return this; }, skip() { return this; }, limit() { return this; }, select() { return this; },
      lean: () => new Promise((r) => { release = () => r(wines.slice(0, 2)); }),
    }));
    const a = get('?part=wines-1');
    const b = get('?part=wines-1');
    await new Promise((r) => setTimeout(r, 50));
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.body).toBe(rb.body);
    expect(WineDefinition.find).toHaveBeenCalledTimes(1);
  });

  test('a failed build is a no-store 500 and is not cached', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    WineDefinition.countDocuments.mockRejectedValueOnce(new Error('db down'));
    const r = await get();
    expect(r.status).toBe(500);
    expect(r.cache).toBe('no-store');
    expect((await get()).status).toBe(200);
    error.mockRestore();
  });
});
