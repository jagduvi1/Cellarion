/**
 * Prompt caching for the label scan and the import lookup (2026-09-25).
 *
 * The instructions ride as a cached system block so repeat calls pay 10% for
 * them. What must hold:
 *   - the model reads the SAME words — the cached layout only moves the fixed
 *     instructions from the message into the system prompt;
 *   - the switch (aiConfig.promptCaching), a non-Anthropic provider, or a prompt
 *     too short to cache all fall back to the original single-message layout,
 *     byte for byte;
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

const sent = () => create.mock.calls[0][0];
const squash = (s) => s.replace(/\s+/g, ' ').trim();

describe('label scan', () => {
  test('cached layout: instructions as a 1-hour cached system block, the photo plus a one-line request as the message', async () => {
    await scanLabelFull('AAAA', 'image/jpeg');
    const params = sent();
    expect(params.system).toEqual([
      { type: 'text', text: DEFAULT_LABEL_SCAN_PROMPT, cache_control: { type: 'ephemeral', ttl: '1h' } },
    ]);
    expect(params.messages).toEqual([{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } },
        { type: 'text', text: 'Identify the wine in this photo, following your instructions exactly.' },
      ],
    }]);
    expect(params.model).toBe('claude-sonnet-5');
    expect(params.max_tokens).toBe(600);
  });

  test('switch off: the original layout, the instructions after the photo in the message', async () => {
    config({ promptCaching: false });
    await scanLabelFull('AAAA', 'image/jpeg');
    const params = sent();
    expect(params).not.toHaveProperty('system');
    expect(params.messages[0].content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } },
      { type: 'text', text: DEFAULT_LABEL_SCAN_PROMPT },
    ]);
  });

  test('an OpenAI-compatible provider keeps the original layout', async () => {
    aiProvider.providerName.mockReturnValue('openai');
    await scanLabelFull('AAAA', 'image/jpeg');
    expect(sent()).not.toHaveProperty('system');
    expect(sent().messages[0].content[1].text).toBe(DEFAULT_LABEL_SCAN_PROMPT);
  });

  test('a custom prompt too short to cache keeps the original layout', async () => {
    config({ labelScanPrompt: 'Read the label. Return JSON.' });
    await scanLabelFull('AAAA', 'image/jpeg');
    expect(sent()).not.toHaveProperty('system');
    expect(sent().messages[0].content[1].text).toBe('Read the label. Return JSON.');
  });

  test('the scan is labelled for the spend ledger', async () => {
    await scanLabelFull('AAAA', 'image/jpeg');
    expect(aiProvider.getChatClient).toHaveBeenCalledWith({ maxRetries: 4, feature: 'label_scan' });
  });
});

describe('import lookup', () => {
  const row = { name: 'Pingus', producer: 'Dominio de Pingus', vintage: '2015', country: 'Spain' };

  test('cached layout: the rules after the last placeholder line are the cached system block, the row is the message', async () => {
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

  test('the row is closed by the reminder that keeps "only what you know" last', async () => {
    await identifyWineFromText(row);
    const message = sent().messages[0].content;
    const lastParagraph = message.slice(message.lastIndexOf('\n\n') + 2);
    expect(lastParagraph).toMatch(/^Return the JSON object exactly as your instructions specify\./);
    expect(lastParagraph).toContain('only where you actually know them for THIS wine');
  });

  test('the model reads the same words: system + message (less the reminder) reproduce the single-message prompt', async () => {
    await identifyWineFromText(row);
    const cached = sent();
    config({ promptCaching: false });
    create.mockClear();
    await identifyWineFromText(row);
    const original = sent();

    expect(original).not.toHaveProperty('system');
    expect(original.messages[0].content).not.toContain('only where you actually know them for THIS wine');
    const message = cached.messages[0].content;
    const withoutReminder = message.slice(0, message.lastIndexOf('\n\n'));
    expect(squash(`${withoutReminder}\n${cached.system[0].text}`)).toBe(squash(original.messages[0].content));
  });

  test('a template whose values sit at the very end has no fixed tail and keeps the original layout', async () => {
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
