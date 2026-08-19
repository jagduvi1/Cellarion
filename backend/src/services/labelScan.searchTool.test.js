/**
 * The web-search rescue's labelScan half (pilot 2026-08-19).
 *
 * suggestProfile with allowSearch must hand the Anthropic SERVER-SIDE
 * web_search tool to the API, capped at 2 uses — and WITHOUT allowSearch the
 * request must carry no tools key at all, because the un-searched path is
 * every ordinary enrichment and a stray tools param would change its cost
 * model. The third test pins the parsing seam: a searched response arrives
 * with tool blocks BEFORE the text block, and textFromResponse must make
 * that invisible to the JSON extraction.
 */

jest.mock('./aiProvider', () => ({
  getChatClient: jest.fn(),
  effectiveModels: jest.fn(() => null),
}));
jest.mock('../config/aiConfig', () => ({ get: jest.fn(() => ({
  enrichmentPrompt: 'Wine: {{name}} / Producer: {{producer}} / Grapes: {{grapes}}\nReturn JSON.',
  enrichmentModel: 'claude-sonnet-5',
})) }));

const aiProvider = require('./aiProvider');
const { suggestProfile } = require('./labelScan');

const PROFILE_JSON = '{"body":"medium","description":"Fine.","confidence":0.8,"flavors":[],"foodPairings":[]}';

const clientReturning = (text) => {
  const create = jest.fn().mockResolvedValue({ content: [{ type: 'text', text }] });
  aiProvider.getChatClient.mockReturnValue({ messages: { create } });
  return create;
};

beforeEach(() => jest.clearAllMocks());

describe('suggestProfile allowSearch → the web_search tool', () => {
  test('allowSearch:true sends the tool (max 2 uses), headroom tokens, and the search instruction', async () => {
    const create = clientReturning(PROFILE_JSON);
    const res = await suggestProfile({ name: 'Mystery', producer: 'Small Estate', allowSearch: true });
    expect(res.data).toMatchObject({ confidence: 0.8 });
    const params = create.mock.calls[0][0];
    expect(params.tools).toEqual([{ type: 'web_search_20250305', name: 'web_search', max_uses: 2 }]);
    expect(params.max_tokens).toBe(2400);
    expect(params.messages[0].content).toMatch(/You may use web_search \(at most 2 searches\)/);
    // The output contract survives the addendum — searched or not, bare JSON.
    expect(params.messages[0].content).toMatch(/return ONLY the raw JSON object/);
  });

  test('without allowSearch the request carries NO tools key — the ordinary path is unchanged', async () => {
    const create = clientReturning(PROFILE_JSON);
    await suggestProfile({ name: 'Mystery', producer: 'Small Estate' });
    const params = create.mock.calls[0][0];
    expect('tools' in params).toBe(false);
    expect(params.max_tokens).toBe(1400);
    expect(params.messages[0].content).not.toMatch(/web_search/);
  });

  test('a searched response with tool blocks before the text still parses', async () => {
    const create = jest.fn().mockResolvedValue({ content: [
      { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'Small Estate winery' } },
      { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [] },
      { type: 'text', text: PROFILE_JSON },
    ] });
    aiProvider.getChatClient.mockReturnValue({ messages: { create } });
    const res = await suggestProfile({ name: 'Mystery', producer: 'Small Estate', allowSearch: true });
    expect(res.data).toMatchObject({ body: 'medium', confidence: 0.8 });
    expect(res.debugReason).toBeNull();
  });
});
