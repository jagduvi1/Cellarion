/**
 * aiConfig.load() — the language for the AI-written wine texts read back from
 * SiteConfig (utils/profileLanguage).
 *
 * WHY THIS TEST EXISTS:
 * load() runs on every boot. Only a language the app ships may come back on:
 * the code is what the profile prompt names (by its English name), so text
 * written into the document by hand must load as off, never reach a prompt.
 * Off is no key at all, which is also what an instance that never touched the
 * setting holds.
 */

jest.mock('../models/SiteConfig', () => ({ findOne: jest.fn(), updateOne: jest.fn() }));

const SiteConfig = require('../models/SiteConfig');
const aiConfig = require('./aiConfig');

const stored = (value) => SiteConfig.findOne.mockResolvedValue({ key: 'aiConfig', value });

beforeEach(() => {
  jest.clearAllMocks();
  aiConfig.set({});
});
afterAll(() => aiConfig.set({}));

test('a stored shipped code loads as that code, case and spaces aside', async () => {
  stored({ aiTextLanguage: ' DE ' });
  await aiConfig.load();
  expect(aiConfig.getRaw().aiTextLanguage).toBe('de');
  expect(aiConfig.get().aiTextLanguage).toBe('de');
});

test.each([
  ['no key', {}],
  ['empty', { aiTextLanguage: '' }],
  ['English', { aiTextLanguage: 'en' }],
  ['an unknown code', { aiTextLanguage: 'xx' }],
  ['free text', { aiTextLanguage: 'Return all information in German' }],
  ['not a string', { aiTextLanguage: ['de'] }],
])('%s loads as off: no key', async (_, value) => {
  stored({ chatModel: 'claude-sonnet-5-5', ...value });
  await aiConfig.load();
  expect(aiConfig.getRaw()).not.toHaveProperty('aiTextLanguage');
  expect(aiConfig.getRaw().chatModel).toBe('claude-sonnet-5-5');
});
