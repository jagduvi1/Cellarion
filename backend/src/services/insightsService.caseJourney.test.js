/**
 * buildCaseJourneys — the parts the bottle page's "This wine in your cellar"
 * card depends on (support ticket 2026-09-16), alongside the MCP case_journey
 * invariants pinned in mcp/insightTools.test.js.
 *
 * Pins: every consumed event carries the bottle it happened to (the card links
 * each row); vintage ordering for a per-wine view; that the DEFAULT ordering
 * and note cap are unchanged, so the MCP envelope is untouched; and that a
 * blank or missing vintage joins the NV lot instead of forming one of its own.
 */
const chain = (result) => {
  const c = {};
  for (const m of ['populate', 'sort', 'skip', 'limit', 'select']) c[m] = jest.fn(() => c);
  c.lean = jest.fn(() => Promise.resolve(result));
  c.then = (res, rej) => Promise.resolve(result).then(res, rej);
  return c;
};

jest.mock('../models/Cellar', () => ({ find: jest.fn(), findById: jest.fn() }));
jest.mock('../models/Bottle', () => ({ find: jest.fn(), findById: jest.fn(), aggregate: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../models/User', () => ({ findById: jest.fn() }));
jest.mock('../models/WishlistItem', () => ({ find: jest.fn(), countDocuments: jest.fn() }));
// Real maturity classification, but no profile collection behind it.
jest.mock('../utils/maturityUtils', () => ({
  ...jest.requireActual('../utils/maturityUtils'),
  buildProfileMap: jest.fn(async () => new Map()),
}));

const Cellar = require('../models/Cellar');
const Bottle = require('../models/Bottle');
const { buildCaseJourneys } = require('./insightsService');

const USER = 'u1';
const CELLAR = 'c1';
const WINE = { _id: 'w1', name: 'Ch. Test', producer: 'Test', type: 'red' };

let nextId = 0;
const active = (vintage) => ({ _id: `a${++nextId}`, cellar: CELLAR, status: 'active', vintage, wineDefinition: WINE });
const drunk = (vintage, over = {}) => ({
  _id: `d${++nextId}`, cellar: CELLAR, status: 'drank', vintage, wineDefinition: WINE,
  consumedAt: new Date('2026-01-10T00:00:00Z'), consumedReason: 'drank',
  consumedRating: 4, consumedRatingScale: '5', consumedNote: 'Good',
  ...over,
});

const run = (bottles, opts) => {
  nextId = 0;
  Cellar.find.mockReturnValue(chain([{ _id: CELLAR }]));
  Bottle.find.mockReturnValue(chain(bottles));
  return buildCaseJourneys(USER, opts);
};

beforeEach(() => jest.clearAllMocks());

describe('buildCaseJourneys for the bottle page', () => {
  test('every consumed event names the bottle it happened to, so a row can link to it', async () => {
    const gone = drunk('2020');
    const { data } = await run([active('2020'), gone], { focusWineId: 'w1', focusVintage: '2020' });

    expect(data).toHaveLength(1);
    expect(data[0].counts).toEqual({ total: 2, remaining: 1, consumed: 1 });
    expect(data[0].consumed_events).toEqual([expect.objectContaining({
      bottle_id: gone._id, reason: 'drank', rating: 4, rating_scale: '5', note: 'Good',
    })]);
  });

  test('only the most recent events are listed, but the count still reports them all', async () => {
    // JOURNEY_MAX_EVENTS caps the list at 20; a caller that shows the rows must
    // be able to see from counts.consumed that there were more.
    const bottles = [active('2020')];
    for (let i = 0; i < 25; i++) bottles.push(drunk('2020', { consumedAt: new Date(`2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`) }));
    const { data } = await run(bottles, { focusWineId: 'w1', focusVintage: '2020' });
    expect(data[0].counts.consumed).toBe(25);
    expect(data[0].consumed_events).toHaveLength(20);
    // The ones kept are the LAST 25 - 20 = the newest.
    expect(new Date(data[0].consumed_events[0].date).getUTCDate()).toBe(6);
  });

  test('sort "vintage" reads newest first with NV last, whatever the bottle counts are', async () => {
    const bottles = [
      active('2019'), active('2019'), active('2019'), // the biggest lot, but the oldest
      active('2021'),
      active('NV'), active('NV'),
      active('2020'),
    ];
    const { data } = await run(bottles, { focusWineId: 'w1', sort: 'vintage', limit: 20 });
    expect(data.map((l) => l.vintage)).toEqual(['2021', '2020', '2019', 'NV']);
  });

  test('the default ordering is still by bottle count — the MCP envelope is unchanged', async () => {
    const bottles = [active('2019'), active('2019'), active('2019'), active('2021')];
    const { data } = await run(bottles, { focusWineId: 'w1', limit: 20 });
    expect(data.map((l) => l.vintage)).toEqual(['2019', '2021']);
  });

  test('a blank or missing vintage joins the NV lot instead of forming one of its own', async () => {
    // Imports leave '' / null where the app writes 'NV'; the sibling query in
    // services/bottleLot already treats the three as one, and so must this.
    const bottles = [active('NV'), active(''), active(null), active(undefined)];
    const { data } = await run(bottles, { focusWineId: 'w1', limit: 20 });
    expect(data).toHaveLength(1);
    expect(data[0].vintage).toBe('NV');
    expect(data[0].counts.total).toBe(4);
  });

  test('focusing a blank vintage is the NV lot, not a missing filter', async () => {
    // case_journey passes the focus bottle's own vintage, and an imported
    // bottle's can be '' — which must not silently widen to every vintage.
    for (const focusVintage of ['', 'NV']) {
      const { data } = await run([active(''), active('2020')], { focusWineId: 'w1', focusVintage });
      expect(data).toHaveLength(1);
      expect(data[0].vintage).toBe('NV');
      expect(data[0].counts.total).toBe(1);
    }
    // Omitted entirely still means every vintage.
    const all = await run([active(''), active('2020')], { focusWineId: 'w1' });
    expect(all.data).toHaveLength(2);
  });

  test('notes are capped at 200 for MCP by default, and the caller can ask for the whole note', async () => {
    const long = 'x'.repeat(600);
    const short = await run([active('2020'), drunk('2020', { consumedNote: long })], { focusWineId: 'w1', focusVintage: '2020' });
    expect(short.data[0].consumed_events[0].note).toHaveLength(200);

    const full = await run([active('2020'), drunk('2020', { consumedNote: long })], { focusWineId: 'w1', focusVintage: '2020', noteMaxLength: 1000 });
    expect(full.data[0].consumed_events[0].note).toHaveLength(600);
  });

  test('a lot of one bottle is returned in focus mode — a pair is the whole point of the card', async () => {
    const { data } = await run([active('2020'), drunk('2020')], { focusWineId: 'w1', focusVintage: '2020' });
    expect(data).toHaveLength(1);
    expect(data[0].counts).toEqual({ total: 2, remaining: 1, consumed: 1 });
  });

  test('a wine the user has no bottles of comes back empty, not as an error', async () => {
    const { data } = await run([], { focusWineId: 'w1', focusVintage: '2020' });
    expect(data).toEqual([]);
  });
});
