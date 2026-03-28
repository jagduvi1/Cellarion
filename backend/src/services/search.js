const { MeiliSearch } = require('meilisearch');
const WineDefinition = require('../models/WineDefinition');

const INDEX_NAME = 'wines';

let client = null;
let index = null;
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

    isAvailable = true;
    console.log(`Meilisearch connected: ${url}`);

    await fullSync();
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

  // Build filter array — sanitize values to prevent filter injection
  const sanitizeFilterValue = (v) => String(v).replace(/["\\]/g, '');
  const filters = [];
  if (countryId) filters.push(`countryId = "${sanitizeFilterValue(countryId)}"`);
  if (regionId) filters.push(`regionId = "${sanitizeFilterValue(regionId)}"`);
  if (type) filters.push(`type = "${sanitizeFilterValue(type)}"`);
  if (grapeIds && grapeIds.length > 0) {
    const grapeFilter = grapeIds.map(id => `grapeIds = "${sanitizeFilterValue(id)}"`).join(' AND ');
    filters.push(grapeFilter);
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
    filter: filters.length > 0 ? filters.join(' AND ') : undefined,
    sort: meiliSort.length > 0 ? meiliSort : undefined,
    limit,
    offset
  });

  return {
    ids: result.hits.map(hit => hit.id),
    estimatedTotalHits: result.estimatedTotalHits || 0
  };
}

function getIsAvailable() {
  return isAvailable;
}

module.exports = {
  initialize,
  fullSync,
  indexWine,
  removeWine,
  search,
  getIsAvailable
};
