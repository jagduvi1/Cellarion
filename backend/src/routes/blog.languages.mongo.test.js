/**
 * Blog posts in more than one language, on the real routes against a REAL
 * MongoDB (services/blogLanguage.js has the rule).
 *
 * WHY THIS TEST EXISTS:
 * The blog lists the originals, the same for every reader, whatever language
 * they ask for: a translation is never listed (so it is never a "new post" in
 * the app) and is reached from its original's page. A post page names every
 * version of it (the language line and hreflang), and the crawler page shows
 * and links the same. The admin can only make a translation that points at
 * an original in another language, one per language. A stored post with no
 * `language` or `translationOf` is an English original. These are query
 * shapes (a missing field matched as null, a partial unique index) that
 * mocked models cannot check, which is why it runs on MongoDB.
 *
 * Needs CONTRACT_MONGO_URI (CI provides one); it uses its own database,
 * `cellarion_contract_blog`, dropped before and after. Skipped without it.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'blog-languages-'.repeat(4);
process.env.MEILI_MASTER_KEY = process.env.MEILI_MASTER_KEY || 'blog-meili-key-0123456789abcdef';
process.env.MEILI_URL = 'http://127.0.0.1:1';
process.env.FRONTEND_URL = 'https://cellarion.app';

// The Meilisearch client is ESM-only (Jest cannot load it); nothing here searches.
jest.mock('meilisearch', () => ({
  Meilisearch: class {
    index() { return {}; }
    health() { return Promise.reject(new Error('no search in this test')); }
  },
}));

const mockAdminId = '64b000000000000000000001';
jest.mock('../middleware/auth', () => ({
  ...jest.requireActual('../middleware/auth'),
  requireAuth: (req, res, next) => { req.user = { id: mockAdminId }; next(); },
  requireRole: () => (req, res, next) => next(),
}));
jest.mock('../services/audit', () => ({ ...jest.requireActual('../services/audit'), logAudit: jest.fn() }));
jest.mock('../services/indexNow', () => ({ submitUrls: jest.fn() }));

const http = require('http');
const express = require('express');
const mongoose = require('mongoose');

const BASE_URI = process.env.CONTRACT_MONGO_URI;
const URI = BASE_URI ? (() => { const u = new URL(BASE_URI); u.pathname = '/cellarion_contract_blog'; return u.toString(); })() : null;
const describeWithMongo = URI ? describe : describe.skip;
if (!URI) console.warn('routes/blog.languages.mongo.test.js skipped: set CONTRACT_MONGO_URI to run it');

describeWithMongo('blog posts in more than one language (real MongoDB)', () => {
  let server; let base; let BlogPost; let ids;

  const day = (n) => new Date(Date.UTC(2026, 10, n));
  const get = async (path) => {
    const res = await fetch(`${base}${path}`);
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* a crawler page is HTML */ }
    return { status: res.status, body, text };
  };
  const send = async (method, path, payload) => {
    const res = await fetch(`${base}${path}`, {
      method, headers: { 'Content-Type': 'application/json' }, body: payload ? JSON.stringify(payload) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  const slugs = (body) => body.posts.map((p) => p.slug);

  beforeAll(async () => {
    expect(new URL(URI).pathname).toBe('/cellarion_contract_blog');
    await mongoose.connect(URI);
    await mongoose.connection.dropDatabase();
    BlogPost = require('../models/BlogPost');
    await BlogPost.syncIndexes();

    const author = new mongoose.Types.ObjectId(mockAdminId);
    const base0 = { author, content: '<p>Body</p>', status: 'published' };
    // A post written before the language field existed: stored with no `language`.
    const legacy = await BlogPost.collection.insertOne({
      ...base0, title: 'Drink windows explained', slug: 'drink-windows', tags: ['aging', 'guide'],
      publishedAt: day(1), excerpt: '', coverImage: '', metaTitle: '', metaDescription: '',
      createdAt: day(1), updatedAt: day(1),
    });
    const storage = await BlogPost.create({ ...base0, title: 'Storing wine', slug: 'storing-wine', tags: ['storage'], publishedAt: day(2) });
    const svDrink = await BlogPost.create({
      ...base0, title: 'Drickfönster förklarade', slug: 'drickfonster', tags: ['lagring'], publishedAt: day(3),
      language: 'sv', translationOf: legacy.insertedId,
    });
    const frOnly = await BlogPost.create({ ...base0, title: 'Alternative à Oeni', slug: 'alternative-a-oeni', tags: ['oeni'], publishedAt: day(4), language: 'fr' });
    const draft = await BlogPost.create({ ...base0, title: 'Unfinished', slug: 'unfinished', status: 'draft' });
    ids = { drink: legacy.insertedId, storage: storage._id, svDrink: svDrink._id, frOnly: frOnly._id, draft: draft._id };

    const app = express();
    app.use(express.json());
    app.use('/api/blog', require('./blog'));
    app.use('/api/og', require('./og'));
    await new Promise((resolve) => { server = http.createServer(app).listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  });

  describe('what the blog lists', () => {
    test('the originals, newest first, the same whatever language the reader asks for', async () => {
      for (const qs of ['', '?lang=sv', '?lang=fr', '?lang[$gt]=']) {
        const { status, body } = await get(`/api/blog${qs}`);
        expect(status).toBe(200);
        expect(slugs(body)).toEqual(['alternative-a-oeni', 'storing-wine', 'drink-windows']);
        expect(body.total).toBe(3);
      }
    });

    test('a translation is never listed, so it is never a new post in the app', async () => {
      const { body } = await get('/api/blog?limit=50');
      expect(slugs(body)).not.toContain('drickfonster');
      expect(body.posts.every((p) => p.translationOf === null)).toBe(true);
    });

    test('search and tag filters list originals only', async () => {
      expect(slugs((await get('/api/blog?q=drick')).body)).toEqual([]);
      expect(slugs((await get('/api/blog?q=drink')).body)).toEqual(['drink-windows']);
      expect(slugs((await get('/api/blog?tag=lagring')).body)).toEqual([]);
      expect(slugs((await get('/api/blog?tag=aging')).body)).toEqual(['drink-windows']);
    });

    test('the tag list holds the tags of the originals', async () => {
      expect((await get('/api/blog/tags')).body.tags.sort()).toEqual(['aging', 'guide', 'oeni', 'storage']);
    });
  });

  describe('a post and its other languages', () => {
    test('a translation opens by its own address, and a post names every published version of it, the original first', async () => {
      const expected = [
        { language: 'en', slug: 'drink-windows', original: true },
        { language: 'sv', slug: 'drickfonster', original: false },
      ];
      const sv = await get('/api/blog/drickfonster');
      expect(sv.status).toBe(200);
      expect(sv.body.post.language).toBe('sv');
      expect(sv.body.alternates).toEqual(expected);
      expect((await get('/api/blog/drink-windows')).body.alternates).toEqual(expected);
    });

    test('a post in one language names none', async () => {
      const { body } = await get('/api/blog/storing-wine');
      expect(body.post.language).toBe('en');
      expect(body.alternates).toEqual([]);
    });

    test('the crawler page is in the post\'s language and links its versions, x-default on the English one', async () => {
      const { status, text } = await get('/api/og/blog/drickfonster');
      expect(status).toBe(200);
      expect(text).toContain('<html lang="sv">');
      expect(text).toContain('<link rel="alternate" hreflang="en" href="https://cellarion.app/blog/drink-windows" />');
      expect(text).toContain('<link rel="alternate" hreflang="sv" href="https://cellarion.app/blog/drickfonster" />');
      expect(text).toContain('<link rel="alternate" hreflang="x-default" href="https://cellarion.app/blog/drink-windows" />');
    });

    test('the crawler page shows the same language line as the app: a translation links its original, an original its translations', async () => {
      const sv = (await get('/api/og/blog/drickfonster')).text;
      expect(sv).toContain('<p>Translated from English with AI. <a href="https://cellarion.app/blog/drink-windows" hreflang="en">Read the original</a></p>');
      const en = (await get('/api/og/blog/drink-windows')).text;
      expect(en).toContain('<p>Also in: <a href="https://cellarion.app/blog/drickfonster" hreflang="sv" lang="sv">Svenska</a></p>');
    });

    test('the crawler page of a post in one language has no alternates and no language line', async () => {
      const { text } = await get('/api/og/blog/storing-wine');
      expect(text).toContain('<html lang="en">');
      expect(text).not.toContain('hreflang=');
      expect(text).not.toContain('Also in');
    });

    test('the crawler index lists the originals, like the app', async () => {
      const { text } = await get('/api/og/blog');
      expect(text).toContain('href="https://cellarion.app/blog/drink-windows"><strong>');
      expect(text).toContain('href="https://cellarion.app/blog/alternative-a-oeni"><strong>');
      expect(text).not.toContain('/blog/drickfonster');
    });
  });

  describe('the admin makes translations', () => {
    const post = (extra) => ({ title: 'Une traduction', content: '<p>Texte</p>', ...extra });

    test('a translation points at an original in another language; its slug folds the accents', async () => {
      const { status, body } = await send('POST', '/api/blog/admin/posts', post({
        title: 'Fenêtres de dégustation expliquées', language: 'fr', translationOf: String(ids.drink),
      }));
      expect(status).toBe(201);
      expect(body.post.language).toBe('fr');
      expect(body.post.translationOf).toBe(String(ids.drink));
      expect(body.post.slug).toBe('fenetres-de-degustation-expliquees');
    });

    test('refusals, each with its reason', async () => {
      const cases = [
        [post({ language: 'french' }), 400, 'blog_language_invalid'],
        [post({ language: 'fr', translationOf: 'not-an-id' }), 400, 'blog_translation_of_invalid'],
        [post({ language: 'fr', translationOf: String(new mongoose.Types.ObjectId()) }), 400, 'blog_translation_of_invalid'],
        [post({ language: 'en', translationOf: String(ids.drink) }), 400, 'blog_translation_same_language'],
        [post({ language: 'de', translationOf: String(ids.svDrink) }), 400, 'blog_translation_of_translation'],
        [post({ language: 'sv', translationOf: String(ids.drink) }), 409, 'blog_translation_exists'],
      ];
      for (const [payload, status, code] of cases) {
        const res = await send('POST', '/api/blog/admin/posts', payload);
        expect([res.status, res.body.code]).toEqual([status, code]);
      }
    });

    test('an original with translations cannot become one, nor take a translation\'s language', async () => {
      let res = await send('PUT', `/api/blog/admin/posts/${ids.drink}`, { translationOf: String(ids.storage), language: 'de' });
      expect([res.status, res.body.code]).toEqual([400, 'blog_original_has_translations']);
      res = await send('PUT', `/api/blog/admin/posts/${ids.drink}`, { language: 'sv' });
      expect([res.status, res.body.code]).toEqual([409, 'blog_language_taken_by_translation']);
    });

    test('an edit that does not touch the language fields keeps them', async () => {
      const res = await send('PUT', `/api/blog/admin/posts/${ids.svDrink}`, { title: 'Drickfönster, förklarade' });
      expect(res.status).toBe(200);
      expect(res.body.post.language).toBe('sv');
      expect(res.body.post.translationOf).toBe(String(ids.drink));
    });

    test('the editor gets the original a translation points at, with its title', async () => {
      const { body } = await get(`/api/blog/admin/posts/${ids.svDrink}`);
      expect(body.post.translationOf).toMatchObject({ _id: String(ids.drink), title: 'Drink windows explained' });
    });

    test('the "Translation of" list holds originals only, drafts included', async () => {
      const { body } = await get('/api/blog/admin/originals');
      const listed = body.posts.map((p) => p.slug);
      expect(listed).toEqual(expect.arrayContaining(['drink-windows', 'storing-wine', 'alternative-a-oeni', 'unfinished']));
      expect(listed).not.toContain('drickfonster');
      expect(body.posts.find((p) => p.slug === 'drink-windows').language).toBe('en');
    });

    test('the database itself refuses a second translation in one language', async () => {
      await expect(BlogPost.create({
        title: 'Dubblett', slug: 'dubblett', content: '<p>x</p>', author: new mongoose.Types.ObjectId(mockAdminId),
        language: 'sv', translationOf: ids.drink,
      })).rejects.toMatchObject({ code: 11000 });
    });

    test('deleting an original leaves its translations as posts of their own', async () => {
      const res = await send('DELETE', `/api/blog/admin/posts/${ids.drink}`);
      expect(res.status).toBe(200);
      const sv = await BlogPost.findById(ids.svDrink).lean();
      expect(sv.translationOf).toBeNull();
      // Now an original of its own, it is listed.
      expect(slugs((await get('/api/blog')).body)).toContain('drickfonster');
    });
  });
});
