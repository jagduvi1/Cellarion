/**
 * aiConfig provider resolution (issue #698).
 *
 * get() must return the models that ACTUALLY serve requests: the stored
 * Claude/Voyage names by default, the env-configured models when
 * AI_PROVIDER=openai / EMBEDDING_PROVIDER=openai. getRaw() must always return
 * the stored values — admin routes display and persist through it, and a
 * resolved value written back to SiteConfig would corrupt the stored config.
 */

const aiConfig = require('./aiConfig');

const ENV_KEYS = [
  'AI_PROVIDER', 'AI_MODEL', 'AI_VISION_MODEL',
  'EMBEDDING_PROVIDER', 'EMBEDDING_BASE_URL', 'EMBEDDING_MODEL', 'EMBEDDING_DIMENSION',
];
const saved = {};

beforeEach(() => {
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  aiConfig.set({}); // reset cache to defaults
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  aiConfig.set({});
});

test('default providers: get() returns the raw cache untouched (same object, Claude/Voyage names)', () => {
  const cfg = aiConfig.get();
  expect(cfg).toBe(aiConfig.getRaw()); // fast path — no copy
  expect(cfg.chatModel).toBe(aiConfig.defaults.chatModel);
  expect(cfg.embeddingModel).toBe('voyage-4-large');
});

test('AI_PROVIDER=openai: every LLM model field resolves to AI_MODEL (vision to AI_VISION_MODEL)', () => {
  process.env.AI_PROVIDER = 'openai';
  process.env.AI_MODEL = 'llama3.1';
  process.env.AI_VISION_MODEL = 'qwen2.5-vl';

  const cfg = aiConfig.get();
  expect(cfg.chatModel).toBe('llama3.1');
  expect(cfg.importLookupModel).toBe('llama3.1');
  expect(cfg.maturitySuggestModel).toBe('llama3.1');
  expect(cfg.priceSuggestModel).toBe('llama3.1');
  expect(cfg.enrichmentModel).toBe('llama3.1');
  expect(cfg.labelScanModel).toBe('qwen2.5-vl');
  // Fallback resolves to the primary — disables the same-model "fallback" retry
  expect(cfg.chatModelFallback).toBe(cfg.chatModel);
  // Embeddings unaffected — providers switch independently
  expect(cfg.embeddingModel).toBe('voyage-4-large');
  // Non-model fields pass through
  expect(cfg.chatSystemPrompt).toBe(aiConfig.defaults.chatSystemPrompt);

  // getRaw() still shows the stored Claude names (admin display/persist path)
  expect(aiConfig.getRaw().chatModel).toBe(aiConfig.defaults.chatModel);
  expect(aiConfig.getRaw().labelScanModel).toBe(aiConfig.defaults.labelScanModel);
});

test('EMBEDDING_PROVIDER=openai: embeddingModel resolves to EMBEDDING_MODEL, LLM fields untouched', () => {
  process.env.EMBEDDING_PROVIDER = 'openai';
  process.env.EMBEDDING_MODEL = 'nomic-embed-text';

  const cfg = aiConfig.get();
  expect(cfg.embeddingModel).toBe('nomic-embed-text');
  expect(cfg.chatModel).toBe(aiConfig.defaults.chatModel);
  expect(aiConfig.getRaw().embeddingModel).toBe('voyage-4-large');
});
