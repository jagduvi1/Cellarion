/**
 * Cellar chat — honest scoping of the RAG context (support ticket 2026-08-12
 * "IA bottles known false").
 *
 * The model only ever sees the chatMaxResults most relevant bottles. Without
 * being told the cellar's true size it presents that selection AS the cellar —
 * a user with 71 bottles concluded the AI "has knowledge only on 11". These
 * tests pin the three context shapes: matches (total + selection disclaimer),
 * empty search over a non-empty cellar (explicitly not empty), and a genuinely
 * empty cellar.
 */

const chain = (result) => {
  const c = {};
  for (const m of ['populate', 'sort', 'skip', 'limit', 'select']) c[m] = jest.fn(() => c);
  c.lean = jest.fn(() => Promise.resolve(result));
  c.then = (res, rej) => Promise.resolve(result).then(res, rej);
  return c;
};

jest.mock('../config/aiConfig', () => ({
  get: jest.fn(() => ({
    chatEnabled: true,
    chatSystemPrompt: 'sys',
    chatModel: 'model-x',
    chatModelFallback: null,
    chatMaxTokens: 800,
    chatTopK: 30,
    chatMaxResults: 5,
    chatMaxHistoryTurns: 10,
    vectorIndex: 'v1',
    embeddingModel: 'embed-x',
  })),
}));
jest.mock('./aiProvider', () => ({
  assertConfigured: jest.fn(),
  getChatClient: jest.fn(),
}));
jest.mock('../utils/aiResponse', () => ({
  textFromResponse: jest.fn(() => 'answer'),
  thinkingOff: jest.fn(() => ({})),
}));
jest.mock('./embedding', () => ({
  isEmbeddingConfigured: jest.fn(() => true),
  embedSingle: jest.fn(async () => [0.1, 0.2]),
}));
jest.mock('./vectorStore', () => ({ searchSimilar: jest.fn(async () => []) }));
jest.mock('../models/Bottle', () => ({
  distinct: jest.fn(), countDocuments: jest.fn(), find: jest.fn(), aggregate: jest.fn(async () => []),
}));
// Cellar.find({...}).distinct('_id') — the live-cellar resolution added for
// ticket 6a86268f.
jest.mock('../models/Cellar', () => ({
  find: jest.fn(() => ({ distinct: jest.fn(async () => []) })),
}));
jest.mock('../models/WineVintagePrice', () => ({ aggregate: jest.fn(async () => []) }));
jest.mock('../utils/maturityUtils', () => ({
  buildProfileMap: jest.fn(async () => new Map()),
  classifyMaturity: jest.fn(() => null),
  maturityLabel: jest.fn(() => null),
}));

const mongoose = require('mongoose');
const Bottle = require('../models/Bottle');
const Cellar = require('../models/Cellar');
const vectorStore = require('./vectorStore');
const aiProvider = require('./aiProvider');
const { chat } = require('./aiChat');

const USER = 'a'.repeat(24);
const WD = new mongoose.Types.ObjectId();
const LIVE_CELLAR = new mongoose.Types.ObjectId();

/** What Cellar.find({deletedAt:null,...}).distinct('_id') should return. */
const withLiveCellars = (ids) => Cellar.find.mockReturnValue({ distinct: jest.fn(async () => ids) });

/** Wire the mocked Claude client; returns a getter for the sent user content. */
function wireClient() {
  const create = jest.fn(async () => ({ content: [{ type: 'text', text: 'answer' }] }));
  aiProvider.getChatClient.mockReturnValue({ messages: { create } });
  return () => {
    const params = create.mock.calls[0][0];
    return params.messages[params.messages.length - 1].content;
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  withLiveCellars([LIVE_CELLAR]);   // one live cellar unless a test says otherwise
});

describe('chat context honest scoping', () => {
  test('matches: context states the cellar total and that the list is a selection', async () => {
    const sent = wireClient();
    Bottle.distinct.mockResolvedValue([String(WD)]);
    Bottle.countDocuments.mockResolvedValue(71);
    vectorStore.searchSimilar.mockResolvedValue([
      { score: 0.9, payload: { wineDefinitionId: String(WD), vintage: '2015' } },
    ]);
    Bottle.find.mockReturnValue(chain([{
      _id: new mongoose.Types.ObjectId(),
      vintage: '2015',
      wineDefinition: { _id: WD, name: 'Barolo', producer: 'P', type: 'red', grapes: [], region: null, country: null },
    }]));

    await chat(USER, 'something red tonight?', { useQueryExpansion: false });
    const content = sent();
    expect(content).toMatch(/holds 71 active bottle\(s\)/);
    expect(content).toMatch(/only the most relevant to this question — NOT the whole cellar/);
    expect(content).toMatch(/Available wines from the user's cellar/);
  });

  test('empty search over a non-empty cellar: context says the cellar is NOT empty', async () => {
    const sent = wireClient();
    Bottle.distinct.mockResolvedValue([String(WD)]);
    Bottle.countDocuments.mockResolvedValue(71);
    vectorStore.searchSimilar.mockResolvedValue([]);

    await chat(USER, 'wines from the moon?', { useQueryExpansion: false });
    const content = sent();
    expect(content).toMatch(/holds 71 active bottle\(s\)/);
    expect(content).toMatch(/the cellar is not empty/);
  });

  test('genuinely empty cellar: context says so without inventing a total', async () => {
    const sent = wireClient();
    Bottle.distinct.mockResolvedValue([]);
    Bottle.countDocuments.mockResolvedValue(0);

    await chat(USER, 'what do I own?', { useQueryExpansion: false });
    expect(sent()).toMatch(/no active bottles in their cellar/);
    expect(vectorStore.searchSimilar).not.toHaveBeenCalled();
  });
});

/**
 * Deleting a cellar is a SOFT delete: the bottles keep deletedAt: null so a
 * restore can bring them back. Scoping by `user` alone therefore counts wine
 * the user believes they threw away — support ticket 6a86268f (2026-08-20),
 * where a 71-bottle cellar was reported as 779 because four deleted cellars
 * still held 708. The same user had raised it on 2026-08-12; the fix then made
 * the total prominent, which only published the wrong number more loudly.
 */
describe('deleted cellars are not the cellar', () => {
  test('every bottle query is scoped to LIVE cellars', async () => {
    wireClient();
    Bottle.distinct.mockResolvedValue([String(WD)]);
    Bottle.countDocuments.mockResolvedValue(71);
    vectorStore.searchSimilar.mockResolvedValue([
      { score: 0.9, payload: { wineDefinitionId: String(WD), vintage: '2015' } },
    ]);
    Bottle.find.mockReturnValue(chain([{
      _id: new mongoose.Types.ObjectId(), vintage: '2015',
      wineDefinition: { _id: WD, name: 'Barolo', producer: 'P', type: 'red', grapes: [], region: null, country: null },
    }]));

    await chat(USER, 'something red?', { useQueryExpansion: false });

    // Only live cellars are ever asked for.
    expect(Cellar.find).toHaveBeenCalledWith(expect.objectContaining({ deletedAt: null }));
    // The wine pre-filter, the total, and the wine list all carry the same
    // cellar constraint — if they ever diverge the model is told two different
    // cellars in one prompt.
    expect(Bottle.distinct.mock.calls[0][1]).toMatchObject({ cellar: { $in: [LIVE_CELLAR] } });
    expect(Bottle.countDocuments.mock.calls[0][0]).toMatchObject({ cellar: { $in: [LIVE_CELLAR] } });
    expect(Bottle.find.mock.calls[0][0]).toMatchObject({ cellar: { $in: [LIVE_CELLAR] } });
  });

  test('per-wine bottle counts are scoped too, so "you have N" cannot overstate', async () => {
    wireClient();
    Bottle.distinct.mockResolvedValue([String(WD)]);
    Bottle.countDocuments.mockResolvedValue(71);
    vectorStore.searchSimilar.mockResolvedValue([
      { score: 0.9, payload: { wineDefinitionId: String(WD), vintage: '2015' } },
    ]);
    Bottle.find.mockReturnValue(chain([{
      _id: new mongoose.Types.ObjectId(), vintage: '2015',
      wineDefinition: { _id: WD, name: 'Barolo', producer: 'P', type: 'red', grapes: [], region: null, country: null },
    }]));

    await chat(USER, 'how many Barolo?', { useQueryExpansion: false });

    const countStage = Bottle.aggregate.mock.calls[0][0][0].$match;
    expect(countStage).toMatchObject({ cellar: { $in: [LIVE_CELLAR] } });
  });

  test('a user whose only cellars are deleted matches NOTHING, not everything', async () => {
    // The empty-array trap: `if (cellarIds?.length)` would skip the filter and
    // silently widen the scope back to every bottle the user has ever owned.
    // One prod user is in exactly this state — 0 live bottles, 132 stranded.
    withLiveCellars([]);
    const sent = wireClient();
    Bottle.distinct.mockResolvedValue([]);
    Bottle.countDocuments.mockResolvedValue(0);

    await chat(USER, 'what do I own?', { useQueryExpansion: false });

    expect(Bottle.distinct.mock.calls[0][1]).toMatchObject({ cellar: { $in: [] } });
    expect(sent()).toMatch(/no active bottles in their cellar/);
  });
});
