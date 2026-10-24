/**
 * Start-up order of server.js for the runtime settings (rate limits, AI
 * settings, the announcement banner, feature flags).
 *
 * WHY THIS TEST EXISTS:
 * Those settings live in SiteConfig. They must be read once the database is
 * connected and be in memory before anything uses them: the boot migrations,
 * the scheduler and the first request. Read any earlier and a database that
 * is slow to accept connections leaves the server on code defaults until the
 * next restart, and an admin save in that state writes the defaults back over
 * the stored settings. A config that cannot be read must not stop the start.
 *
 * server.js is required with every dependency mocked; each mock records when
 * it runs, so the test reads the real order of the boot.
 */

const fs = require('fs');
const path = require('path');

const mockOrder = [];
const mockLoadFailures = {};
let mockListening;

function mockConfig(name) {
  return {
    load: jest.fn(async () => {
      mockOrder.push(`${name}.load`);
      if (mockLoadFailures[name]) throw mockLoadFailures[name];
      // Settles a turn later, like a database read.
      await new Promise((resolve) => setImmediate(resolve));
      mockOrder.push(`${name}.loaded`);
    }),
  };
}

jest.mock('dotenv', () => ({ config: jest.fn() }));
jest.mock('mongoose', () => ({
  connection: {
    collection: jest.fn(() => {
      mockOrder.push('migration');
      return {
        indexes: async () => [],
        dropIndex: async () => {},
        updateMany: async () => ({ modifiedCount: 0 }),
      };
    }),
  },
  disconnect: jest.fn(),
}));
jest.mock('../app', () => ({
  listen: jest.fn((port, cb) => {
    mockOrder.push('listen');
    if (cb) cb();
    mockListening();
    return {};
  }),
}));
jest.mock('./db', () => jest.fn(async () => { mockOrder.push('db.connected'); }));
jest.mock('./rateLimits', () => mockConfig('rateLimits'));
jest.mock('./aiConfig', () => mockConfig('aiConfig'));
jest.mock('./announcement', () => mockConfig('announcement'));
jest.mock('./featureFlags', () => mockConfig('featureFlags'));
jest.mock('../services/search', () => ({ initialize: jest.fn(async () => { mockOrder.push('search'); }) }));
jest.mock('../services/eventBus', () => ({ closeAll: jest.fn() }));
jest.mock('../mcp/sessions', () => ({ closeAllSessions: jest.fn() }));
jest.mock('../services/scheduler', () => ({
  startScheduler: jest.fn(() => { mockOrder.push('scheduler'); }),
  stopScheduler: jest.fn(),
}));
jest.mock('../services/imageProcessor', () => ({
  cleanupOrphanedImages: jest.fn(async () => {}),
  whenProcessingIdle: jest.fn(),
}));
jest.mock('../services/shutdown', () => ({ createShutdown: jest.fn(() => () => {}) }));
jest.mock('../services/imageVintageBackfill', () => ({
  backfillImageVintages: jest.fn(async () => { mockOrder.push('migration'); return 0; }),
}));
jest.mock('../services/ownerInquiryEmail', () => ({ storeOptedOutOwnerQuestions: jest.fn(async () => 0) }));
jest.mock('../services/drinkWindowNotifier', () => ({ storeDrinkWindowDefaultsOff: jest.fn(async () => 0) }));
jest.mock('../models/SiteConfig', () => ({ exists: jest.fn(async () => true), updateOne: jest.fn() }));
jest.mock('../scripts/rekey-star-grade-wines', () => ({ run: jest.fn() }));
jest.mock('../models/DiscussionReply', () => ({ purgeExpiredDeletes: jest.fn(async () => {}) }));

const CONFIG_NAMES = ['rateLimits', 'aiConfig', 'announcement', 'featureFlags'];

let warn;
beforeEach(() => {
  mockOrder.length = 0;
  for (const name of CONFIG_NAMES) delete mockLoadFailures[name];
  process.env.JWT_SECRET = 'boot-order-test-secret-0123456789abcdef';
  process.env.MEILI_MASTER_KEY = 'boot-order-test-meili-key';
  process.env.MAILGUN_API_KEY = 'key';
  process.env.MAILGUN_DOMAIN = 'example.test';
  jest.spyOn(console, 'log').mockImplementation(() => {});
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);
  jest.spyOn(global, 'setInterval').mockImplementation(() => 0);
});
afterEach(() => jest.restoreAllMocks());

// Requires server.js afresh and waits until it calls app.listen.
async function boot() {
  const listening = new Promise((resolve) => { mockListening = resolve; });
  // server.js installs process-wide signal handlers; keep them off the test runner.
  const on = jest.spyOn(process, 'on').mockImplementation(() => process);
  jest.isolateModules(() => { require('../../server'); });
  on.mockRestore();
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`server never listened; boot order: ${mockOrder.join(' > ')}`)), 2000);
  });
  try {
    await Promise.race([listening, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

describe('server.js start-up', () => {
  test('reads every runtime config after the database connects and before migrations, search, scheduler and listen', async () => {
    await boot();
    const at = (step) => mockOrder.indexOf(step);
    const firstUser = Math.min(at('migration'), at('search'), at('scheduler'), at('listen'));
    expect(at('db.connected')).toBeGreaterThanOrEqual(0);
    expect(firstUser).toBeGreaterThan(0);
    for (const name of CONFIG_NAMES) {
      expect(mockOrder.filter((s) => s === `${name}.load`)).toHaveLength(1);
      expect(at(`${name}.load`)).toBeGreaterThan(at('db.connected'));
      expect(at(`${name}.loaded`)).toBeGreaterThan(at(`${name}.load`));
      expect(at(`${name}.loaded`)).toBeLessThan(firstUser);
    }
  });

  test('a config that cannot be read keeps its defaults and the server still starts', async () => {
    mockLoadFailures.aiConfig = new Error('read failed');
    await boot();
    expect(mockOrder).toContain('listen');
    for (const name of CONFIG_NAMES.filter((n) => n !== 'aiConfig')) expect(mockOrder).toContain(`${name}.loaded`);
    expect(warn).toHaveBeenCalledWith('[aiConfig] Startup load failed, using defaults:', 'read failed');
  });
});

describe('nothing reads the runtime settings while modules are being required', () => {
  const linesMatching = (rel, re) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8')
    .split('\n').filter((line) => re.test(line)).map((line) => line.trim());

  test('app.js does not load any config (server.js does, once the database is up)', () => {
    expect(linesMatching('app.js', /\.load\(\)/)).toEqual([]);
  });

  test('the public wine-page limiter takes its fixed window from the code defaults', () => {
    const windows = linesMatching(path.join('routes', 'wines.js'), /windowMs:\s*rateLimitsConfig\./);
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatch(/^windowMs:\s*rateLimitsConfig\.defaults\.publicWineRead\.windowMs\b/);
  });
});
