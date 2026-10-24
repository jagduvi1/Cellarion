/**
 * Every AI prompt a super admin can edit in SuperAdmin → AI is saved through a
 * route that refuses a prompt longer than its cap (PROMPT_MAX_LENGTHS). The
 * shipped default must fit that cap with room to spare, or the admin cannot
 * save the default back without cutting it first. These pin that, so a default
 * that grows past its cap fails here instead of on the admin's Save.
 */
const { PROMPT_MAX_LENGTHS } = require('./constants');
const aiConfig = require('./aiConfig');

// Room an admin has to add to a default before the save is refused.
const HEADROOM = 500;

const editablePromptKeys = Object.keys(aiConfig.defaults)
  .filter((key) => /Prompt(Nv)?$/.test(key) && typeof aiConfig.defaults[key] === 'string');

test('the editable prompts are the ones in aiConfig defaults', () => {
  expect(editablePromptKeys).toEqual(expect.arrayContaining(['chatSystemPrompt', 'enrichmentPrompt', 'labelScanPrompt']));
});

test.each(editablePromptKeys)('%s has a cap its default fits with headroom', (key) => {
  const cap = PROMPT_MAX_LENGTHS[key];
  expect(Number.isInteger(cap)).toBe(true);
  expect(aiConfig.defaults[key].length).toBeLessThanOrEqual(cap - HEADROOM);
});

test('every cap belongs to an editable prompt', () => {
  expect(Object.keys(PROMPT_MAX_LENGTHS).sort()).toEqual([...editablePromptKeys].sort());
});
