/**
 * The profile call and the optional language for the AI-written wine texts.
 *
 * WHY THIS TEST EXISTS:
 * The setting is off by default, and off it must change nothing: the request
 * suggestProfile sends — client options, model, max_tokens, messages, tools —
 * is byte-for-byte the request it sent before the setting existed. The
 * snapshot beside this file was recorded from the builder as it was before
 * the setting, for every shape the prompt takes (plain, no place, curator
 * facts, corrective retry, web search); every way of being off must still
 * match it. On, the same call asks for one more key: the description,
 * flavours and pairings translated, while every other key stays English.
 */

jest.mock('./aiProvider', () => ({
  getChatClient: jest.fn(),
  providerName: jest.fn(() => 'anthropic'),
  effectiveModels: jest.fn(() => null),
}));
jest.mock('../config/aiConfig', () => ({ get: jest.fn() }));

const aiProvider = require('./aiProvider');
const aiConfig = require('../config/aiConfig');
const { DEFAULT_ENRICHMENT_PROMPT } = jest.requireActual('../config/aiConfig');
const { suggestProfile } = require('./labelScan');

const MODEL_ANSWER = '{"body":"full","tannin":"high","acidity":"high","sweetness":"dry","flavors":["tar","rose"],"foodPairings":["braised beef"],"description":"Firm and fragrant.","confidence":0.8}';

let create;
beforeEach(() => {
  jest.clearAllMocks();
  create = jest.fn().mockResolvedValue({ content: [{ type: 'text', text: MODEL_ANSWER }] });
  aiProvider.getChatClient.mockReturnValue({ messages: { create } });
  aiConfig.get.mockReturnValue({ enrichmentPrompt: DEFAULT_ENRICHMENT_PROMPT, enrichmentModel: 'claude-sonnet-5' });
});

const BAROLO = {
  name: 'Cannubi Boschis', producer: 'Luciano Sandrone', vintage: 'NV',
  country: 'Italy', region: 'Piedmont', appellation: 'Barolo', classification: '',
  type: 'red', grapes: ['Nebbiolo'],
};
const PLACELESS = { name: 'Old Vine Red', producer: 'Small Estate', vintage: 'NV', country: 'Australia', type: 'red', grapes: [] };

const CASES = {
  plain: BAROLO,
  placeless: PLACELESS,
  curatorFacts: { ...BAROLO, curatorContext: 'Single-vineyard Barolo from the Cannubi hill.' },
  retry: { ...PLACELESS, retryDirective: 'Your previous draft stated the following as facts about this wine: Barossa Valley.' },
  search: { ...BAROLO, allowSearch: true },
  everything: { ...PLACELESS, curatorContext: 'A co-operative bottling.', retryDirective: 'Rewrite without the region.', allowSearch: true },
};

// The one request each call made: what the client was built with, and what it sent.
async function requestFor(input) {
  aiProvider.getChatClient.mockClear();
  create.mockClear();
  await suggestProfile(input);
  expect(create).toHaveBeenCalledTimes(1);
  return { client: aiProvider.getChatClient.mock.calls[0][0], params: create.mock.calls[0][0] };
}

// Every way the language can be "off": never passed, empty, English, a code
// the app does not ship, free text an admin might have typed.
const OFF = [undefined, '', 'en', 'EN', 'xx', 'Return all information in German'];

describe('with no language, the profile call is the call it always was', () => {
  for (const [name, input] of Object.entries(CASES)) {
    test(`${name}: byte-identical to the recorded request, whichever way the language is off`, async () => {
      const recorded = await requestFor(input);
      expect(recorded).toMatchSnapshot();
      // The snapshot sorts keys; the request body is sent in this order.
      expect(Object.keys(recorded.params)).toEqual(input.allowSearch
        ? ['model', 'max_tokens', 'thinking', 'tools', 'messages']
        : ['model', 'max_tokens', 'thinking', 'messages']);
      for (const language of OFF) {
        const req = await requestFor(language === undefined ? input : { ...input, language });
        expect(JSON.stringify(req)).toBe(JSON.stringify(recorded));
      }
    });
  }

  test('a setting stored in the AI config does not reach the prompt by itself: only the caller asks for a language', async () => {
    const plain = await requestFor(BAROLO);
    aiConfig.get.mockReturnValue({ enrichmentPrompt: DEFAULT_ENRICHMENT_PROMPT, enrichmentModel: 'claude-sonnet-5', aiTextLanguage: 'de' });
    const withSetting = await requestFor(BAROLO);
    expect(JSON.stringify(withSetting)).toBe(JSON.stringify(plain));
  });
});

describe('with a language, the same call also asks for the prose translated', () => {
  test('German: the English request comes first, unchanged, and one paragraph asks for the "localized" key', async () => {
    const english = await requestFor(BAROLO);
    const german = await requestFor({ ...BAROLO, language: 'de' });
    const before = english.params.messages[0].content;
    const after = german.params.messages[0].content;
    expect(after.startsWith(before)).toBe(true);
    const added = after.slice(before.length);
    expect(added).toMatch(/^\n\nAlso add one more key to the JSON object, "localized"/);
    expect(added).toContain('translated into German');
    expect(added).toContain('{"localized":{"description":"the description in German","flavors":["each flavour in German"],"foodPairings":["each pairing in German"]}}');
    expect(added).toContain('Every other key — description, flavors and foodPairings included — stays exactly as specified above, in English.');
    // The canonical JSON shape the registry reads is still asked for, as it was.
    expect(after).toContain('"description":"2-3 sentence plain-language tasting note for the owner"');
  });

  test('the answer gets 600 more output tokens, and nothing else about the call changes', async () => {
    const english = await requestFor(BAROLO);
    const german = await requestFor({ ...BAROLO, language: 'de' });
    expect(english.params.max_tokens).toBe(1400);
    expect(german.params.max_tokens).toBe(2000);
    expect(german.client).toEqual(english.client);
    const { messages: m1, max_tokens: t1, ...rest1 } = english.params;
    const { messages: m2, max_tokens: t2, ...rest2 } = german.params;
    expect(rest2).toEqual(rest1);
    expect(m2).toHaveLength(1);
    expect(m2[0].role).toBe('user');
  });

  test('with web search the language paragraph comes before the search one, so "exactly as specified above" covers it', async () => {
    const req = await requestFor({ ...BAROLO, allowSearch: true, language: 'fr' });
    const prompt = req.params.messages[0].content;
    expect(req.params.max_tokens).toBe(3000);
    expect(req.params.tools).toEqual([{ type: 'web_search_20250305', name: 'web_search', max_uses: 2 }]);
    expect(prompt.indexOf('translated into French')).toBeGreaterThan(0);
    expect(prompt.indexOf('You may use web_search')).toBeGreaterThan(prompt.indexOf('translated into French'));
  });

  test('each shipped language is asked for by its English name', async () => {
    const names = { de: 'German', et: 'Estonian', fr: 'French', nb: 'Norwegian Bokmål', nl: 'Dutch', sv: 'Swedish' };
    for (const [code, name] of Object.entries(names)) {
      const req = await requestFor({ ...BAROLO, language: code });
      expect(req.params.messages[0].content).toContain(`translated into ${name}:`);
    }
  });

  test('the model\'s extra block passes through to the caller untouched (enrichmentJob validates it)', async () => {
    const localized = { description: 'Fest und duftig.', flavors: ['Teer', 'Rose'], foodPairings: ['Schmorbraten'] };
    create.mockResolvedValue({ content: [{ type: 'text', text: JSON.stringify({ ...JSON.parse(MODEL_ANSWER), localized }) }] });
    const res = await suggestProfile({ ...BAROLO, language: 'de' });
    expect(res.data.description).toBe('Firm and fragrant.');
    expect(res.data.localized).toEqual(localized);
  });
});
