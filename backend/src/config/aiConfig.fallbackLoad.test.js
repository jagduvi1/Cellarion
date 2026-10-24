/**
 * aiConfig.load() — the Cellar Chat fallback model read back from SiteConfig.
 *
 * WHY THIS TEST EXISTS:
 * SuperAdmin → AI offers "None — no fallback", which stores
 * chatModelFallback: null. load() runs on every boot, so it must keep that
 * null: reading it as the default model would make chat retry overloads on a
 * model the admin turned off, and the panel would show a fallback nobody
 * chose. An absent key or an unknown model name still loads as the default.
 */

jest.mock('../models/SiteConfig', () => ({ findOne: jest.fn(), updateOne: jest.fn() }));

const SiteConfig = require('../models/SiteConfig');
const aiConfig = require('./aiConfig');

const stored = (value) => SiteConfig.findOne.mockResolvedValue({ key: 'aiConfig', value });

beforeEach(() => {
  jest.clearAllMocks();
  aiConfig.set({});
});

afterAll(() => {
  aiConfig.set({});
});

test('a stored null ("no fallback") loads as null', async () => {
  stored({ chatModel: 'claude-sonnet-5-5', chatModelFallback: null });
  await aiConfig.load();
  expect(aiConfig.getRaw().chatModel).toBe('claude-sonnet-5-5');
  expect(aiConfig.getRaw().chatModelFallback).toBeNull();
});

test('"no fallback" saved by the admin route survives the next load', async () => {
  const saved = { ...aiConfig.getRaw(), chatModel: 'claude-sonnet-5-5', chatModelFallback: null };
  aiConfig.set(saved);
  expect(aiConfig.getRaw().chatModelFallback).toBeNull();

  stored(saved);
  await aiConfig.load();
  expect(aiConfig.getRaw().chatModelFallback).toBeNull();
});

test('a stored valid model loads as that model', async () => {
  stored({ chatModel: 'claude-sonnet-5-5', chatModelFallback: 'claude-opus-4-8' });
  await aiConfig.load();
  expect(aiConfig.getRaw().chatModelFallback).toBe('claude-opus-4-8');
});

test('a stored unknown model name falls back to the default', async () => {
  stored({ chatModel: 'claude-sonnet-5-5', chatModelFallback: 'gpt-9' });
  await aiConfig.load();
  expect(aiConfig.getRaw().chatModelFallback).toBe(aiConfig.defaults.chatModelFallback);
});

test('no stored fallback key loads the default', async () => {
  stored({ chatModel: 'claude-sonnet-5-5' });
  await aiConfig.load();
  expect(aiConfig.getRaw().chatModelFallback).toBe(aiConfig.defaults.chatModelFallback);
});
