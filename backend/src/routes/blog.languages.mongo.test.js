/**
 * Blog posts in more than one language, on the real routes against a REAL
 * MongoDB (services/blogLanguage.js has the rule).
 *
 * WHY THIS TEST EXISTS:
 * From each family (an original and its translations) a reader sees the
 * version in their language, else the English one, else nothing: an English
 * reader never meets a Swedish post, a Swedish reader gets the Swedish version
 * in place of the English one, never both. A post without a `language` is
 * English. The list carries `translationOf`, which is what keeps a
 * translation out of the app's "new post" badge. A post page names its other
 * versions (hreflang) and the crawler page links them. The admin can only
 * make a translation that points at an original in another language, one per
 * language. These are query shapes ($nin over families, a missing field read
 * as English) that mocked models cannot check, which is why it runs on
 * MongoDB.
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

  describe('which posts a reader sees', () => {
    test('an English reader (and a reader who names no language) sees English posts only, a post without a language among them', async () => {
      for (const qs of ['', '?lang=en', '?lang=xx-1', '?lang[$gt]=']) {
        const { status, body } = await get(`/api/blog${qs}`);
        expect(status).toBe(200);
        expect(slugs(body)).toEqual(['storing-wine', 'drink-windows']);
        expect(body.total).toBe(2);
      }
    });

    test('a Swedish reader gets the Swedish version in place of the English one, never both, and no French post', async () => {
      for (const qs of ['?lang=sv', '?lang=sv-SE', '?lang=SV']) {
        const { body } = await get(`/api/blog${qs}`);
        expect(slugs(body)).toEqual(['drickfonster', 'storing-wine']);
        expect(body.total).toBe(2);
      }
    });

    test('a French reader gets the French original and English for the rest', async () => {
      const { body } = await get('/api/blog?lang=fr');
      expect(slugs(body)).toEqual(['alternative-a-oeni', 'storing-wine', 'drink-windows']);
    });

    test('the list says which post is a translation: what keeps it out of the "new post" badge', async () => {
      const { body } = await get('/api/blog?lang=sv');
      const sv = body.posts.find((p) => p.slug === 'drickfonster');
      expect(sv.language).toBe('sv');
      expect(sv.translationOf).toBe(String(ids.drink));
      expect(body.posts.find((p) => p.slug === 'storing-wine').translationOf).toBeNull();
    });

    test('search and tag filters keep the language rule', async () => {
      expect(slugs((await get('/api/blog?lang=sv&q=drick')).body)).toEqual(['drickfonster']);
      expect(slugs((await get('/api/blog?q=drick')).body)).toEqual([]);
      expect(slugs((await get('/api/blog?tag=aging')).body)).toEqual(['drink-windows']);
      expect(slugs((await get('/api/blog?lang=sv&tag=aging')).body)).toEqual([]);
    });

    test('the tag list holds the tags of the posts the reader sees', async () => {
      expect((await get('/api/blog/tags')).body.tags.sort()).toEqual(['aging', 'guide', 'storage']);
      expect((await get('/api/blog/tags?lang=sv')).body.tags.sort()).toEqual(['lagring', 'storage']);
    });
  });

  describe('a post and its other languages', () => {
    test('a post names every published version of it, the original first', async () => {
      const expected = [{ language: 'en', slug: 'drink-windows' }, { language: 'sv', slug: 'drickfonster' }];
      expect((await get('/api/blog/drickfonster')).body.alternates).toEqual(expected);
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

    test('the crawler page of a post in one language has no alternates', async () => {
      const { text } = await get('/api/og/blog/storing-wine');
      expect(text).toContain('<html lang="en">');
      expect(text).not.toContain('hreflang=');
    });

    test('the crawler index lists every language, marking the links that lead to another one', async () => {
      const { text } = await get('/api/og/blog');
      expect(text).toContain('href="https://cellarion.app/blog/drickfonster" hreflang="sv"');
      expect(text).toContain('href="https://cellarion.app/blog/alternative-a-oeni" hreflang="fr"');
      expect(text).toContain('href="https://cellarion.app/blog/drink-windows"><strong>');
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
      expect(slugs((await get('/api/blog?lang=sv')).body)).toContain('drickfonster');
    });
  });
});
