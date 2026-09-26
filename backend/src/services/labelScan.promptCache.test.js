/**
 * Prompt caching for the label scan and the import lookup (2026-09-25).
 *
 * On the Anthropic provider the fixed instructions always ride as the system
 * block; the caching switch only adds or drops Anthropic's cache marker. What
 * must hold:
 *   - the switch is a pure cost switch — on or off, the model reads exactly the
 *     same request apart from the marker;
 *   - the words are the old prompt's words, moved (plus the one-line import
 *     reminder);
 *   - an OpenAI-compatible provider keeps the original single-message layout;
 *   - every call carries its feature label for the spend ledger.
 */
jest.mock('./aiProvider', () => ({
  getChatClient: jest.fn(),
  providerName: jest.fn(() => 'anthropic'),
}));
jest.mock('../config/aiConfig', () => ({ get: jest.fn() }));

const aiProvider = require('./aiProvider');
const aiConfig = require('../config/aiConfig');
const { DEFAULT_LABEL_SCAN_PROMPT, DEFAULT_IMPORT_LOOKUP_PROMPT } = jest.requireActual('../config/aiConfig');
const { scanLabelFull, identifyWineFromText, identifyWineFromQuery } = require('./labelScan');

let create;
const IDENTITY = '{"name":"Pingus","producer":"Dominio de Pingus","country":"Spain","grapes":["Tempranillo"],"confidence":0.9}';
const IMAGE = { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } };

function config(overrides = {}) {
  aiConfig.get.mockReturnValue({
    labelScanModel: 'claude-sonnet-5',
    labelScanPrompt: DEFAULT_LABEL_SCAN_PROMPT,
    importLookupModel: 'claude-sonnet-5',
    importLookupPrompt: DEFAULT_IMPORT_LOOKUP_PROMPT,
    ...overrides,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  create = jest.fn().mockResolvedValue({ content: [{ type: 'text', text: IDENTITY }] });
  aiProvider.getChatClient.mockReturnValue({ messages: { create } });
  aiProvider.providerName.mockReturnValue('anthropic');
  config();
});

const sent = () => create.mock.calls[create.mock.calls.length - 1][0];
const squash = (s) => s.replace(/\s+/g, ' ').trim();
const withoutMarker = (params) => ({ ...params, system: params.system.map(({ cache_control: _marker, ...block }) => block) });

describe('label scan', () => {
  test('instructions as a 1-hour cache-marked system block; the photo plus a one-line request as the message', async () => {
    await scanLabelFull('AAAA', 'image/jpeg');
    const params = sent();
    expect(params.system).toEqual([
      { type: 'text', text: DEFAULT_LABEL_SCAN_PROMPT, cache_control: { type: 'ephemeral', ttl: '1h' } },
    ]);
    expect(params.messages).toEqual([{
      role: 'user',
      content: [IMAGE, { type: 'text', text: 'Identify the wine in this photo, following your instructions exactly.' }],
    }]);
    expect(params.model).toBe('claude-sonnet-5');
    expect(params.max_tokens).toBe(600);
  });

  test('switch off: the same request, only without the cache marker', async () => {
    await scanLabelFull('AAAA', 'image/jpeg');
    const on = sent();
    config({ promptCaching: false });
    await scanLabelFull('AAAA', 'image/jpeg');
    const off = sent();
    expect(off.system[0]).not.toHaveProperty('cache_control');
    expect(off).toEqual(withoutMarker(on));
  });

  test('an OpenAI-compatible provider keeps the original layout: the photo, then the instructions', async () => {
    aiProvider.providerName.mockReturnValue('openai');
    await scanLabelFull('AAAA', 'image/jpeg');
    expect(sent()).not.toHaveProperty('system');
    expect(sent().messages[0].content).toEqual([IMAGE, { type: 'text', text: DEFAULT_LABEL_SCAN_PROMPT }]);
  });

  test('a short custom prompt keeps the same layout — below the model\'s cache minimum the marker is simply ignored', async () => {
    config({ labelScanPrompt: 'Read the label. Return JSON.' });
    await scanLabelFull('AAAA', 'image/jpeg');
    expect(sent().system).toEqual([
      { type: 'text', text: 'Read the label. Return JSON.', cache_control: { type: 'ephemeral', ttl: '1h' } },
    ]);
  });

  test('the scan is labelled for the spend ledger', async () => {
    await scanLabelFull('AAAA', 'image/jpeg');
    expect(aiProvider.getChatClient).toHaveBeenCalledWith({ maxRetries: 4, feature: 'label_scan' });
  });
});

describe('import lookup', () => {
  const row = { name: 'Pingus', producer: 'Dominio de Pingus', vintage: '2015', country: 'Spain' };
  const REMINDER = 'only where you actually know them for THIS wine';

  test('the rules after the last placeholder line are the 5-minute system block; the row is the message', async () => {
    const res = await identifyWineFromText(row);
    expect(res.data).toMatchObject({ name: 'Pingus', producer: 'Dominio de Pingus' });

    const params = sent();
    expect(params.system).toHaveLength(1);
    expect(params.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(params.system[0].text.startsWith('Return ONLY a raw JSON object')).toBe(true);
    expect(params.system[0].text).toContain('Rules:');

    const message = params.messages[0].content;
    expect(typeof message).toBe('string');
    expect(message.startsWith('You are a master sommelier')).toBe(true);
    expect(message).toContain('Wine: Pingus');
    expect(message).toContain('Producer: Dominio de Pingus');
    expect(message).toContain('Vintage: 2015');
    expect(message).toContain('Country hint: Spain');
    expect(message).not.toContain('Rules:');
  });

  test('the row is closed by the reminder that keeps "only what you know" last — with the switch on or off', async () => {
    for (const promptCaching of [true, false]) {
      config({ promptCaching });
      await identifyWineFromText(row);
      const message = sent().messages[0].content;
      const lastParagraph = message.slice(message.lastIndexOf('\n\n') + 2);
      expect(lastParagraph).toMatch(/^Return the JSON object exactly as your instructions specify\./);
      expect(lastParagraph).toContain(REMINDER);
    }
  });

  test('switch off: the same request, only without the cache marker', async () => {
    await identifyWineFromText(row);
    const on = sent();
    config({ promptCaching: false });
    await identifyWineFromText(row);
    expect(sent()).toEqual(withoutMarker(on));
  });

  test('the words are the single-message prompt\'s words: system + message (less the reminder) reproduce it', async () => {
    await identifyWineFromText(row);
    const split = sent();
    aiProvider.providerName.mockReturnValue('openai');
    await identifyWineFromText(row);
    const original = sent();

    expect(original).not.toHaveProperty('system');
    expect(original.messages[0].content).not.toContain(REMINDER);
    const message = split.messages[0].content;
    const withoutReminder = message.slice(0, message.lastIndexOf('\n\n'));
    expect(squash(`${withoutReminder}\n${split.system[0].text}`)).toBe(squash(original.messages[0].content));
  });

  test('a template whose values sit at the very end has no fixed tail and keeps the single-message layout', async () => {
    const template = `${'Rules. '.repeat(700)}\nWine: {{name}}\nProducer: {{producer}}\n{{vintage}}{{country}}`;
    config({ importLookupPrompt: template });
    await identifyWineFromText(row);
    expect(sent()).not.toHaveProperty('system');
    expect(sent().messages[0].content).toContain('Wine: Pingus');
  });

  test('the size backstop counts the system block — an oversized template is refused before any call', async () => {
    config({ importLookupPrompt: `Wine: {{name}}\nProducer: {{producer}}\n{{vintage}}{{country}}\n${'x'.repeat(25 * 1024)}` });
    const res = await identifyWineFromText(row);
    expect(create).not.toHaveBeenCalled();
    expect(res.debugReason).toBe('prompt_too_long');
  });

  test('labelled for the spend ledger; the text lookup carries its own label', async () => {
    await identifyWineFromText(row);
    expect(aiProvider.getChatClient).toHaveBeenLastCalledWith({ maxRetries: 4, feature: 'import_identify' });
    await identifyWineFromQuery('Pingus 2015');
    expect(aiProvider.getChatClient).toHaveBeenLastCalledWith({ maxRetries: 4, feature: 'text_lookup' });
  });
});
