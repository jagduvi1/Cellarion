const { MeiliSearch } = require('meilisearch');
const WineDefinition = require('../models/WineDefinition');
const Bottle = require('../models/Bottle');
const { WINE_POPULATE, CONSUMED_STATUSES } = require('../config/constants');

const INDEX_NAME = 'wines';
const BOTTLES_INDEX_NAME = 'bottles';

let client = null;
let index = null;
let bottlesIndex = null;
let isAvailable = false;

async function initialize() {
  const url = process.env.MEILI_URL || 'http://localhost:7700';
  const apiKey = process.env.MEILI_MASTER_KEY || '';

  try {
    client = new MeiliSearch({ host: url, apiKey });
    await client.health();

    index = client.index(INDEX_NAME);

    // Configure index settings
    await index.updateSettings({
      searchableAttributes: [
        'name',
        'producer',
        'appellation',
        'regionName',
        'grapeNames',
        'countryName'
      ],
      filterableAttributes: ['countryId', 'regionId', 'type', 'grapeIds'],
      sortableAttributes: ['name', 'producer', 'type', 'createdAt'],
      separatorTokens: ['.'],
      pagination: { maxTotalHits: 5000 }
    });

    // ── Bottles index ──
    bottlesIndex = client.index(BOTTLES_INDEX_NAME);

    await bottlesIndex.updateSettings({
      searchableAttributes: [
        'wineName',
        'producer',
        'appellation',
        'countryName',
        'regionName',
        'grapeNames',
        'type',
        'notes',
        'location',
        'vintage'
      ],
      filterableAttributes: [
        'cellarId',
        'status',
        'type',
        'countryId',
        'countryName',
        'regionId',
        'regionName',
        'grapeIds',
        'vintage',
        'rating'
      ],
      sortableAttributes: ['wineName', 'vintage', 'price', 'rating', 'createdAt'],
      separatorTokens: ['.'],
      pagination: { maxTotalHits: 10000 }
    });

    isAvailable = true;
    console.log(`Meilisearch connected: ${url}`);

    await fullSync();
    await fullSyncBottles();
  } catch (err) {
    isAvailable = false;
    console.warn(`Meilisearch unavailable (${url}): ${err.message}. Falling back to MongoDB search.`);
  }
}

function buildDocument(wine) {
  return {
    id: wine._id.toString(),
    name: wine.name,
    producer: wine.producer,
    appellation: wine.appellation || '',
    type: wine.type || '',
    countryId: wine.country?._id?.toString() || wine.country?.toString() || '',
    countryName: wine.country?.name || '',
    regionId: wine.region?._id?.toString() || wine.region?.toString() || '',
    regionName: wine.region?.name || '',
    grapeIds: (wine.grapes || []).map(g => (g._id || g).toString()),
    grapeNames: (wine.grapes || []).filter(g => g.name).map(g => g.name).join(', '),
    image: wine.image || '',
    createdAt: wine.createdAt ? Math.floor(new Date(wine.createdAt).getTime() / 1000) : 0
  };
}

async function fullSync() {
  if (!isAvailable) return;

  try {
    const wines = await WineDefinition.find()
      .populate('country', 'name')
      .populate('region', 'name')
      .populate('grapes', 'name')
      .lean();

    const documents = wines.map(buildDocument);

    if (documents.length > 0) {
      await index.addDocuments(documents, { primaryKey: 'id' });
    }

    console.log(`Meilisearch: synced ${documents.length} wines`);
  } catch (err) {
    console.error(`Meilisearch full sync failed: ${err.message}`);
  }
}

async function indexWine(wineId) {
  if (!isAvailable) return;

  try {
    const wine = await WineDefinition.findById(wineId)
      .populate('country', 'name')
      .populate('region', 'name')
      .populate('grapes', 'name')
      .lean();

    if (!wine) return;

    await index.addDocuments([buildDocument(wine)], { primaryKey: 'id' });
  } catch (err) {
    console.error(`Meilisearch index wine ${wineId} failed: ${err.message}`);
  }
}

async function removeWine(wineId) {
  if (!isAvailable) return;

  try {
    await index.deleteDocument(wineId.toString());
  } catch (err) {
    console.error(`Meilisearch remove wine ${wineId} failed: ${err.message}`);
  }
}

async function search(query, { countryId, regionId, type, grapeIds, limit = 50, offset = 0, sort } = {}) {
  if (!isAvailable) {
    throw new Error('Meilisearch is not available');
  }

  // Build filter array using Meilisearch array syntax (each element is ANDed).
  // Validate IDs as hex ObjectIds and type against an allowlist to prevent injection.
  const isObjectId = (v) => /^[a-f0-9]{24}$/i.test(String(v));
  const VALID_TYPES = ['red', 'white', 'rosé', 'sparkling', 'dessert', 'fortified'];
  const filters = [];
  if (countryId && isObjectId(countryId)) filters.push(`countryId = "${countryId}"`);
  if (regionId && isObjectId(regionId)) filters.push(`regionId = "${regionId}"`);
  if (type && VALID_TYPES.includes(String(type).toLowerCase())) filters.push(`type = "${type}"`);
  if (grapeIds && grapeIds.length > 0) {
    for (const id of grapeIds) {
      if (isObjectId(id)) filters.push(`grapeIds = "${id}"`);
    }
  }

  // Build sort array
  const meiliSort = [];
  if (sort && typeof sort === 'string' && sort !== 'relevance') {
    const desc = sort.startsWith('-');
    const field = desc ? sort.slice(1) : sort;
    if (['name', 'producer', 'type', 'createdAt'].includes(field)) {
      meiliSort.push(`${field}:${desc ? 'desc' : 'asc'}`);
    }
  }

  const result = await index.search(query, {
    filter: filters.length > 0 ? filters : undefined,
    sort: meiliSort.length > 0 ? meiliSort : undefined,
    limit,
    offset
  });

  return {
    ids: result.hits.map(hit => hit.id),
    estimatedTotalHits: result.estimatedTotalHits || 0
  };
}

// ── Bottle index helpers ─────────────────────────────────────────────────────

function buildBottleDocument(bottle) {
  const wd = bottle.wineDefinition || {};
  return {
    id: bottle._id.toString(),
    cellarId: (bottle.cellar?._id || bottle.cellar || '').toString(),
    status: bottle.status || 'active',
    wineDefinitionId: (wd._id || '').toString(),
    wineName: wd.name || '',
    producer: wd.producer || '',
    appellation: wd.appellation || '',
    type: wd.type || '',
    countryId: (wd.country?._id || wd.country || '').toString(),
    countryName: wd.country?.name || '',
    regionId: (wd.region?._id || wd.region || '').toString(),
    regionName: wd.region?.name || '',
    grapeIds: (wd.grapes || []).map(g => (g._id || g).toString()),
    grapeNames: (wd.grapes || []).filter(g => g.name).map(g => g.name).join(', '),
    vintage: bottle.vintage || '',
    price: bottle.price || 0,
    rating: bottle.rating || 0,
    ratingScale: bottle.ratingScale || '',
    notes: bottle.notes || '',
    location: bottle.location || '',
    createdAt: bottle.createdAt ? Math.floor(new Date(bottle.createdAt).getTime() / 1000) : 0
  };
}

async function fullSyncBottles() {
  if (!isAvailable) return;

  try {
    const bottles = await Bottle.find({ status: { $nin: CONSUMED_STATUSES } })
      .populate(WINE_POPULATE)
      .lean();

    const documents = bottles.map(buildBottleDocument);

    if (documents.length > 0) {
      await bottlesIndex.addDocuments(documents, { primaryKey: 'id' });
    }

    console.log(`Meilisearch: synced ${documents.length} bottles`);
  } catch (err) {
    console.error(`Meilisearch bottle full sync failed: ${err.message}`);
  }
}

async function indexBottle(bottleId) {
  if (!isAvailable) return;

  try {
    const bottle = await Bottle.findById(bottleId)
      .populate(WINE_POPULATE)
      .lean();

    if (!bottle) return;

    // If bottle is consumed, remove it from the index instead
    if (CONSUMED_STATUSES.includes(bottle.status)) {
      await bottlesIndex.deleteDocument(bottleId.toString());
      return;
    }

    await bottlesIndex.addDocuments([buildBottleDocument(bottle)], { primaryKey: 'id' });
  } catch (err) {
    console.error(`Meilisearch index bottle ${bottleId} failed: ${err.message}`);
  }
}

async function removeBottle(bottleId) {
  if (!isAvailable) return;

  try {
    await bottlesIndex.deleteDocument(bottleId.toString());
  } catch (err) {
    console.error(`Meilisearch remove bottle ${bottleId} failed: ${err.message}`);
  }
}

async function bulkIndexBottles(bottleIds) {
  if (!isAvailable || !bottleIds || bottleIds.length === 0) return;

  try {
    const bottles = await Bottle.find({ _id: { $in: bottleIds } })
      .populate(WINE_POPULATE)
      .lean();

    const documents = bottles
      .filter(b => !CONSUMED_STATUSES.includes(b.status))
      .map(buildBottleDocument);

    if (documents.length > 0) {
      await bottlesIndex.addDocuments(documents, { primaryKey: 'id' });
    }
  } catch (err) {
    console.error(`Meilisearch bulk index bottles failed: ${err.message}`);
  }
}

async function searchBottles(query, {
  cellarId,
  type,
  countryId,
  regionId,
  grapeIds,
  vintage,
  minRating,
  sort,
  limit = 30,
  offset = 0
} = {}) {
  if (!isAvailable) {
    throw new Error('Meilisearch is not available');
  }

  const isObjectId = (v) => /^[a-f0-9]{24}$/i.test(String(v));
  const VALID_TYPES = ['red', 'white', 'rosé', 'sparkling', 'dessert', 'fortified'];
  const filters = [];

  // Always scope to cellar and active bottles
  if (cellarId) filters.push(`cellarId = "${cellarId}"`);
  filters.push(`status NOT IN ["${CONSUMED_STATUSES.join('","')}"]`);

  // Type: single or comma-separated multi-select
  if (type) {
    const types = String(type).split(',').map(t => t.trim()).filter(t => VALID_TYPES.includes(t.toLowerCase()));
    if (types.length === 1) filters.push(`type = "${types[0]}"`);
    else if (types.length > 1) filters.push(`type IN ["${types.join('","')}"]`);
  }
  // Country: single or comma-separated ObjectIds
  if (countryId) {
    const ids = String(countryId).split(',').map(c => c.trim()).filter(isObjectId);
    if (ids.length === 1) filters.push(`countryId = "${ids[0]}"`);
    else if (ids.length > 1) filters.push(`countryId IN ["${ids.join('","')}"]`);
  }
  // Region: single or comma-separated ObjectIds
  if (regionId) {
    const ids = String(regionId).split(',').map(r => r.trim()).filter(isObjectId);
    if (ids.length === 1) filters.push(`regionId = "${ids[0]}"`);
    else if (ids.length > 1) filters.push(`regionId IN ["${ids.join('","')}"]`);
  }
  if (grapeIds && grapeIds.length > 0) {
    for (const id of grapeIds) {
      if (isObjectId(id)) filters.push(`grapeIds = "${id}"`);
    }
  }
  // Vintage: single or comma-separated
  if (vintage) {
    const vintages = String(vintage).split(',').map(v => v.trim()).filter(Boolean);
    if (vintages.length === 1) filters.push(`vintage = "${vintages[0]}"`);
    else if (vintages.length > 1) filters.push(`vintage IN ["${vintages.join('","')}"]`);
  }
  if (minRating) filters.push(`rating >= ${parseFloat(minRating)}`);

  // Build sort
  const meiliSort = [];
  if (sort && typeof sort === 'string') {
    const desc = sort.startsWith('-');
    const field = desc ? sort.slice(1) : sort;
    const sortMap = { name: 'wineName', createdAt: 'createdAt', vintage: 'vintage', price: 'price', rating: 'rating' };
    if (sortMap[field]) {
      meiliSort.push(`${sortMap[field]}:${desc ? 'desc' : 'asc'}`);
    }
  }

  const result = await bottlesIndex.search(query || '', {
    filter: filters.length > 0 ? filters : undefined,
    sort: meiliSort.length > 0 ? meiliSort : undefined,
    facets: ['type', 'countryName', 'regionName', 'vintage', 'countryId', 'regionId', 'grapeIds'],
    limit,
    offset
  });

  return {
    ids: result.hits.map(hit => hit.id),
    estimatedTotalHits: result.estimatedTotalHits || 0,
    facetDistribution: result.facetDistribution || {},
    facetStats: result.facetStats || {}
  };
}

function getIsAvailable() {
  return isAvailable;
}

module.exports = {
  initialize,
  fullSync,
  fullSyncBottles,
  indexWine,
  removeWine,
  search,
  indexBottle,
  removeBottle,
  bulkIndexBottles,
  searchBottles,
  getIsAvailable
};
