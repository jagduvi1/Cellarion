/**
 * The public API contract: an OpenAPI 3.1 document for everything a personal
 * API token may rely on. GET /api/openapi.json serves it (routes/openapi.js)
 * and cellarion.app/developers renders it.
 *
 * Public means stable. A path, parameter or field in this document keeps its
 * name, type and meaning; new optional ones may appear, and clients ignore
 * what they don't know. Anything a token can reach that is NOT in here is
 * internal and may change without notice. A removal is announced in the
 * release notes and on /developers, carries Deprecation and Sunset headers,
 * and takes effect no sooner than six months later.
 *
 * Three tests keep this honest:
 *  - openapi/contract.test.js calls every operation on the real app against
 *    a real MongoDB and validates each answer against the schemas below;
 *  - openapi/allowlist.test.js holds the operations and their scopes equal to
 *    the token allowlist (middleware/apiTokenAuth.js);
 *  - openapi/document.test.js checks the document itself and its examples.
 *
 * Schemas list the documented fields only and stay open
 * (additionalProperties), so a response may carry more. `required` holds what
 * a client can count on being present.
 */

const { guideMarkdown, codeSamples } = require('./guide');

const OBJECT_ID = { type: 'string', pattern: '^[a-f0-9]{24}$', examples: ['66f0c0ffee0123456789abcd'] };
const nullable = (schema) => ({ ...schema, type: [schema.type, 'null'] });
const NULL_ID = { type: ['string', 'null'], pattern: '^[a-f0-9]{24}$' };
const DATE_TIME = { type: 'string', format: 'date-time' };
const YEAR = { type: ['integer', 'null'], minimum: 1900, maximum: 2200 };
const RATING_SCALE = { type: 'string', enum: ['5', '20', '100'], description: '"5" = stars, "20" = points out of 20, "100" = points out of 100.' };
const WINE_TYPE = { type: ['string', 'null'], enum: ['red', 'white', 'rosé', 'sparkling', 'dessert', 'fortified', null] };
const MATURITY = {
  type: ['string', 'null'],
  enum: ['not-ready', 'early', 'peak', 'late', 'declining', null],
  description: 'Where the bottle is in its drink window today, or null when it has no window.',
};
const RACK_TYPE = { type: 'string', enum: ['grid', 'x-rack', 'hex', 'triangle', 'stack', 'cube', 'shelf', 'cabinet'] };
const CELLAR_ROLE = { type: 'string', enum: ['owner', 'editor', 'viewer'] };
const BOTTLE_STATUS = {
  type: 'string',
  enum: ['active', 'ordered', 'drank', 'gifted', 'sold', 'other'],
  description: '`active` = in the cellar, `ordered` = bought but not delivered yet; the rest say how it left.',
};

const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema, example) => ({ 'application/json': { schema, ...(example !== undefined ? { example } : {}) } });

const rateLimitHeaders = {
  'RateLimit-Limit': { $ref: '#/components/headers/RateLimitLimit' },
  'RateLimit-Remaining': { $ref: '#/components/headers/RateLimitRemaining' },
  'RateLimit-Reset': { $ref: '#/components/headers/RateLimitReset' },
  'RateLimit-Policy': { $ref: '#/components/headers/RateLimitPolicy' },
};

const ok = (description, schema, example, headers = {}) => ({
  description,
  headers: { ...rateLimitHeaders, ...headers },
  content: json(schema, example),
});

const errors = (...codes) => Object.fromEntries(codes.map((c) => [String(c), { $ref: `#/components/responses/${{
  400: 'BadRequest', 401: 'Unauthorized', 403: 'Forbidden', 404: 'NotFound', 409: 'Conflict', 429: 'TooManyRequests',
}[c]}` }]));

const scope = (s) => [{ apiToken: [s] }];

// ── Example ids (fictional) ────────────────────────────────────────────────
const ID = {
  user: '66f0a1b2c3d4e5f6a7b8c901',
  cellar: '66f0a1b2c3d4e5f6a7b8c902',
  shared: '66f0a1b2c3d4e5f6a7b8c903',
  rack: '66f0a1b2c3d4e5f6a7b8c904',
  wine: '66f0a1b2c3d4e5f6a7b8c905',
  bottle: '66f0a1b2c3d4e5f6a7b8c906',
  bottle2: '66f0a1b2c3d4e5f6a7b8c907',
  country: '66f0a1b2c3d4e5f6a7b8c908',
  region: '66f0a1b2c3d4e5f6a7b8c909',
  grape: '66f0a1b2c3d4e5f6a7b8c90a',
  notification: '66f0a1b2c3d4e5f6a7b8c90b',
  token: '66f0a1b2c3d4e5f6a7b8c90c',
};
const THUMB = '/api/uploads/thumbs/processed/3f2b8c1e-4a5d-4e6f-9a7b-1c2d3e4f5a6b.webp.webp';
const PHOTO = 'https://cellarion.app/api/uploads/processed/3f2b8c1e-4a5d-4e6f-9a7b-1c2d3e4f5a6b.webp';

const exampleWineSummary = {
  _id: ID.wine,
  name: 'Château Exemple',
  producer: 'Château Exemple',
  type: 'red',
  colour: null,
  country: { _id: ID.country, name: 'France' },
  region: { _id: ID.region, name: 'Pauillac' },
  appellation: 'Pauillac',
  classification: null,
  grapes: [{ _id: ID.grape, name: 'Cabernet Sauvignon', displayName: 'Cabernet Sauvignon' }],
  image: PHOTO,
};

const exampleBottle = {
  _id: ID.bottle,
  cellar: ID.cellar,
  wineDefinition: exampleWineSummary,
  pendingWineRequest: null,
  vintage: '2015',
  bottleSize: '750ml',
  price: 350,
  currency: 'SEK',
  rating: 92,
  ratingScale: '100',
  status: 'active',
  location: 'Basement, box 3',
  notes: 'For a birthday',
  purchaseDate: '2024-05-01T00:00:00.000Z',
  purchaseLocation: 'Wine shop',
  openedAt: null,
  addedToCellarAt: '2025-01-02T10:00:00.000Z',
  createdAt: '2025-01-02T10:00:00.000Z',
  updatedAt: '2025-01-02T10:00:00.000Z',
  defaultImageUrl: null,
  vintageImageUrl: null,
  pendingImageUrl: null,
  otherVintageImageUrl: null,
};

// ── Schemas ────────────────────────────────────────────────────────────────
const schemas = {
  Error: {
    type: 'object',
    description: 'Every error answers this shape. `error` is a human-readable message (English); `code`, where present, is a stable machine-readable reason.',
    required: ['error'],
    properties: {
      error: { type: 'string' },
      code: { type: 'string', description: 'Present on some errors, e.g. `state_changed` on a consume with `ifActive`.' },
    },
  },
  Health: {
    type: 'object',
    required: ['status', 'mongo', 'version'],
    properties: {
      status: { type: 'string', enum: ['ok', 'degraded', 'draining'] },
      mongo: { type: 'string', enum: ['connected', 'disconnected'] },
      version: { type: 'string', description: 'The server\'s Cellarion version. A self-hosted server can be older than cellarion.app.', examples: ['1.275.0'] },
    },
  },
  WhoAmI: {
    type: 'object',
    required: ['id'],
    properties: { id: { ...OBJECT_ID, description: 'The id of the account the token belongs to. Stable; use it to tell two accounts apart.' } },
  },

  // Inventory
  Inventory: {
    type: 'object',
    description: 'Every bottle still in the caller\'s cellars and in the cellars shared with them. Drunk, gifted, sold and on-order bottles are left out. Each wine appears once in `wines`; bottles reference it by id.',
    required: ['schema', 'generatedAt', 'cellars', 'racks', 'wines', 'bottles'],
    properties: {
      schema: { type: 'integer', const: 1, description: 'The shape version of this document. It changes only with a breaking change, announced as described under Stability.' },
      generatedAt: DATE_TIME,
      cellars: { type: 'array', items: ref('InventoryCellar') },
      racks: { type: 'array', items: ref('InventoryRack') },
      wines: { type: 'object', additionalProperties: ref('InventoryWine'), description: 'Keyed by wine id.' },
      bottles: { type: 'array', items: ref('InventoryBottle') },
    },
  },
  InventoryCellar: {
    type: 'object',
    required: ['id', 'name', 'role'],
    properties: { id: OBJECT_ID, name: { type: ['string', 'null'] }, role: CELLAR_ROLE },
  },
  InventoryRack: {
    type: 'object',
    required: ['id', 'cellar', 'name'],
    properties: { id: OBJECT_ID, cellar: OBJECT_ID, name: { type: ['string', 'null'] } },
  },
  InventoryWine: {
    type: 'object',
    required: ['name', 'producer', 'type', 'colour', 'country', 'region', 'appellation', 'classification', 'grapes', 'image', 'profile'],
    properties: {
      name: { type: ['string', 'null'] },
      producer: { type: ['string', 'null'] },
      type: WINE_TYPE,
      colour: { ...WINE_TYPE, description: 'The colour of a sparkling, dessert or fortified wine (e.g. a sparkling rosé), or null.' },
      country: { type: ['string', 'null'] },
      region: { type: ['string', 'null'] },
      appellation: { type: ['string', 'null'] },
      classification: { type: ['string', 'null'] },
      grapes: { type: 'array', items: { type: 'string' }, description: 'Display names, as on the label.' },
      image: { type: ['string', 'null'], description: 'A thumbnail path on this server (see Images), or null.' },
      profile: {
        oneOf: [{ type: 'null' }, ref('TastingProfile')],
        description: 'The stored tasting descriptors, or null when the wine has none.',
      },
    },
  },
  TastingProfile: {
    type: 'object',
    required: ['body', 'acidity', 'sweetness', 'tannin', 'flavors', 'foodPairings'],
    properties: {
      body: { type: ['string', 'null'] },
      acidity: { type: ['string', 'null'] },
      sweetness: { type: ['string', 'null'] },
      tannin: { type: ['string', 'null'] },
      flavors: { type: 'array', items: { type: 'string' }, maxItems: 12 },
      foodPairings: { type: 'array', items: { type: 'string' }, maxItems: 12 },
    },
  },
  InventoryBottle: {
    type: 'object',
    required: ['id', 'wine', 'pending', 'cellar', 'vintage', 'size', 'price', 'currency', 'rating', 'ratingScale', 'notes',
      'purchaseDate', 'purchaseLocation', 'addedAt', 'opened', 'maturity', 'window', 'location', 'place', 'image', 'personal'],
    properties: {
      id: OBJECT_ID,
      wine: { ...NULL_ID, description: 'A key of `wines`, or null while the bottle waits on a wine request.' },
      pending: {
        type: ['object', 'null'],
        description: 'The wine request this bottle waits on, when `wine` is null.',
        properties: { name: { type: ['string', 'null'] }, producer: { type: ['string', 'null'] } },
      },
      cellar: OBJECT_ID,
      vintage: { type: ['string', 'null'], examples: ['2015', 'NV'] },
      size: { type: ['string', 'null'], examples: ['750ml', '1500ml'] },
      price: { type: ['number', 'null'] },
      currency: { type: ['string', 'null'], examples: ['SEK', 'EUR'] },
      rating: { type: ['number', 'null'] },
      ratingScale: { ...nullable(RATING_SCALE), enum: ['5', '20', '100', null], description: 'Set only beside a rating.' },
      notes: { type: ['string', 'null'] },
      purchaseDate: { type: ['string', 'null'], format: 'date' },
      purchaseLocation: { type: ['string', 'null'] },
      addedAt: { type: ['string', 'null'], format: 'date-time' },
      opened: { type: 'boolean', description: 'True while the bottle is open (some glasses poured).' },
      maturity: MATURITY,
      window: ref('DrinkWindow'),
      location: { oneOf: [{ type: 'null' }, ref('RackLocation')], description: 'The rack slot holding the bottle, or null when it is in no rack.' },
      place: { type: ['string', 'null'], description: 'The bottle\'s free-text location ("Basement, box 3").' },
      image: { type: ['string', 'null'], description: 'The bottle card\'s picture as a thumbnail path on this server, or null.' },
      personal: { type: 'array', items: ref('PersonalEntry') },
    },
  },
  DrinkWindow: {
    type: 'object',
    description: 'The bottle\'s own window when it has one, else the reviewed window for its wine and vintage. Each is a year or null.',
    required: ['drinkFrom', 'peakFrom', 'peakUntil', 'drinkTo'],
    properties: { drinkFrom: YEAR, peakFrom: YEAR, peakUntil: YEAR, drinkTo: YEAR },
  },
  RackLocation: {
    type: 'object',
    required: ['rack', 'rackName', 'position', 'shelf', 'row', 'col'],
    properties: {
      rack: OBJECT_ID,
      rackName: { type: ['string', 'null'] },
      position: { type: ['integer', 'null'], minimum: 1, description: 'The 1-based slot number.' },
      shelf: { type: ['integer', 'null'], minimum: 1, description: 'Wine fridges (cabinet racks): 1 = the top shelf. Null on other rack types.' },
      row: { type: ['integer', 'null'], minimum: 1, description: 'Cabinets: the row within the shelf, 1 = resting on the shelf. Grids: the row from the top. Null on other types.' },
      col: { type: ['integer', 'null'], minimum: 1, description: 'The slot within the row, left to right. Null where the rack has no rows.' },
    },
  },
  PersonalEntry: {
    type: 'object',
    description: 'A typed personal field on the bottle or its wine, as the bottle page shows it. Bottle-level entries come first.',
    required: ['key', 'type', 'unit', 'value', 'level', 'by'],
    properties: {
      key: { type: 'string', examples: ['Closure'] },
      type: { type: ['string', 'null'], enum: ['text', 'integer', 'decimal', 'boolean', 'date', 'enum', null] },
      unit: { type: ['string', 'null'] },
      value: { description: 'A string, number or boolean, matching `type`.' },
      level: { type: 'string', enum: ['bottle', 'wine'] },
      by: { type: ['string', 'null'], description: 'The username of the member who wrote it.' },
    },
  },

  // Cellars, bottles, racks
  CellarList: {
    type: 'object',
    required: ['count', 'cellars'],
    properties: { count: { type: 'integer', minimum: 0 }, cellars: { type: 'array', items: ref('Cellar') } },
  },
  Cellar: {
    type: 'object',
    required: ['_id', 'name', 'user', 'userRole'],
    properties: {
      _id: OBJECT_ID,
      name: { type: 'string' },
      description: { type: 'string' },
      user: { ...OBJECT_ID, description: 'The owner\'s account id.' },
      userRole: { ...CELLAR_ROLE, description: 'The caller\'s role in this cellar.' },
      userColor: { type: ['string', 'null'], description: 'The colour the caller picked for this cellar, or null.' },
      createdAt: DATE_TIME,
      updatedAt: DATE_TIME,
    },
  },
  WineSummary: {
    type: 'object',
    required: ['_id', 'name'],
    properties: {
      _id: OBJECT_ID,
      name: { type: 'string' },
      producer: { type: ['string', 'null'] },
      type: WINE_TYPE,
      colour: WINE_TYPE,
      country: { oneOf: [{ type: 'null' }, ref('NamedRef')] },
      region: { oneOf: [{ type: 'null' }, ref('NamedRef')] },
      appellation: { type: ['string', 'null'] },
      classification: { type: ['string', 'null'] },
      grapes: { type: 'array', items: ref('Grape') },
      image: { type: ['string', 'null'], description: 'The registry image URL, or null.' },
    },
  },
  NamedRef: {
    type: 'object',
    required: ['_id', 'name'],
    properties: { _id: OBJECT_ID, name: { type: 'string' } },
  },
  Grape: {
    type: 'object',
    required: ['_id', 'name'],
    properties: {
      _id: OBJECT_ID,
      name: { type: 'string' },
      displayName: { type: 'string', description: 'The name as this wine\'s label region uses it.' },
    },
  },
  Bottle: {
    type: 'object',
    description: 'One bottle. Fields that are not set may be absent.',
    required: ['_id', 'cellar', 'status'],
    properties: {
      _id: OBJECT_ID,
      cellar: OBJECT_ID,
      wineDefinition: {
        oneOf: [{ type: 'null' }, OBJECT_ID, ref('WineSummary')],
        description: 'The wine: an object in lists and the bottle detail, its id alone in the consume answer; null while the bottle waits on a wine request.',
      },
      pendingWineRequest: {
        description: 'The wine request the bottle waits on, when it has no wine yet.',
        oneOf: [{ type: 'null' }, OBJECT_ID, {
          type: 'object',
          properties: { _id: OBJECT_ID, wineName: { type: 'string' }, producer: { type: ['string', 'null'] } },
        }],
      },
      vintage: { type: 'string', examples: ['2015', 'NV'] },
      bottleSize: { type: 'string', examples: ['750ml'] },
      price: { type: ['number', 'null'] },
      currency: { type: 'string' },
      rating: { type: ['number', 'null'] },
      ratingScale: RATING_SCALE,
      status: BOTTLE_STATUS,
      location: { type: 'string', description: 'Free-text location.' },
      notes: { type: 'string' },
      purchaseDate: { type: ['string', 'null'], format: 'date-time' },
      purchaseLocation: { type: 'string' },
      drinkFrom: YEAR,
      peakFrom: YEAR,
      peakUntil: YEAR,
      drinkTo: YEAR,
      openedAt: { type: ['string', 'null'], format: 'date-time' },
      consumedAt: { type: ['string', 'null'], format: 'date-time' },
      consumedReason: { type: ['string', 'null'], enum: ['drank', 'gifted', 'sold', 'other', null] },
      addedToCellarAt: DATE_TIME,
      createdAt: DATE_TIME,
      updatedAt: DATE_TIME,
      defaultImageUrl: { type: ['string', 'null'] },
      vintageImageUrl: { type: ['string', 'null'] },
      pendingImageUrl: { type: ['string', 'null'] },
      otherVintageImageUrl: { type: ['string', 'null'] },
    },
  },
  BottleList: {
    type: 'object',
    required: ['bottles'],
    properties: {
      bottles: {
        type: 'object',
        required: ['count', 'total', 'limit', 'skip', 'items'],
        properties: {
          count: { type: 'integer', minimum: 0, description: 'Items on this page.' },
          total: { type: 'integer', minimum: 0, description: 'Items across all pages.' },
          limit: { type: 'integer', minimum: 1, maximum: 200 },
          skip: { type: 'integer', minimum: 0, description: 'The offset of this page.' },
          items: { type: 'array', items: ref('Bottle') },
        },
      },
    },
  },
  BottleDetail: {
    type: 'object',
    required: ['bottle', 'userRole', 'rackInfo'],
    properties: {
      bottle: ref('Bottle'),
      userRole: { ...CELLAR_ROLE, description: 'The caller\'s role in the bottle\'s cellar.' },
      rackInfo: {
        description: 'Where the bottle sits, or null when it is in no rack.',
        oneOf: [{ type: 'null' }, {
          type: 'object',
          required: ['rackId', 'rackName', 'position'],
          properties: { rackId: OBJECT_ID, rackName: { type: 'string' }, position: { type: 'integer', minimum: 1 } },
        }],
      },
      defaultImageUrl: { type: ['string', 'null'] },
      vintageImageUrl: { type: ['string', 'null'] },
      pendingImageUrl: { type: ['string', 'null'] },
      otherVintageImageUrl: { type: ['string', 'null'] },
    },
  },
  RackList: {
    type: 'object',
    required: ['racks'],
    properties: { racks: { type: 'array', items: ref('RackSummary') } },
  },
  RackSummary: {
    type: 'object',
    required: ['_id', 'cellar', 'name', 'type', 'rows', 'cols', 'slots'],
    properties: {
      _id: OBJECT_ID,
      cellar: OBJECT_ID,
      name: { type: 'string' },
      group: { type: ['string', 'null'], description: 'A user-named group, such as a room or an appliance.' },
      type: RACK_TYPE,
      rows: { type: 'integer', minimum: 1, description: 'Cabinets: the number of shelves.' },
      cols: { type: 'integer', minimum: 1 },
      typeConfig: { type: 'object', description: 'Type-specific geometry (shelf rows, two-deep, …). Read `GET /api/inventory` for shelf/row/col instead of computing them.' },
      isModular: { type: 'boolean' },
      slots: {
        type: 'array',
        items: {
          type: 'object',
          required: ['position', 'bottle'],
          properties: { position: { type: 'integer', minimum: 1 }, bottle: OBJECT_ID },
        },
      },
      createdAt: DATE_TIME,
      updatedAt: DATE_TIME,
    },
  },

  // Statistics
  StatsOverview: {
    type: 'object',
    required: ['stats'],
    properties: {
      stats: {
        type: 'object',
        description: 'Statistics over the cellars the caller OWNS. Only the parts listed here are part of the contract; the answer carries more, which may change.',
        required: ['overview', 'maturity', 'pace', 'byType', 'byCountry', 'cellarBreakdown', 'topProducers', 'urgencyLadder'],
        properties: {
          overview: {
            type: 'object',
            required: ['totalBottles', 'totalConsumed', 'uniqueWines', 'totalCellars', 'totalCountries', 'totalGrapes', 'totalValue',
              'currency', 'avgPrice', 'avgRating', 'targetRatingScale', 'oldestVintage', 'newestVintage', 'bottlesDrunk', 'bottlesGifted', 'bottlesSold'],
            properties: {
              totalBottles: { type: 'integer', minimum: 0 },
              totalConsumed: { type: 'integer', minimum: 0 },
              uniqueWines: { type: 'integer', minimum: 0 },
              totalCellars: { type: 'integer', minimum: 0 },
              totalCountries: { type: 'integer', minimum: 0 },
              totalGrapes: { type: 'integer', minimum: 0 },
              totalValue: { type: 'number', description: 'In `currency`, from the bottles\' purchase prices.' },
              currency: { type: 'string', description: 'The caller\'s preferred currency.' },
              avgPrice: { type: 'number' },
              avgRating: { type: ['number', 'null'], description: 'In `targetRatingScale`.' },
              targetRatingScale: RATING_SCALE,
              oldestVintage: { type: ['integer', 'null'] },
              newestVintage: { type: ['integer', 'null'] },
              bottlesDrunk: { type: 'integer', minimum: 0 },
              bottlesGifted: { type: 'integer', minimum: 0 },
              bottlesSold: { type: 'integer', minimum: 0 },
            },
          },
          maturity: {
            type: 'object',
            description: 'Bottles per drink-window stage.',
            required: ['declining', 'late', 'peak', 'early', 'notReady', 'noProfile'],
            properties: Object.fromEntries(['declining', 'late', 'peak', 'early', 'notReady', 'noProfile'].map((k) => [k, { type: 'integer', minimum: 0 }])),
          },
          pace: {
            type: 'object',
            required: ['avgIntakePerYear', 'avgOutputPerYear', 'netPerYear', 'runway'],
            properties: {
              avgIntakePerYear: { type: 'number' },
              avgOutputPerYear: { type: 'number' },
              netPerYear: { type: 'number' },
              runway: { type: ['integer', 'null'], description: 'Years until the cellar is empty at the current pace, or null.' },
            },
          },
          byType: { type: 'object', additionalProperties: { type: 'integer', minimum: 0 }, description: 'Bottle count per wine type; `unknown` for bottles without one.' },
          byCountry: {
            type: 'array',
            items: { type: 'object', required: ['name', 'count'], properties: { name: { type: 'string' }, count: { type: 'integer', minimum: 0 } } },
          },
          cellarBreakdown: {
            type: 'array',
            items: {
              type: 'object',
              required: ['id', 'name', 'bottleCount', 'value'],
              properties: { id: OBJECT_ID, name: { type: 'string' }, bottleCount: { type: 'integer', minimum: 0 }, value: { type: 'number' } },
            },
          },
          topProducers: {
            type: 'array',
            maxItems: 10,
            items: { type: 'object', required: ['name', 'count'], properties: { name: { type: 'string' }, count: { type: 'integer', minimum: 0 } } },
          },
          urgencyLadder: {
            type: 'array',
            maxItems: 10,
            description: 'Bottles past their peak, most urgent first.',
            items: {
              type: 'object',
              required: ['id', 'cellarId', 'name', 'producer', 'vintage', 'type', 'price', 'status'],
              properties: {
                id: OBJECT_ID,
                cellarId: OBJECT_ID,
                name: { type: 'string' },
                producer: { type: 'string' },
                vintage: { type: 'string' },
                type: { type: 'string' },
                price: { type: ['number', 'null'], description: 'In the overview\'s currency.' },
                status: { type: 'string', enum: ['late', 'declining'] },
              },
            },
          },
        },
      },
    },
  },

  // Notifications
  NotificationList: {
    type: 'object',
    required: ['notifications', 'unreadCount'],
    properties: {
      notifications: { type: 'array', maxItems: 30, items: ref('Notification'), description: 'The 30 newest, newest first.' },
      unreadCount: { type: 'integer', minimum: 0, description: 'Unread across all notifications, not only these 30.' },
    },
  },
  Notification: {
    type: 'object',
    required: ['_id', 'type', 'title', 'message', 'read', 'createdAt'],
    properties: {
      _id: OBJECT_ID,
      type: { type: 'string', description: 'What it is about. New types appear over time; show the title and message of a type you don\'t know.' },
      title: { type: 'string' },
      message: { type: 'string' },
      link: { type: ['string', 'null'], description: 'A path in the web app, relative to the server.' },
      read: { type: 'boolean' },
      createdAt: DATE_TIME,
    },
  },
  UnreadCount: {
    type: 'object',
    required: ['unreadCount', 'newestId'],
    properties: {
      unreadCount: { type: 'integer', minimum: 0 },
      newestId: { ...NULL_ID, description: 'The newest notification\'s id: when it changes, fetch the list.' },
    },
  },

  // Consume
  ConsumeRequest: {
    type: 'object',
    properties: {
      reason: { type: 'string', enum: ['drank', 'gifted', 'sold', 'other'], default: 'drank' },
      rating: { type: 'number', description: 'Your rating of the bottle, in `consumedRatingScale`.' },
      consumedRatingScale: { ...RATING_SCALE, description: 'The scale of `rating`. Defaults to your preferred scale.' },
      note: { type: 'string', maxLength: 1000 },
      consumedAt: { type: 'string', description: 'When it was drunk, if not now: a date or date-time, not in the future.' },
      ifActive: {
        type: 'boolean',
        description: 'Send `true`. The bottle is then consumed only if it is still in the cellar; one that already left (consumed elsewhere) answers 409 `state_changed` instead of being overwritten.',
      },
    },
  },
  ConsumeResponse: {
    type: 'object',
    required: ['bottle'],
    properties: { bottle: ref('Bottle') },
  },

  // Climate
  ClimateIngestRequest: {
    type: 'object',
    required: ['readings'],
    properties: {
      readings: {
        type: 'array',
        minItems: 1,
        maxItems: 100,
        items: {
          type: 'object',
          required: ['channel', 'type', 'value'],
          properties: {
            channel: { type: 'string', pattern: '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$', description: 'Your name for the sensor, e.g. `fridge`.' },
            type: { type: 'string', enum: ['temperature', 'humidity'] },
            value: { type: 'number', description: '°C, or % relative humidity.' },
            ts: { type: 'string', format: 'date-time', description: 'When it was measured, if not now.' },
          },
        },
      },
      firmware: { type: 'string', maxLength: 100 },
      rssi: { type: 'number' },
    },
  },
  ClimateIngestResponse: {
    type: 'object',
    required: ['accepted', 'rejected', 'intervalS'],
    properties: {
      accepted: { type: 'integer', minimum: 0 },
      rejected: { type: 'integer', minimum: 0 },
      errors: {
        type: 'array',
        maxItems: 10,
        items: { type: 'object', required: ['index', 'reason'], properties: { index: { type: 'integer', minimum: 0 }, reason: { type: 'string' } } },
      },
      intervalS: { type: 'integer', minimum: 1, description: 'Seconds to wait before the next post.' },
    },
  },

  TokenRevoked: {
    type: 'object',
    required: ['message', 'id', 'name'],
    properties: { message: { type: 'string' }, id: OBJECT_ID, name: { type: 'string' } },
  },
};

// ── Examples ───────────────────────────────────────────────────────────────
const examples = {
  inventory: {
    schema: 1,
    generatedAt: '2026-10-22T08:00:00.000Z',
    cellars: [{ id: ID.cellar, name: 'Home', role: 'owner' }, { id: ID.shared, name: 'Summer house', role: 'editor' }],
    racks: [{ id: ID.rack, cellar: ID.cellar, name: 'Wine fridge' }],
    wines: {
      [ID.wine]: {
        name: 'Château Exemple', producer: 'Château Exemple', type: 'red', colour: null,
        country: 'France', region: 'Pauillac', appellation: 'Pauillac', classification: null,
        grapes: ['Cabernet Sauvignon', 'Merlot'], image: THUMB,
        profile: { body: 'full', acidity: 'medium', sweetness: 'dry', tannin: 'high', flavors: ['blackcurrant', 'cedar'], foodPairings: ['lamb'] },
      },
    },
    bottles: [{
      id: ID.bottle, wine: ID.wine, pending: null, cellar: ID.cellar,
      vintage: '2015', size: '750ml', price: 350, currency: 'SEK', rating: 92, ratingScale: '100',
      notes: 'For a birthday', purchaseDate: '2024-05-01', purchaseLocation: 'Wine shop',
      addedAt: '2025-01-02T10:00:00.000Z', opened: false, maturity: 'peak',
      window: { drinkFrom: 2022, peakFrom: 2025, peakUntil: 2032, drinkTo: 2038 },
      location: { rack: ID.rack, rackName: 'Wine fridge', position: 5, shelf: 2, row: 1, col: 2 },
      place: null, image: THUMB,
      personal: [{ key: 'Closure', type: 'text', unit: null, value: 'cork', level: 'bottle', by: 'alice' }],
    }],
  },
};

// ── Operations ─────────────────────────────────────────────────────────────
const paths = {
  '/api/inventory': {
    get: {
      operationId: 'getInventory',
      tags: ['Inventory'],
      summary: 'The whole inventory in one read',
      description: [
        'Every bottle still in your cellars and in the cellars shared with you, each with its wine, its drink window, where it is (rack, shelf, row, slot) and its personal fields. **Start here**: one call replaces paging the bottle list, and an unchanged poll costs almost nothing.',
        '',
        'Send the `ETag` of the copy you hold as `If-None-Match`. When nothing changed you get `304` with no body. The tag moves when any of the data changes, and at least every 30 minutes.',
        '',
        'Limited to 60 requests per user per 10 minutes, 304s included. Poll every few minutes, or refetch when the event stream says something changed.',
      ].join('\n'),
      security: scope('read'),
      parameters: [{ $ref: '#/components/parameters/IfNoneMatch' }],
      responses: {
        200: ok('The inventory.', ref('Inventory'), examples.inventory, {
          ETag: { $ref: '#/components/headers/ETag' },
          'Cache-Control': { description: 'Always `no-store`: the answer holds personal data.', schema: { type: 'string', const: 'no-store' } },
        }),
        304: {
          description: 'Nothing changed since that ETag. No body.',
          headers: { ETag: { $ref: '#/components/headers/ETag' }, ...rateLimitHeaders },
        },
        ...errors(401, 403, 429),
      },
    },
  },
  '/api/events/stream': {
    get: {
      operationId: 'streamEvents',
      tags: ['Live updates'],
      summary: 'Server-sent events when your data changes',
      description: [
        'A long-lived `text/event-stream` (Server-Sent Events). It says *that* something changed, not what: refetch what you show (for example `GET /api/inventory` with its ETag).',
        '',
        'On connect: `retry: 5000`, then `event: ready`. Events: `stats_changed` (`data: {"reason": "…"}`), `notification` (`data: {"id": "…", "type": "…"}`) and `climate` (`data: {"device": "…"}`). Events are coalesced over about 2 seconds. A `: hb` comment arrives every 25 seconds; treat 90 seconds of silence as a lost connection and reconnect with backoff.',
        '',
        'A stream lasts at most 24 hours and closes when the token is revoked. At most 5 streams per user (429 beyond). New event names may appear; ignore the ones you don\'t know.',
      ].join('\n'),
      security: scope('read'),
      responses: {
        200: {
          description: 'The event stream.',
          content: { 'text/event-stream': { schema: { type: 'string' }, example: 'retry: 5000\n\nevent: ready\ndata: {}\n\nevent: stats_changed\ndata: {"reason":"bottle.consume"}\n\n: hb\n\n' } },
        },
        ...errors(401, 403, 429),
      },
    },
  },
  '/api/auth/whoami': {
    get: {
      operationId: 'whoAmI',
      tags: ['Tokens'],
      summary: 'Which account this token belongs to',
      description: 'The account id only, no personal details. Useful to check that a new token belongs to the same account as the old one.',
      security: scope('read'),
      responses: {
        200: ok('The account id.', ref('WhoAmI'), { id: ID.user }),
        ...errors(401, 403),
      },
    },
  },
  '/api/cellars': {
    get: {
      operationId: 'listCellars',
      tags: ['Cellars and bottles'],
      summary: 'Your cellars and the ones shared with you',
      security: scope('read'),
      responses: {
        200: ok('The cellars, newest first.', ref('CellarList'), {
          count: 1,
          cellars: [{
            _id: ID.cellar, name: 'Home', description: 'The basement', user: ID.user, userRole: 'owner', userColor: null,
            createdAt: '2025-01-02T10:00:00.000Z', updatedAt: '2025-01-02T10:00:00.000Z',
          }],
        }),
        ...errors(401, 403),
      },
    },
  },
  '/api/bottles': {
    get: {
      operationId: 'listBottles',
      tags: ['Cellars and bottles'],
      summary: 'Bottles in the cellars you own, filtered and paged',
      description: 'Bottles in cellars you **own** (shared cellars are not included; `GET /api/inventory` covers both). By default only bottles still in the cellar. For everything at once, prefer `GET /api/inventory`.',
      security: scope('read'),
      parameters: [
        { $ref: '#/components/parameters/Limit' },
        { $ref: '#/components/parameters/Offset' },
        { name: 'status', in: 'query', schema: { type: 'string', enum: ['active', 'all', 'ordered', 'drank', 'gifted', 'sold', 'other', 'consumed'], default: 'active' }, description: '`consumed` = drank, gifted, sold or other.' },
        { name: 'maturity', in: 'query', schema: { type: 'string', examples: ['peak', 'late,declining'] }, description: 'One or more of `not-ready`, `early`, `peak`, `late`, `declining`, `none`, comma-separated.' },
        { name: 'search', in: 'query', schema: { type: 'string' }, description: 'Words in the wine name, producer, region or notes; typo-tolerant.' },
        { name: 'type', in: 'query', schema: { type: 'string' }, description: 'Wine type, e.g. `red`. Comma-separated for several.' },
        { name: 'vintage', in: 'query', schema: { type: 'string' }, description: 'One or more vintages, comma-separated.' },
        { name: 'sort', in: 'query', schema: { type: 'string', enum: ['createdAt', '-createdAt', 'vintage', '-vintage', 'price', '-price', 'rating', '-rating', 'name', '-name', 'maturity', '-maturity'], default: '-createdAt' }, description: 'A leading `-` sorts descending.' },
      ],
      responses: {
        200: ok('One page of bottles.', ref('BottleList'), { bottles: { count: 1, total: 1, limit: 30, skip: 0, items: [exampleBottle] } }),
        ...errors(401, 403),
      },
    },
  },
  '/api/bottles/{bottleId}': {
    get: {
      operationId: 'getBottle',
      tags: ['Cellars and bottles'],
      summary: 'One bottle',
      security: scope('read'),
      parameters: [{ $ref: '#/components/parameters/BottleId' }],
      responses: {
        200: ok('The bottle.', ref('BottleDetail'), {
          bottle: exampleBottle, userRole: 'owner', rackInfo: { rackId: ID.rack, rackName: 'Wine fridge', position: 5 },
          defaultImageUrl: null, vintageImageUrl: null, pendingImageUrl: null, otherVintageImageUrl: null,
        }),
        ...errors(400, 401, 403, 404),
      },
    },
  },
  '/api/bottles/{bottleId}/consume': {
    post: {
      operationId: 'consumeBottle',
      tags: ['Drinking'],
      summary: 'Take a bottle out of the cellar',
      description: 'Marks the bottle drunk (or gifted, sold, other). Needs the `consume` scope and editor access to the cellar. Send `ifActive: true` so a bottle that already left the cellar is never overwritten.',
      security: scope('consume'),
      parameters: [{ $ref: '#/components/parameters/BottleId' }],
      requestBody: {
        required: false,
        content: json(ref('ConsumeRequest'), { reason: 'drank', rating: 4, consumedRatingScale: '5', note: 'With friends', ifActive: true }),
      },
      responses: {
        200: ok('The bottle, now out of the cellar.', ref('ConsumeResponse'), { bottle: { ...exampleBottle, status: 'drank', consumedAt: '2026-10-22T19:30:00.000Z', consumedReason: 'drank' } }),
        ...errors(400, 401, 403, 404, 409, 429),
      },
    },
  },
  '/api/racks': {
    get: {
      operationId: 'listRacks',
      tags: ['Cellars and bottles'],
      summary: 'The racks in one cellar',
      description: 'With a token, racks are read in summary form: send `summary=1`. Slots carry bottle ids only.',
      security: scope('read'),
      parameters: [
        { name: 'cellar', in: 'query', required: true, schema: OBJECT_ID },
        { name: 'summary', in: 'query', required: true, schema: { type: 'string', const: '1' } },
      ],
      responses: {
        200: ok('The racks.', ref('RackList'), {
          racks: [{
            _id: ID.rack, cellar: ID.cellar, name: 'Wine fridge', group: null, type: 'cabinet', rows: 2, cols: 3,
            typeConfig: { shelfRows: [1, 1] }, isModular: false, slots: [{ position: 5, bottle: ID.bottle }],
            createdAt: '2025-01-02T10:00:00.000Z', updatedAt: '2025-01-02T10:00:00.000Z',
          }],
        }),
        ...errors(400, 401, 403, 404),
      },
    },
  },
  '/api/stats/overview': {
    get: {
      operationId: 'getStatsOverview',
      tags: ['Statistics'],
      summary: 'Statistics over the cellars you own',
      description: 'Values in your preferred currency and rating scale. Cached for up to 30 minutes.',
      security: scope('read'),
      responses: {
        200: ok('The statistics.', ref('StatsOverview'), {
          stats: {
            overview: {
              totalBottles: 42, totalConsumed: 17, uniqueWines: 30, totalCellars: 1, totalCountries: 6, totalGrapes: 12,
              totalValue: 15420, currency: 'SEK', avgPrice: 367.14, avgRating: 3.9, targetRatingScale: '5',
              oldestVintage: 2005, newestVintage: 2023, bottlesDrunk: 15, bottlesGifted: 2, bottlesSold: 0,
            },
            maturity: { declining: 1, late: 3, peak: 12, early: 9, notReady: 10, noProfile: 7 },
            pace: { avgIntakePerYear: 24, avgOutputPerYear: 18, netPerYear: 6, runway: 2 },
            byType: { red: 25, white: 12, sparkling: 5 },
            byCountry: [{ name: 'France', count: 20 }, { name: 'Italy', count: 9 }],
            cellarBreakdown: [{ id: ID.cellar, name: 'Home', bottleCount: 42, value: 15420 }],
            topProducers: [{ name: 'Château Exemple', count: 4 }],
            urgencyLadder: [{ id: ID.bottle2, cellarId: ID.cellar, name: 'Exemple Blanc', producer: 'Domaine Exemple', vintage: '2016', type: 'white', price: 210, status: 'late' }],
          },
        }),
        ...errors(401, 403),
      },
    },
  },
  '/api/notifications': {
    get: {
      operationId: 'listNotifications',
      tags: ['Notifications'],
      summary: 'Your 30 newest notifications',
      security: scope('read'),
      responses: {
        200: ok('The notifications.', ref('NotificationList'), {
          notifications: [{
            _id: ID.notification, type: 'restock_alert', title: 'Restock Suggestion',
            message: 'You just finished your last bottle similar to Château Exemple. Time to restock?',
            link: '/restock', read: false, createdAt: '2026-10-21T18:00:00.000Z',
          }],
          unreadCount: 1,
        }),
        ...errors(401, 403),
      },
    },
  },
  '/api/notifications/unread-count': {
    get: {
      operationId: 'getUnreadCount',
      tags: ['Notifications'],
      summary: 'The unread count, cheaply',
      description: 'Poll this instead of the list; fetch the list when `newestId` or `unreadCount` changes.',
      security: scope('read'),
      responses: {
        200: ok('The count and the newest id.', ref('UnreadCount'), { unreadCount: 1, newestId: ID.notification }),
        ...errors(401, 403),
      },
    },
  },
  '/api/climate/ingest': {
    post: {
      operationId: 'ingestClimate',
      tags: ['Climate sensors'],
      summary: 'Post sensor readings',
      description: 'For a temperature or humidity sensor in a cellar. Authenticate with the device token shown when you add a climate device in the app (it carries only the `climate` scope). Readings are validated one by one: the valid ones are kept, the others reported in `errors`. Wait `intervalS` seconds between posts.',
      security: scope('climate'),
      requestBody: {
        required: true,
        content: json(ref('ClimateIngestRequest'), { readings: [{ channel: 'fridge', type: 'temperature', value: 12.4 }, { channel: 'fridge', type: 'humidity', value: 68 }], firmware: 'esp32-1.0' }),
      },
      responses: {
        202: ok('Readings received.', ref('ClimateIngestResponse'), { accepted: 2, rejected: 0, intervalS: 300 }),
        ...errors(400, 401, 403, 404, 429),
      },
    },
  },
  '/api/tokens/self': {
    delete: {
      operationId: 'revokeOwnToken',
      tags: ['Tokens'],
      summary: 'Revoke the token making this request',
      description: 'Any personal token may revoke itself, whatever its scopes, for example when an integration is removed. Its event streams close too. A climate device token is retired by deleting the device in the app instead (403).',
      security: [{ apiToken: [] }],
      responses: {
        200: ok('Revoked.', ref('TokenRevoked'), { message: 'Token revoked', id: ID.token, name: 'Home Assistant' }),
        ...errors(401, 403),
      },
    },
  },
  '/api/health': {
    get: {
      operationId: 'getHealth',
      tags: ['Server'],
      summary: 'Is the server up, and which version is it',
      description: 'No token needed. A self-hosted server may run an older version than cellarion.app: read `version`, or treat a 404 or 403 on a documented path as "not supported here" and carry on without it.',
      security: [],
      responses: {
        200: ok('Up.', ref('Health'), { status: 'ok', mongo: 'connected', version: '1.275.0' }),
        503: { description: 'Starting, stopping or without its database.', content: json(ref('Health'), { status: 'draining', mongo: 'connected', version: '1.275.0' }) },
      },
    },
  },
  '/api/uploads/thumbs/{folder}/{file}': {
    get: {
      operationId: 'getThumbnail',
      tags: ['Images'],
      summary: 'A bottle or wine thumbnail',
      description: 'The `image` paths in `GET /api/inventory` point here. No token needed: the file names are random. Fetch only paths of exactly this shape.',
      security: [],
      parameters: [
        { name: 'folder', in: 'path', required: true, schema: { type: 'string', enum: ['processed', 'originals'] } },
        { name: 'file', in: 'path', required: true, schema: { type: 'string', pattern: '^[A-Za-z0-9_-]+\\.(png|jpe?g|webp)\\.webp$' } },
      ],
      responses: {
        200: { description: 'A WebP image.', content: { 'image/webp': { schema: { type: 'string', contentMediaType: 'image/webp' } } } },
        404: { description: 'No such image.', content: json(ref('Error'), { error: 'Not found' }) },
      },
    },
  },
  '/api/openapi.json': {
    get: {
      operationId: 'getOpenApiDocument',
      tags: ['Server'],
      summary: 'This document',
      description: 'The OpenAPI 3.1 description of this server\'s public API, for its own version. No token needed.',
      security: [],
      responses: {
        200: {
          description: 'The OpenAPI document.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['openapi', 'info', 'paths'],
                properties: { openapi: { type: 'string', const: '3.1.0' }, info: { type: 'object' }, paths: { type: 'object' } },
              },
            },
          },
        },
      },
    },
  },
};

const components = {
  securitySchemes: {
    apiToken: {
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'cel_…',
      description: [
        'A personal API token, created under Settings → API tokens. Send it as `Authorization: Bearer cel_…`; never in a URL.',
        '',
        'Each token has scopes; an operation lists the scope it needs:',
        '- `read`: read your cellars, bottles, racks, personal fields, statistics and notifications, and the event stream.',
        '- `consume`: take bottles out of the cellar.',
        '- `climate`: post sensor readings (device tokens, made when you add a climate device).',
        '- `write`: only for AI assistants over MCP; it opens no REST operation.',
        '',
        'A request the token\'s scopes don\'t cover answers 403. A revoked or unknown token answers 401.',
      ].join('\n'),
    },
  },
  parameters: {
    BottleId: { name: 'bottleId', in: 'path', required: true, schema: OBJECT_ID },
    Limit: { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200, default: 30 } },
    Offset: { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0, default: 0 }, description: 'Items to skip. `skip` is accepted as a synonym.' },
    IfNoneMatch: { name: 'If-None-Match', in: 'header', schema: { type: 'string' }, description: 'The `ETag` of the copy you hold, exactly as you received it.' },
  },
  headers: {
    ETag: { description: 'A weak validator for this answer. Send it back as `If-None-Match`.', schema: { type: 'string', pattern: '^W/".+"$' } },
    RateLimitLimit: { description: 'Requests allowed in the current window.', schema: { type: 'integer' } },
    RateLimitRemaining: { description: 'Requests left in the current window.', schema: { type: 'integer' } },
    RateLimitReset: { description: 'Seconds until the window resets.', schema: { type: 'integer' } },
    RateLimitPolicy: { description: 'The limit and the window in seconds, e.g. `60;w=600`.', schema: { type: 'string' } },
    RetryAfter: { description: 'Seconds to wait before retrying.', schema: { type: 'integer' } },
  },
  responses: {
    BadRequest: { description: 'The request is malformed, e.g. an invalid id or value.', content: json(ref('Error'), { error: 'Invalid ID' }) },
    Unauthorized: { description: 'No token, or the token is invalid or revoked. Ask the user for a new one; retrying will not help.', content: json(ref('Error'), { error: 'Invalid token' }) },
    Forbidden: {
      description: 'The token lacks the scope this operation needs, or the caller lacks the role in that cellar. On a self-hosted server it can also mean the server is older than this operation.',
      content: json(ref('Error'), { error: 'API token scope insufficient for this request' }),
    },
    NotFound: { description: 'No such resource visible to the caller, or a server older than this operation.', content: json(ref('Error'), { error: 'Bottle not found' }) },
    Conflict: { description: 'The state moved on, e.g. the bottle already left the cellar (`code: state_changed`) or is still on order.', content: json(ref('Error'), { error: 'This bottle has already left the cellar', code: 'state_changed' }) },
    TooManyRequests: {
      description: 'Rate limited. Wait `Retry-After` seconds.',
      headers: { 'Retry-After': { $ref: '#/components/headers/RetryAfter' }, ...rateLimitHeaders },
      content: json(ref('Error'), { error: 'Too many requests, please try again later' }),
    },
  },
  schemas,
};

const TAGS = [
  { name: 'Inventory', description: 'Everything in your cellars in one cheap, cacheable read. Most integrations need only this.' },
  { name: 'Live updates', description: 'Know when to refetch, without polling.' },
  { name: 'Cellars and bottles', description: 'Cellars, filtered bottle lists, one bottle, racks.' },
  { name: 'Drinking', description: 'Take a bottle out of the cellar.' },
  { name: 'Statistics', description: 'Totals and drink-window counts for dashboards.' },
  { name: 'Notifications', description: 'Restock suggestions, drink-window reminders and other notices.' },
  { name: 'Climate sensors', description: 'Temperature and humidity from a sensor in your cellar.' },
  { name: 'Images', description: 'Thumbnails referenced by other answers.' },
  { name: 'Tokens', description: 'The token itself: who it belongs to, and revoking it.' },
  { name: 'Server', description: 'Health, version and this document.' },
];

/**
 * The document for one server. `version` is the server's own version;
 * `serverUrl` its public address (FRONTEND_URL), so a self-hosted server's
 * document points at itself.
 */
function buildOpenApiDocument({ version, serverUrl = 'https://cellarion.app' } = {}) {
  return {
    openapi: '3.1.0',
    jsonSchemaDialect: 'https://json-schema.org/draft/2020-12/schema',
    info: {
      title: 'Cellarion API',
      version: version || '0.0.0',
      summary: 'Read your cellar, take bottles out, post sensor readings.',
      description: guideMarkdown(serverUrl),
      license: { name: 'AGPL-3.0', identifier: 'AGPL-3.0-only' },
      contact: { name: 'Cellarion', url: 'https://github.com/jagduvi1/Cellarion' },
    },
    servers: [{ url: serverUrl }],
    security: [{ apiToken: [] }],
    tags: TAGS,
    paths: withSamples(serverUrl),
    components,
  };
}

/** The operations with their curl and Python samples for this base URL. */
function withSamples(base) {
  const samples = codeSamples(base);
  const out = {};
  for (const [path, item] of Object.entries(paths)) {
    out[path] = {};
    for (const [method, op] of Object.entries(item)) {
      out[path][method] = { ...op, 'x-codeSamples': samples[op.operationId] || [] };
    }
  }
  return out;
}

module.exports = { buildOpenApiDocument };
