/**
 * aiConfig.load() — stored copies of RETIRED default prompts.
 *
 * WHY THIS TEST EXISTS:
 * SuperAdmin → AI persists the whole settings object on every save, so a
 * prompt nobody edited sits in SiteConfig as a copy of that day's default,
 * and a later change to the default in code never reaches a running instance
 * (found 2026-10-26: all four stored prompts on the hosted instance were
 * byte-identical to the defaults). A stored prompt whose hash is in
 * RETIRED_DEFAULT_PROMPT_HASHES loads as the CURRENT default and is unset in
 * the document; a prompt an admin actually reworded is kept.
 */

jest.mock('../models/SiteConfig', () => ({ findOne: jest.fn(), updateOne: jest.fn() }));

const SiteConfig = require('../models/SiteConfig');
const aiConfig = require('./aiConfig');
const { RETIRED_DEFAULT_PROMPT_HASHES, promptHash } = aiConfig;

const OLD = 'Examine this label. classification: the printed classification/tier line.';

beforeAll(() => { RETIRED_DEFAULT_PROMPT_HASHES.add(promptHash(OLD)); });
afterAll(() => { RETIRED_DEFAULT_PROMPT_HASHES.delete(promptHash(OLD)); aiConfig.set({}); });
beforeEach(() => { jest.clearAllMocks(); aiConfig.set({}); });

const stored = (value) => SiteConfig.findOne.mockResolvedValue({ key: 'aiConfig', value });

test('a stored copy of a retired default loads as the current default and leaves the document', async () => {
  stored({ labelScanPrompt: OLD, chatDailyLimit: 7 });
  await aiConfig.load();
  expect(aiConfig.getRaw().labelScanPrompt).toBe(aiConfig.DEFAULT_LABEL_SCAN_PROMPT);
  expect(aiConfig.getRaw().chatDailyLimit).toBe(7);
  expect(SiteConfig.updateOne).toHaveBeenCalledWith(
    { key: 'aiConfig' },
    { $unset: { 'value.labelScanPrompt': '' } }
  );
});

test('a prompt an admin reworded is kept and nothing is unset', async () => {
  stored({ labelScanPrompt: OLD + ' Also read the back label.' });
  await aiConfig.load();
  expect(aiConfig.getRaw().labelScanPrompt).toBe(OLD + ' Also read the back label.');
  expect(SiteConfig.updateOne).not.toHaveBeenCalled();
});

test('the current defaults are not themselves retired', () => {
  for (const key of ['labelScanPrompt', 'labelScanBackPrompt', 'importLookupPrompt', 'priceSuggestPrompt']) {
    expect(RETIRED_DEFAULT_PROMPT_HASHES.has(promptHash(aiConfig.defaults[key]))).toBe(false);
  }
});

test('the four prompts retired on 2026-10-26 are registered by hash', () => {
  // The sha256 of each default as shipped before #1701 — verified against the
  // hosted instance's stored copies on 2026-10-26. A mistyped hash here would
  // leave an instance on the old prompt with no log line, so they are pinned.
  for (const hash of [
    '0d4e8f1dae96b47b11040126a4124c310f05347b1644e2ea6d89f7f56019d9a7', // labelScanPrompt
    'ae00642894ef46438e048b550fabe78c8da2db679e77febe1ec43d5d5c27d967', // labelScanBackPrompt
    '5525d7d365ec912e6f26c7a6d3a4df3d74091bbc0e5791fcab85a658ddc41b1d', // importLookupPrompt
    'c5fff9ff7fea82cc635cb60874a0f5d4cf33eaabcd071f62e3245f52206dd2a6', // priceSuggestPrompt
  ]) expect(RETIRED_DEFAULT_PROMPT_HASHES.has(hash)).toBe(true);
});

test('a prompt equal to the shipped default is left out of what is persisted', () => {
  const stored = aiConfig.stripDefaultPrompts({ ...aiConfig.defaults, labelScanPrompt: 'Read the label.', chatDailyLimit: 7 });
  expect(stored.labelScanPrompt).toBe('Read the label.');
  expect(stored.chatDailyLimit).toBe(7);
  for (const k of ['labelScanBackPrompt', 'importLookupPrompt', 'priceSuggestPrompt', 'chatSystemPrompt', 'enrichmentPrompt']) {
    expect(stored).not.toHaveProperty(k);
  }
});
