/**
 * GET /api/admin/wine-requests and GET /:id/photos on a REAL MongoDB.
 *
 * WHY THIS TEST EXISTS:
 * A request may carry two inline photos of up to 500,000 characters each,
 * and a self-hosted install contributing its wines sends one with every
 * wine. The admin queue lists fifty requests a page, so the list carries a
 * flag for an inline photo instead of the photo, worked out in the database
 * (an aggregation over a missing, null, link or data: field), and the photos
 * of the request an admin opens are read on their own. A link is short and
 * stays in the list as it was. Only a real database shows that the
 * projection tells a missing field, a null, a link and an inline photo apart.
 *
 * Needs CONTRACT_MONGO_URI (CI provides one); it uses its own database,
 * `cellarion_contract_requestphotos`, dropped before and after. Skipped without it.
 */
process.env.JWT_SECRET = 'test-secret';

// The Meilisearch client is ESM-only (Jest cannot load it); nothing here searches.
jest.mock('../../services/search', () => ({ indexWine: jest.fn() }));
jest.mock('../../services/indexNow', () => ({ submitUrls: jest.fn() }));

const mongoose = require('mongoose');
const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const WineRequest = require('../../models/WineRequest');
const router = require('./wineRequests');

const BASE_URI = process.env.CONTRACT_MONGO_URI;
const URI = BASE_URI ? (() => { const u = new URL(BASE_URI); u.pathname = '/cellarion_contract_requestphotos'; return u.toString(); })() : null;
const describeWithMongo = URI ? describe : describe.skip;
if (!URI) console.warn('routes/admin/wineRequests.photos.mongo.test.js skipped: set CONTRACT_MONGO_URI to run it');

const USER = new mongoose.Types.ObjectId();
const INLINE = `data:image/webp;base64,${'A'.repeat(4000)}`;
const BACK = `data:image/webp;base64,${'B'.repeat(2000)}`;
const LINK = 'https://cdn.example.org/label.webp';

describeWithMongo('admin wine requests and their photos (real MongoDB)', () => {
  let server; let baseUrl;
  const admin = jwt.sign({ id: String(new mongoose.Types.ObjectId()), roles: ['user', 'admin'] }, 'test-secret');
  const member = jwt.sign({ id: String(USER), roles: ['user'] }, 'test-secret');
  const get = (path, token = admin) => fetch(`${baseUrl}${path}`, { headers: { Authorization: `Bearer ${token}` } });

  beforeAll(async () => {
    await mongoose.connect(URI);
    if (!mongoose.connection.db.databaseName.startsWith('cellarion_contract')) throw new Error('refusing to use a database not named cellarion_contract*');
    await mongoose.connection.db.dropDatabase();
    const app = express();
    app.use(express.json());
    app.use('/api/admin/wine-requests', router);
    await new Promise((resolve) => { server = http.createServer(app).listen(0, resolve); });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  }, 60000);

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await mongoose.connection.db.dropDatabase();
    await mongoose.disconnect();
  }, 60000);

  test('the list flags inline photos instead of carrying them; links stay; the opened request reads its photos', async () => {
    const base = { requestType: 'new_wine', user: USER, status: 'pending', producer: 'Domaine Example' };
    const contributed = await WineRequest.create({ ...base, wineName: 'Inline both', image: INLINE, backImage: BACK, via: 'bridge' });
    const linked = await WineRequest.create({ ...base, wineName: 'Linked', image: LINK, sourceUrl: 'https://shop.example/a' });
    const nulled = await WineRequest.create({ ...base, wineName: 'Null image', image: null, sourceUrl: 'https://shop.example/b' });
    const missing = await WineRequest.create({ ...base, wineName: 'No image field', sourceUrl: 'https://shop.example/c' });
    await WineRequest.collection.updateOne({ _id: missing._id }, { $unset: { image: '', backImage: '' } });

    const res = await get('/api/admin/wine-requests?status=pending');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(4);
    const byName = new Map(body.requests.map((r) => [r.wineName, r]));
    expect(byName.get('Inline both')).toMatchObject({ image: null, backImage: null, hasInlineImage: true, hasInlineBackImage: true, via: 'bridge' });
    expect(byName.get('Linked')).toMatchObject({ image: LINK, backImage: null, hasInlineImage: false, hasInlineBackImage: false });
    expect(byName.get('Null image')).toMatchObject({ image: null, hasInlineImage: false });
    expect(byName.get('No image field')).toMatchObject({ image: null, backImage: null, hasInlineImage: false, hasInlineBackImage: false });
    // The whole page is small: no inline photo travelled.
    expect(JSON.stringify(body)).not.toContain('AAAA');

    const photos = await get(`/api/admin/wine-requests/${contributed._id}/photos`);
    expect(photos.status).toBe(200);
    expect(await photos.json()).toEqual({ image: INLINE, backImage: BACK });
    expect(await (await get(`/api/admin/wine-requests/${linked._id}/photos`)).json()).toEqual({ image: LINK, backImage: null });
    expect(await (await get(`/api/admin/wine-requests/${nulled._id}/photos`)).json()).toEqual({ image: null, backImage: null });
  });

  test('photos: admins only; a bad id is a 400 and an unknown one a 404', async () => {
    const r = await WineRequest.create({ requestType: 'new_wine', user: USER, status: 'pending', wineName: 'X', producer: 'Y', image: INLINE });
    expect((await get(`/api/admin/wine-requests/${r._id}/photos`, member)).status).toBe(403);
    expect((await get('/api/admin/wine-requests/nope/photos')).status).toBe(400);
    expect((await get(`/api/admin/wine-requests/${new mongoose.Types.ObjectId()}/photos`)).status).toBe(404);
  });
});
