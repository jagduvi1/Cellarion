/**
 * MCP prompts — the third primitive's invariants.
 *
 * Pins: registry validation (duplicates, scope required), structural scope
 * gating (a write-workflow prompt is invisible to a read-only token), handler
 * purity (static templates — no model/DB access), argument interpolation, and
 * the per-request call budget on prompts/get.
 */

const {
  registerPrompt, promptsForScopes, allPrompts,
} = require('./registry');
const { budgetedPromptHandler, MAX_CALLS_PER_REQUEST } = require('./server');
require('./prompts');

const prompt = (name) => allPrompts().find((p) => p.name === name);
const textOf = (result) => result.messages.map((m) => m.content.text).join('\n');

describe('registry: registerPrompt validation', () => {
  test('rejects missing name/handler/scope and duplicate names', () => {
    expect(() => registerPrompt({ name: 'x' })).toThrow(/name and handler/);
    expect(() => registerPrompt({ handler: () => {} })).toThrow(/name and handler/);
    expect(() => registerPrompt({ name: 'x', handler: () => {} })).toThrow(/scope is required/);
    expect(() => registerPrompt({ name: 'sommelier_pairing', scope: 'read', handler: () => {} }))
      .toThrow(/duplicate prompt name/);
  });
});

describe('the five Phase-3 prompts', () => {
  test('all registered with titles, descriptions and scopes', () => {
    for (const name of ['sommelier_pairing', 'plan_tonight', 'cellar_health_check', 'plan_rack_layout', 'year_in_wine']) {
      const p = prompt(name);
      expect(p).toBeDefined();
      expect(p.title).toBeTruthy();
      expect(p.description).toBeTruthy();
    }
  });

  test('scope gate is structural: plan_rack_layout (write) is invisible to a read token', () => {
    const readNames = promptsForScopes(['read']).map((p) => p.name);
    expect(readNames).toContain('sommelier_pairing');
    expect(readNames).toContain('year_in_wine');
    expect(readNames).not.toContain('plan_rack_layout');

    const writeNames = promptsForScopes(['read', 'write']).map((p) => p.name);
    expect(writeNames).toContain('plan_rack_layout');
  });

  test('handlers are pure templates returning MCP prompt messages', () => {
    for (const p of allPrompts()) {
      const result = p.handler({ dish: 'duck', year: '2025', rack: 'A', occasion: 'x', preferences: 'y' });
      expect(Array.isArray(result.messages)).toBe(true);
      expect(result.messages[0].role).toBe('user');
      expect(typeof result.messages[0].content.text).toBe('string');
      expect(result.messages[0].content.type).toBe('text');
    }
  });

  test('arguments are interpolated into the workflow text', () => {
    const pairing = textOf(prompt('sommelier_pairing').handler({ dish: 'braised lamb shanks', preferences: 'no oaky whites' }));
    expect(pairing).toContain('braised lamb shanks');
    expect(pairing).toContain('no oaky whites');
    expect(pairing).toContain('pair_with_dish'); // names the tool to drive

    const year = textOf(prompt('year_in_wine').handler({ year: '2024' }));
    expect(year).toContain('2024');
    expect(year).toContain('list_history');

    // Defaults: no year → current year is used, never a placeholder.
    const thisYear = String(new Date().getFullYear());
    expect(textOf(prompt('year_in_wine').handler({}))).toContain(thisYear);
  });

  test('write-safety phrasing: mutating workflows demand preview + explicit approval', () => {
    const rack = textOf(prompt('plan_rack_layout').handler({}));
    expect(rack).toMatch(/preview/i);
    expect(rack).toMatch(/approve|approval/i);
    const tonight = textOf(prompt('plan_tonight').handler({}));
    expect(tonight).toMatch(/confirm|explicit yes/i);
  });
});

describe('per-request budget on prompts', () => {
  test('a prompts/get beyond the shared call budget throws (JSON-RPC error path)', () => {
    const p = prompt('cellar_health_check');
    const state = { calls: MAX_CALLS_PER_REQUEST }; // budget already exhausted
    const wrapped = budgetedPromptHandler(p, { user: { id: 'u' } }, state);
    expect(() => wrapped({})).toThrow(/rate_limited/);
  });

  test('within budget the wrapped handler passes through and counts the call', () => {
    const p = prompt('cellar_health_check');
    const state = { calls: 0 };
    const wrapped = budgetedPromptHandler(p, { user: { id: 'u' } }, state);
    const result = wrapped({});
    expect(result.messages).toBeDefined();
    expect(state.calls).toBe(1);
  });
});
