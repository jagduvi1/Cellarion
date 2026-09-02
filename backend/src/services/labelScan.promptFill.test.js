/**
 * Every prompt builder inserts user text LITERALLY, and no assembled prompt
 * goes out oversized.
 *
 * Security audit 2026-09-02 (D10-9): suggestProfile and scanLabelBack had been
 * fixed in August, but identifyWineFromText, identifyWineFromQuery,
 * suggestDrinkWindow and suggestPrice still built their prompts with
 * String.prototype.replace(token, userString). A replacement STRING honours
 * `$'` (everything after the match), so a 150 × `$'` query re-inserted the
 * template 150 times — ~100k tokens for one call, billed to the operator's
 * key and invisible to the per-call AI budget. These tests drive the real
 * exported builders through a captured client and assert on what would have
 * been sent.
 */
jest.mock('./aiProvider', () => ({ getChatClient: jest.fn() }));
jest.mock('../config/aiConfig', () => ({
  get: jest.fn(),
  DEFAULT_TEXT_SEARCH_PROMPT: ['Identify this wine.', 'Query: {{query}}', 'Rules: be terse. Never invent awards.'].join('\n'),
}));

const aiProvider = require('./aiProvider');
const aiConfig = require('../config/aiConfig');
const { identifyWineFromText, identifyWineFromQuery, suggestDrinkWindow, suggestPrice } = require('./labelScan');

const TAIL = 'Rules: be terse. Never invent awards.';
const IMPORT_TPL = ['Identify.', 'Wine: {{name}}', 'Producer: {{producer}}', '{{vintage}}{{country}}', TAIL].join('\n');
const MATURITY_TPL = ['Window for {{name}} by {{producer}} {{vintage}} ({{grapes}}) tier {{qualityTier}}', TAIL].join('\n');
const PRICE_TPL = ['Price for {{name}} by {{producer}} {{vintage}} {{classification}} ({{grapes}}) tier {{qualityTier}}', TAIL].join('\n');

let create;
beforeEach(() => {
  create = jest.fn().mockResolvedValue({ content: [{ type: 'text', text: '{}' }] });
  aiProvider.getChatClient.mockReturnValue({ messages: { create } });
  aiConfig.get.mockReturnValue({
    importLookupPrompt: IMPORT_TPL, importLookupModel: 'test-model',
    maturitySuggestPrompt: MATURITY_TPL, maturitySuggestPromptNv: MATURITY_TPL, maturitySuggestModel: 'test-model',
    priceSuggestPrompt: PRICE_TPL, priceSuggestModel: 'test-model',
  });
});

const sentPrompt = () => create.mock.calls[0][0].messages[0].content;
const tails = (s) => (s.match(/Rules: be terse/g) || []).length;

describe('prompt builders insert user text literally (audit 2026-09-02 D10-9)', () => {
  test("identifyWineFromQuery: 150 × $' stays 300 characters, the template tail appears once", async () => {
    const payload = "$'".repeat(150);
    await identifyWineFromQuery(payload);
    const prompt = sentPrompt();
    expect(prompt).toContain(`Query: ${payload}`);
    expect(tails(prompt)).toBe(1);
    expect(prompt.length).toBeLessThan(aiConfig.DEFAULT_TEXT_SEARCH_PROMPT.length + payload.length + 5);
  });

  test('identifyWineFromText: name/producer from the import file are sanitised and literal', async () => {
    await identifyWineFromText({ name: "$'", producer: 'Château\nEvil $& $$', vintage: '2019', country: "$'" });
    const prompt = sentPrompt();
    expect(prompt).toContain("Wine: $'");
    expect(prompt).toContain('Producer: Château Evil $& $$'); // newline collapsed, patterns inert
    expect(prompt).toContain("Country hint: $'");
    expect(tails(prompt)).toBe(1);
  });

  test('identifyWineFromText caps each field at 200 characters', async () => {
    await identifyWineFromText({ name: 'N'.repeat(500), producer: 'P' });
    expect(sentPrompt()).toContain(`Wine: ${'N'.repeat(200)}\n`);
    expect(sentPrompt()).not.toContain('N'.repeat(201));
  });

  test('suggestDrinkWindow: registry text and grapes are literal, grapes capped per name', async () => {
    await suggestDrinkWindow({ name: "$'", producer: '$`', vintage: '2019', grapes: ["$'", 'Syrah', 'Grenache'] });
    const prompt = sentPrompt();
    expect(prompt).toContain("Window for $' by $` 2019 ($', Syrah, Grenache)");
    expect(tails(prompt)).toBe(1);
  });

  test('suggestPrice: same rule', async () => {
    await suggestPrice({ name: "$'$'", producer: 'P', vintage: '2019', classification: '$&', grapes: 'Syrah' });
    const prompt = sentPrompt();
    expect(prompt).toContain("Price for $'$' by P 2019 $& (Syrah)");
    expect(tails(prompt)).toBe(1);
  });
});

describe('oversized prompts are refused before any request is made', () => {
  test('a template that assembles past the cap returns prompt_too_long and never calls the model', async () => {
    aiConfig.get.mockReturnValue({ importLookupPrompt: `${'x'.repeat(25 * 1024)}\nWine: {{name}}`, importLookupModel: 'test-model' });
    const res = await identifyWineFromText({ name: 'A', producer: 'B' });
    expect(res).toEqual({ data: null, debugRaw: null, debugReason: 'prompt_too_long' });
    expect(create).not.toHaveBeenCalled();
  });

  test('a normal prompt is well under the cap and goes out', async () => {
    await identifyWineFromText({ name: 'A', producer: 'B' });
    expect(create).toHaveBeenCalledTimes(1);
  });
});
